import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadContext } from "./config";
import { autoCompleteRfCu, buildRfCuPrompt } from "./rfcu";
import { generateRestTests } from "./generators/rest";
import { generateE2ETests, prepareE2EFallback, runE2EFallback, E2EFallbackResult, E2ERunFallbackResult } from "./generators/e2e";
import { exportETPAsExcel } from "./exporters/excel";
import { exportETPAsWord } from "./exporters/word";

type ToolHandler<T> = (args: T) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function asToolResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function registerToolCompat<T extends z.ZodRawShape>(
  server: unknown,
  name: string,
  description: string,
  shape: T,
  handler: ToolHandler<z.infer<z.ZodObject<T>>>
) {
  const anyServer = server as Record<string, unknown>;
  const schemaObject = z.object(shape);

  if (typeof anyServer.tool === "function") {
    (anyServer.tool as (...args: unknown[]) => unknown)(name, description, shape, handler);
    return;
  }

  if (typeof anyServer.registerTool === "function") {
    (anyServer.registerTool as (...args: unknown[]) => unknown)(
      name,
      { description, inputSchema: schemaObject },
      handler
    );
    return;
  }

  throw new Error("No se encontró un método compatible para registrar tools en MCP SDK.");
}

const server = new McpServer({
  name: "qa-mcp",
  version: "0.1.0",
});

async function sampleWithClient(prompt: string, maxTokens = 8000): Promise<string> {
  try {
    const response = await server.server.createMessage(
      {
        messages: [
          {
            role: "user",
            content: { type: "text", text: prompt },
          },
        ],
        maxTokens,
      },
      {
        timeout: 300000,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: 600000,
      }
    );
    return response.content.type === "text" ? response.content.text : "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `No se pudo solicitar la generación al modelo (MCP sampling). ` +
        `Asegúrate de usar un cliente que soporte 'sampling/createMessage' (p. ej. VS Code Copilot 1.102+). Detalle: ${message}`
    );
  }
}

/**
 * Indica si el cliente MCP conectado declaró soporte de sampling
 * (`sampling/createMessage`). Clientes como Roo Code, Cline u opencode no lo
 * soportan; en ese caso las tools que dependen del modelo usan el modo ASISTIDO.
 */
function clientSupportsSampling(): boolean {
  try {
    const caps = server.server.getClientCapabilities?.();
    return Boolean(caps && (caps as { sampling?: unknown }).sampling);
  } catch {
    return false;
  }
}

/**
 * Señal explícita para clientes con orquestación de subtasks (Boomerang /
 * Orchestrator, p. ej. Roo Code). El bucle RF-a-RF persiste su estado en disco,
 * así que cada RF puede resolverse en un subtask con CONTEXTO LIMPIO. Esta señal
 * le dice al agente orquestador si debe: seguir en el mismo subtask ("continue"),
 * cerrar el actual y delegar el siguiente RF en un new_task ("advance"), o parar
 * porque ya no queda trabajo ("done"). En clientes sin subtasks es solo texto
 * informativo e inocuo.
 */
function buildSubtaskSignal(mode: "advance" | "continue" | "done"): string {
  const header =
    "--- SEÑAL DE SUBTASK (clientes con Orchestrator/Boomerang, p. ej. Roo Code) ---";
  const footer = "--- FIN SEÑAL DE SUBTASK ---";
  const modeHint =
    "IMPORTANTE (Roo): el modo Orchestrator NO tiene acceso directo a tools MCP; " +
    "crea el new_task en un modo CON acceso MCP y edición de ficheros. Usa `mode: \"code\"` " +
    "(Code tiene `mcp`+`edit`+`command`). NO uses Ask (no edita) ni delegues la llamada a " +
    "la tool al propio Orchestrator (no ve las tools qa-mcp).";
  const delegatePrompt =
    "\"Continúa el bucle E2E del siguiente RF pendiente de qa-mcp: llama a la tool " +
    "generateE2ETests, escribe el .cy.js en la ruta EXACTA que te indique, llama a " +
    "runE2ETests e itera (reescribe + runE2ETests) hasta que ESE RF pase. El RF " +
    "pendiente y el estado (specs + verde) se resuelven solos desde disco, así que " +
    "empiezas con contexto limpio. Cuando el RF esté en verde, termina con " +
    "attempt_completion. Si la tool responde que TODOS los RF están en verde, NO crees " +
    "más subtasks e informa de que el ciclo ha terminado.\"";

  if (mode === "done") {
    return [
      header,
      "QUEDA_TRABAJO: no",
      "El ciclo RF-a-RF ha terminado (todos en verde). NO crees más subtasks; cierra la tarea con attempt_completion.",
      footer,
    ].join("\n");
  }
  if (mode === "advance") {
    return [
      header,
      "QUEDA_TRABAJO: sí (siguiente RF)",
      "El RF en curso YA está en verde. En modo Orchestrator: cierra ESTE subtask con attempt_completion y delega el SIGUIENTE RF en un new_task NUEVO (contexto limpio) con este objetivo:",
      delegatePrompt,
      modeHint,
      footer,
    ].join("\n");
  }
  // continue
  return [
    header,
    "QUEDA_TRABAJO: sí (RF en curso, aún no está en verde)",
    "Sigue en ESTE MISMO subtask hasta que el RF en curso pase (generar/ejecutar/corregir). NO abras un subtask nuevo todavía: se abre uno por RF, al avanzar al siguiente.",
    modeHint,
    footer,
  ].join("\n");
}

/**
 * Construye la salida del modo ASISTIDO de generateE2ETests (bucle RF-a-RF hasta
 * verde). Según `nextAction` indica al agente si debe generar el spec del RF en
 * curso, ejecutarlo con `runE2ETests`, o si ya está todo en verde.
 */
function formatE2EFallback(fallback: E2EFallbackResult): string {
  const cleanContextTip =
    "CONTEXTO LIMPIO: el progreso se guarda en disco (specs + estado verde). " +
    "Para evitar que el contexto se llene (p. ej. al llegar a RF-10/RF-11), " +
    "INICIA UNA TAREA NUEVA en el cliente entre RF y vuelve a llamar a esta tool: " +
    "el servidor continúa automáticamente por el siguiente RF pendiente.";

  if (fallback.nextAction === "done") {
    return [
      "✅ MODO ASISTIDO: TODOS los RF del ámbito están en VERDE.",
      `RF en verde: ${fallback.greenCount}/${fallback.totalCount}.`,
      "No queda nada por generar ni ejecutar. (Para revalidar un RF, borra su entrada del estado o su .cy.js.)",
      `Directorio de trabajo: ${fallback.frontendRoot}`,
      "",
      buildSubtaskSignal("done"),
    ].join("\n");
  }

  if (fallback.nextAction === "run") {
    const c = fallback.current;
    return [
      `⚠️ MODO ASISTIDO (bucle RF-a-RF): el spec de ${c?.rf} — ${c?.name} YA existe pero aún no está en verde.`,
      `Progreso: ${fallback.greenCount}/${fallback.totalCount} RF en verde.`,
      "",
      "QUÉ HACER AHORA:",
      "1) NO regeneres el spec. Llama a `runE2ETests` para EJECUTARLO y obtener el feedback real de Cypress.",
      "2) Si falla, `runE2ETests` te da el prompt de corrección; reescribe el spec y vuelve a llamar a `runE2ETests` hasta que ese RF pase.",
      "3) Cuando pase, se marca en verde y podrás pasar al siguiente RF con `generateE2ETests`.",
      `Ruta del spec: ${c?.filePath}`,
      `Directorio de trabajo para Cypress: ${fallback.frontendRoot}`,
      "",
      cleanContextTip,
      "",
      buildSubtaskSignal("continue"),
    ].join("\n");
  }

  // nextAction === "generate"
  const spec = fallback.specs[0];
  return [
    "⚠️ MODO ASISTIDO (bucle RF-a-RF hasta verde): este cliente no soporta 'sampling/createMessage'. El servidor NO genera el spec; te da el prompt para que lo generes tú (el agente).",
    "El entorno Cypress YA está preparado (helpers, config y baseline escritos).",
    "",
    `Progreso: ${fallback.greenCount}/${fallback.totalCount} RF en verde. Este mensaje contiene el RF EN CURSO (uno a uno; no se avanza al siguiente hasta que este pase).`,
    "",
    "QUÉ HACER AHORA:",
    "1) Genera el contenido del `.cy.js` (JavaScript PLANO, sin TypeScript) siguiendo EXACTAMENTE el PROMPT de abajo.",
    "2) Escríbelo en la RUTA DE SALIDA exacta (no cambies el nombre).",
    "3) Llama a `runE2ETests` para EJECUTAR ESTE RF. Itera (reescribe + `runE2ETests`) hasta que pase; solo entonces avanza al siguiente RF con `generateE2ETests`.",
    "IMPORTANTE: NO intentes 'arreglar' errores de tipos de TypeScript ni tocar tsconfig; los specs son `.cy.js` y Cypress NO hace type-check. El ÚNICO criterio de éxito es que Cypress pase (usa `runE2ETests`).",
    "",
    `===== ${spec.rf} — ${spec.name} =====`,
    `Ruta de salida (escribe aquí el .cy.js): ${spec.filePath}`,
    `Spec relativo (para --spec): ${spec.specRelPath}`,
    `Directorio de trabajo para Cypress: ${fallback.frontendRoot}`,
    "--- PROMPT DE GENERACIÓN ---",
    spec.prompt,
    "--- FIN PROMPT ---",
    "",
    cleanContextTip,
    "",
    buildSubtaskSignal("continue"),
  ].join("\n");
}

/**
 * Construye la salida de `runE2ETests` (bucle RF-a-RF hasta verde): ejecuta el
 * RF en curso y, según `nextAction`, indica al agente si debe corregirlo,
 * generar su spec, avanzar al siguiente RF o si ya está todo en verde.
 */
function formatE2ERun(run: E2ERunFallbackResult): string {
  const cleanContextTip =
    "CONTEXTO LIMPIO: el progreso está en disco. Para el siguiente RF, INICIA UNA TAREA NUEVA " +
    "y llama a `generateE2ETests`; el servidor continúa por el RF pendiente.";
  const single = run.results[0];
  const green = run.greenCount ?? 0;
  const total = run.totalCount ?? run.results.length;

  if (run.nextAction === "done") {
    return [
      "✅ TODOS los RF del ámbito están en VERDE.",
      `RF en verde: ${green}/${total}.`,
      `Directorio de trabajo: ${run.frontendRoot}`,
      "",
      buildSubtaskSignal("done"),
    ].join("\n");
  }

  if (run.nextAction === "generate" || single?.missing) {
    return [
      `El RF en curso (${single?.rf ?? "?"} — ${single?.name ?? ""}) aún no tiene spec.`,
      `Progreso: ${green}/${total} RF en verde.`,
      "Llama a `generateE2ETests` para obtener su prompt de generación, escribe el `.cy.js` y vuelve a `runE2ETests`.",
      single ? `Ruta esperada del spec: ${single.filePath}` : "",
      "",
      buildSubtaskSignal("continue"),
    ].filter(Boolean).join("\n");
  }

  if (run.nextAction === "next" || single?.passed) {
    return [
      `✅ ${single?.rf} — ${single?.name}: PASA. Marcado en verde.`,
      `Progreso: ${green}/${total} RF en verde.`,
      "",
      "Siguiente paso: pasa al siguiente RF llamando a `generateE2ETests`.",
      cleanContextTip,
      `Directorio de trabajo: ${run.frontendRoot}`,
      "",
      buildSubtaskSignal("advance"),
    ].join("\n");
  }

  // nextAction === "fix"
  return [
    `❌ ${single?.rf} — ${single?.name}: FALLA.`,
    `Progreso: ${green}/${total} RF en verde. Este RF NO avanza hasta que pase.`,
    "",
    "QUÉ HACER AHORA:",
    "1) Diagnostica con la salida de Cypress de abajo y aplica el PROMPT DE CORRECCIÓN.",
    "2) Reescribe el spec en su ruta (JavaScript PLANO, sin TypeScript).",
    "3) Vuelve a llamar a `runE2ETests` (mismo RF) hasta que pase. NO toques tsconfig ni errores de tipos.",
    "",
    `===== ${single?.rf} — ${single?.name} =====`,
    `Ruta del spec (reescribe aquí): ${single?.filePath}`,
    "--- SALIDA DE CYPRESS (errores) ---",
    single?.output ?? "(sin salida)",
    "--- PROMPT DE CORRECCIÓN ---",
    single?.fixPrompt ?? "(no disponible)",
    "--- FIN PROMPT ---",
    "",
    buildSubtaskSignal("continue"),
  ].join("\n");
}

registerToolCompat(
  server,
  "autoCompleteRfCu",
  "SOLO edita/rellena el fichero rf-cu.md (RF, CU y pasos) cuando está incompleto. NO genera código de tests ni ejecuta Cypress. Úsala únicamente cuando el usuario pida completar/generar el rf-cu.md; NO es un paso previo necesario para generateE2ETests. Si el cliente no soporta MCP sampling, devuelve el prompt para que el agente genere y escriba el rf-cu.md (modo asistido).",
  {
    requirementsPath: z.string().optional(),
    assisted: z.boolean().optional(),
  },
  async ({ requirementsPath, assisted }) => {
    const context = await loadContext();
    if (assisted || !clientSupportsSampling()) {
      const { outputPath, prompt } = await buildRfCuPrompt(context, requirementsPath);
      return asToolResult(
        [
          "⚠️ MODO ASISTIDO: este cliente MCP no soporta 'sampling/createMessage', por lo que autoCompleteRfCu no puede generar el contenido por sí mismo.",
          "Genera TÚ (el agente) el rf-cu.md siguiendo EXACTAMENTE el prompt de abajo y escríbelo en la ruta indicada.",
          "",
          `Ruta de salida (escribe aquí el markdown): ${outputPath}`,
          "",
          "--- PROMPT DE GENERACIÓN ---",
          prompt,
          "--- FIN PROMPT ---",
        ].join("\n")
      );
    }
    const result = await autoCompleteRfCu(context, sampleWithClient, requirementsPath);
    return asToolResult(`rf-cu actualizado en ${result.outputPath} con ${result.count} RF.`);
  }
);

registerToolCompat(
  server,
  "generateRestTests",
  "Genera tests API Rest Assured en la ruta configurada.",
  {},
  async () => {
    const context = await loadContext();
    const result = await generateRestTests(context);
    return asToolResult(`Generados ${result.files.length} archivos Rest Assured en ${context.config.restTests}.`);
  }
);

registerToolCompat(
  server,
  "generateE2ETests",
  "Genera y EJECUTA los tests E2E de Cypress (.cy.js) RF a RF, iterando hasta que cada uno pasa antes de avanzar al siguiente. Herramienta AUTÓNOMA: obtiene los RF/CU de rf-cu.md o los deriva de OpenAPI automáticamente; NO requiere ejecutar antes autoCompleteRfCu ni ninguna otra tool. Es la tool a usar cuando el usuario pide 'generar/ejecutar tests E2E o Cypress'. Sin MCP sampling (modo asistido): trabaja UN RF en curso por llamada (el primero no verde); devuelve el prompt de generación de ese RF y luego se ejecuta con runE2ETests hasta que pase. El progreso (verde/pendiente) se guarda EN DISCO, así que es reanudable desde una tarea nueva con contexto limpio.",
  {
    promptOverride: z.string().optional(),
    runTests: z.boolean().optional(),
    maxIterations: z.number().int().min(1).max(10).optional(),
    rfFilter: z.array(z.string()).optional(),
    assisted: z.boolean().optional(),
  },
  async ({ promptOverride, runTests, maxIterations, rfFilter, assisted }) => {
    const context = await loadContext();

    if (assisted || !clientSupportsSampling()) {
      const fallback = await prepareE2EFallback(context, {
        promptOverride,
        rfFilter,
        untilGreen: true,
        leanFrontend: true,
      });
      return asToolResult(formatE2EFallback(fallback));
    }

    const result = await generateE2ETests(context, sampleWithClient, {
      promptOverride,
      runTests,
      maxIterations,
      rfFilter,
    });

    const lines: string[] = [
      `Generados ${result.files.length} specs Cypress en ${context.config.e2eTests}.`,
    ];

    if (runTests === false) {
      lines.push("Ejecución de Cypress omitida (runTests=false).");
    } else {
      const passed = result.iterations.filter((it) => it.passed);
      const failed = result.iterations.filter((it) => !it.passed);
      lines.push(
        `Resultado tras iterar: ${passed.length}/${result.iterations.length} RF en verde.`
      );
      for (const it of result.iterations) {
        lines.push(
          `- ${it.rf}: ${it.passed ? "PASA" : "FALLA"} (intentos: ${it.attempts}).`
        );
      }
      if (failed.length > 0) {
        lines.push("");
        lines.push("Detalle de los RF que siguen fallando:");
        for (const it of failed) {
          lines.push(`### ${it.rf} (${it.file})`);
          lines.push("```");
          lines.push(it.lastOutput ?? "(sin salida)");
          lines.push("```");
        }
      }
    }

    return asToolResult(lines.join("\n"));
  }
);

registerToolCompat(
  server,
  "runE2ETests",
  "EJECUTA en Cypress el RF EN CURSO (el primero no verde, o el indicado en rfFilter) y devuelve el resultado como feedback. Si pasa, lo marca en verde (en disco) y te indica avanzar al siguiente RF con generateE2ETests; si falla, incluye la salida real de Cypress + un PROMPT DE CORRECCIÓN para reescribir el spec y volver a llamar hasta que pase. Cierra el bucle RF-a-RF-hasta-verde en clientes SIN sampling (Roo/Cline/opencode). Ejecuta solo un RF por llamada para no desbordar el contexto; el progreso persiste en disco (reanudable desde una tarea nueva).",
  {
    rfFilter: z.array(z.string()).optional(),
    promptOverride: z.string().optional(),
  },
  async ({ rfFilter, promptOverride }) => {
    const context = await loadContext();
    const run = await runE2EFallback(context, {
      rfFilter,
      promptOverride,
      untilGreen: true,
      leanFrontend: true,
    });
    return asToolResult(formatE2ERun(run));
  }
);

registerToolCompat(
  server,
  "exportETPAsExcel",
  "Exporta el ETP a Excel usando exceljs y plantilla configurada.",
  {
    outputFileName: z.string().optional(),
  },
  async ({ outputFileName }) => {
    const context = await loadContext();
    const output = await exportETPAsExcel(context, outputFileName);
    return asToolResult(`ETP Excel exportado en ${output}.`);
  }
);

registerToolCompat(
  server,
  "exportETPAsWord",
  "Exporta el ETP a Word usando docx.",
  {
    outputFileName: z.string().optional(),
  },
  async ({ outputFileName }) => {
    const context = await loadContext();
    const output = await exportETPAsWord(context, outputFileName);
    return asToolResult(`ETP Word exportado en ${output}.`);
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[qa-mcp] error: ${message}\n`);
  process.exit(1);
});
