import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadContext } from "./config";
import { autoCompleteRfCu, buildRfCuPrompt } from "./rfcu";
import { generateRestTests } from "./generators/rest";
import { generateE2ETests, prepareE2EFallback, runE2EFallback, E2EFallbackResult, E2ERunFallbackResult } from "./generators/e2e";
import { exportETPAsExcel } from "./exporters/excel";
import { exportETPAsWord } from "./exporters/word";
import { E2E_CONTRACT_VERSION } from "./e2e-contract";

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

function resolveRfSelection(rf?: string, rfFilter?: string[]): string[] | undefined {
  const single = rf?.trim();
  const multiple = (rfFilter ?? []).map((id) => id.trim()).filter(Boolean);
  if (single && multiple.length > 0) {
    throw new Error("Usa `rf` para un único RF o `rfFilter` para varios, pero no ambos a la vez.");
  }
  if (single) return [single];
  if (multiple.length === 0) return undefined;
  const seen = new Set<string>();
  return multiple.filter((id) => {
    const key = id.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assistedScope(rfFilter?: string[]): {
  label: string;
  restricted: boolean;
  generateCall: string;
  runCall: string;
} {
  if (!rfFilter || rfFilter.length === 0) {
    return {
      label: "todos los RF",
      restricted: false,
      generateCall: "`generateE2ETests`",
      runCall: "`runE2ETests`",
    };
  }
  const args = rfFilter.length === 1
    ? `{ "rf": ${JSON.stringify(rfFilter[0])} }`
    : `{ "rfFilter": ${JSON.stringify(rfFilter)} }`;
  return {
    label: rfFilter.length === 1 ? `el RF ${rfFilter[0]}` : `los RF ${rfFilter.join(", ")}`,
    restricted: true,
    generateCall: `\`generateE2ETests\` con ${args}`,
    runCall: `\`runE2ETests\` con ${args}`,
  };
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
function buildSubtaskSignal(
  mode: "advance" | "continue" | "done",
  rfFilter?: string[]
): string {
  const scope = assistedScope(rfFilter);
  const header =
    "--- SEÑAL DE SUBTASK (clientes con Orchestrator/Boomerang, p. ej. Roo Code) ---";
  const footer = "--- FIN SEÑAL DE SUBTASK ---";
  const modeHint =
    "IMPORTANTE (Roo): el modo Orchestrator NO tiene acceso directo a tools MCP; " +
    "crea el new_task en un modo CON acceso MCP y edición de ficheros. Usa `mode: \"code\"` " +
    "(Code tiene `mcp`+`edit`+`command`). NO uses Ask (no edita) ni delegues la llamada a " +
    "la tool al propio Orchestrator (no ve las tools qa-mcp).";
  const delegatePrompt =
    `\"Continúa el bucle E2E limitado a ${scope.label}: llama a ${scope.generateCall}, ` +
    "escribe el .cy.js (UN solo CU por fichero) en la ruta EXACTA que te indique, llama a " +
    `${scope.runCall} e itera (reescribe + runE2ETests) hasta que ESE CU pase. El CU ` +
    "pendiente y el estado (specs + verde) se resuelven solos desde disco, así que " +
    "empiezas con contexto limpio. Cuando el CU esté en verde, termina con " +
    `attempt_completion. Si la tool responde que todos los CU de ${scope.label} están en verde, NO crees ` +
    "más subtasks e informa de que el ciclo ha terminado.\"";
  if (mode === "done") {
    return [
      header,
      "QUEDA_TRABAJO: no",
      `El ciclo CU-a-CU de ${scope.label} ha terminado (todos en verde). ` +
        (scope.restricted ? "NO saltes a otro RF dentro de este contexto; " : "") +
        "NO crees más subtasks para este ámbito; cierra la tarea con attempt_completion.",
      footer,
    ].join("\n");
  }
  if (mode === "advance") {
    if (scope.restricted) {
      return [
        header,
        "QUEDA_TRABAJO: sí (siguiente CU del mismo ámbito)",
        `El CU en curso YA está en verde, pero aún queda trabajo en ${scope.label}. ` +
          "NO cierres la tarea, NO uses attempt_completion y NO abras otro subtask: " +
          `sigue en ESTA MISMA tarea llamando a ${scope.generateCall}.`,
        footer,
      ].join("\n");
    }
    return [
      header,
      "QUEDA_TRABAJO: sí (siguiente CU)",
      "El CU en curso YA está en verde. En modo Orchestrator: cierra ESTE subtask con attempt_completion y delega el SIGUIENTE CU en un new_task NUEVO (contexto limpio) con este objetivo:",
      delegatePrompt,
      modeHint,
      footer,
    ].join("\n");
  }
  // continue
  return [
    header,
    "QUEDA_TRABAJO: sí (CU en curso, aún no está en verde)",
    `Sigue en ESTA MISMA tarea hasta que el CU en curso pase (generar/ejecutar/corregir). ` +
      (scope.restricted
        ? `Después continúa también en esta tarea con los demás CU de ${scope.label}; sólo termina cuando TODO el ámbito esté verde.`
        : "NO abras un subtask nuevo todavía: se abre uno por CU al avanzar al siguiente."),
    modeHint,
    footer,
  ].join("\n");
}

/**
 * Contrato embebido en las respuestas del modo asistido. Un cliente sin
 * sampling usa su propio LLM para escribir/corregir los specs; por eso la tool
 * debe ordenarle explícitamente que encadene todos los pasos sin devolver el
 * control al usuario después de cada CU.
 */
function buildAssistedAutoContinueMandate(rfFilter?: string[]): string {
  const scope = assistedScope(rfFilter);
  return [
    "--- MANDATO INTEGRADO DE AUTOCONTINUACIÓN ---",
    "Esta respuesta es un paso intermedio, NO el final de la tarea.",
    `ÁMBITO INMUTABLE: ${scope.label}. No generes ni ejecutes CU de ningún RF fuera de este ámbito.`,
    `TÚ, el agente cliente, DEBES ejecutar ahora las instrucciones devueltas, escribir/corregir el spec y encadenar ${scope.runCall} y ${scope.generateCall} cuantas veces haga falta.`,
    "NO pidas confirmación al usuario entre CU, NO te detengas al dejar un único CU en verde y NO cierres la tarea mientras quede trabajo.",
    `Continúa autónomamente hasta que una respuesta indique expresamente que todos los CU de ${scope.label} están en verde. Si dispones de Orchestrator/subtasks, sigue además la SEÑAL DE SUBTASK incluida al final.`,
    "--- FIN MANDATO INTEGRADO ---",
  ].join("\n");
}

/**
 * Construye la salida del modo ASISTIDO de generateE2ETests (bucle RF-a-RF hasta
 * verde). Según `nextAction` indica al agente si debe generar el spec del RF en
 * curso, ejecutarlo con `runE2ETests`, o si ya está todo en verde.
 */
function formatE2EFallback(fallback: E2EFallbackResult, rfFilter?: string[]): string {
  const scope = assistedScope(rfFilter);
  const contractLine = `[qa-mcp] Contrato E2E activo: v${E2E_CONTRACT_VERSION}.`;
  const cleanContextTip =
    "CONTEXTO LIMPIO: el progreso se guarda en disco (specs + estado verde). " +
    "Si el cliente permite crear subtasks, delega AUTOMÁTICAMENTE el siguiente CU con contexto limpio; " +
    "si no, continúa en esta misma tarea. NO pidas al usuario que inicie otra tarea: " +
    "el servidor resuelve automáticamente el siguiente CU pendiente.";

  if (fallback.nextAction === "done") {
    return [
      contractLine,
      "✅ MODO ASISTIDO: TODOS los CU del ámbito están en VERDE.",
      `CU en verde: ${fallback.greenCount}/${fallback.totalCount}.`,
      `Ámbito solicitado: ${scope.label}.`,
      "No queda nada por generar ni ejecutar. (Para revalidar un CU, borra su entrada del estado o su .cy.js.)",
      `Directorio de trabajo: ${fallback.frontendRoot}`,
      "",
      buildSubtaskSignal("done", rfFilter),
      "SIGUIENTE_ACCIÓN_OBLIGATORIA: ninguna. Este ámbito ha terminado.",
    ].join("\n");
  }

  if (fallback.nextAction === "run") {
    const c = fallback.current;
    return [
      contractLine,
      `⚠️ MODO ASISTIDO (bucle CU-a-CU): el spec de ${c?.rf} — ${c?.name} YA existe pero aún no está en verde.`,
      `Progreso: ${fallback.greenCount}/${fallback.totalCount} CU en verde.`,
      `Ámbito solicitado: ${scope.label}.`,
      "",
      buildAssistedAutoContinueMandate(rfFilter),
      "",
      "QUÉ HACER AHORA:",
      `1) NO regeneres el spec. Llama a ${scope.runCall} para EJECUTARLO y obtener el feedback real de Cypress.`,
      `2) Si falla, \`runE2ETests\` te da el prompt de corrección; reescribe el spec y vuelve a llamar a ${scope.runCall} hasta que ese CU pase.`,
      `3) Cuando pase, se marca en verde y podrás pasar al siguiente CU del mismo ámbito con ${scope.generateCall}.`,
      `Ruta del spec: ${c?.filePath}`,
      `Directorio de trabajo para Cypress: ${fallback.frontendRoot}`,
      "",
      cleanContextTip,
      "",
      buildSubtaskSignal("continue", rfFilter),
      `SIGUIENTE_ACCIÓN_OBLIGATORIA: llama ahora a ${scope.runCall}. No respondas al usuario ni cierres la tarea.`,
    ].join("\n");
  }

  // nextAction === "generate"
  const spec = fallback.specs[0];
  return [
    contractLine,
    "⚠️ MODO ASISTIDO (bucle CU-a-CU hasta verde): este cliente no soporta 'sampling/createMessage'. El servidor NO genera el spec; te da el prompt para que lo generes tú (el agente).",
    "El entorno Cypress YA está preparado (helpers, config y baseline escritos).",
    "",
    `Progreso: ${fallback.greenCount}/${fallback.totalCount} CU en verde. Este mensaje contiene el CU EN CURSO (uno a uno; cada CU es un fichero .cy.js propio y no se avanza al siguiente hasta que este pase).`,
    `Ámbito solicitado: ${scope.label}.`,
    "",
    buildAssistedAutoContinueMandate(rfFilter),
    "",
    "QUÉ HACER AHORA:",
    "1) Genera el contenido del `.cy.js` (JavaScript PLANO, sin TypeScript) siguiendo EXACTAMENTE el PROMPT de abajo. UN solo CU (un `describe` con un único `it`) por fichero.",
    "2) Escríbelo en la RUTA DE SALIDA exacta (no cambies el nombre).",
    `3) Llama a ${scope.runCall} para EJECUTAR ESTE CU. Itera (reescribe + la misma llamada) hasta que pase; solo entonces avanza al siguiente CU del ámbito con ${scope.generateCall}.`,
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
    buildSubtaskSignal("continue", rfFilter),
    `SIGUIENTE_ACCIÓN_OBLIGATORIA: escribe el spec indicado y llama ahora a ${scope.runCall}. No respondas al usuario ni cierres la tarea.`,
  ].join("\n");
}

/**
 * Construye la salida de `runE2ETests` (bucle RF-a-RF hasta verde): ejecuta el
 * RF en curso y, según `nextAction`, indica al agente si debe corregirlo,
 * generar su spec, avanzar al siguiente RF o si ya está todo en verde.
 */
function formatE2ERun(run: E2ERunFallbackResult, rfFilter?: string[]): string {
  const scope = assistedScope(rfFilter);
  const cleanContextTip =
    `CONTEXTO LIMPIO: el progreso está en disco. Para el siguiente CU, llama a ${scope.generateCall} ` +
    "automáticamente. Si dispones de subtasks, delega uno con contexto limpio; si no, continúa aquí. " +
    "NO pidas intervención al usuario.";
  const diagLine =
    `[qa-mcp] Contrato E2E activo: v${E2E_CONTRACT_VERSION} | Config cargada: ${run.configPath ?? "(desconocida)"} | ` +
    `headed: ${run.headed ? "sí (--headed)" : "no"}` +
    `${run.browser ? ` | browser: ${run.browser}` : ""}`;
  const withDiag = (lines: string[]): string => [diagLine, "", ...lines].join("\n");
  const single = run.results[0];
  const green = run.greenCount ?? 0;
  const total = run.totalCount ?? run.results.length;

  if (run.nextAction === "done") {
    return withDiag([
      "✅ TODOS los CU del ámbito están en VERDE.",
      `CU en verde: ${green}/${total}.`,
      `Ámbito solicitado: ${scope.label}.`,
      `Directorio de trabajo: ${run.frontendRoot}`,
      "",
      buildSubtaskSignal("done", rfFilter),
      "SIGUIENTE_ACCIÓN_OBLIGATORIA: ninguna. Este ámbito ha terminado.",
    ]);
  }

  if (run.nextAction === "generate" || single?.missing) {
    return withDiag([
      `El CU en curso (${single?.rf ?? "?"} — ${single?.name ?? ""}) aún no tiene spec.`,
      `Progreso: ${green}/${total} CU en verde.`,
      `Ámbito solicitado: ${scope.label}.`,
      "",
      buildAssistedAutoContinueMandate(rfFilter),
      "",
      `Llama a ${scope.generateCall} para obtener su prompt de generación, escribe el \`.cy.js\` y vuelve a ${scope.runCall}.`,
      single ? `Ruta esperada del spec: ${single.filePath}` : "",
      "",
      buildSubtaskSignal("continue", rfFilter),
      `SIGUIENTE_ACCIÓN_OBLIGATORIA: llama ahora a ${scope.generateCall}. No respondas al usuario ni cierres la tarea.`,
    ].filter(Boolean));
  }

  if (run.nextAction === "next" || single?.passed) {
    return withDiag([
      `✅ ${single?.rf} — ${single?.name}: PASA. Marcado en verde.`,
      `Progreso: ${green}/${total} CU en verde.`,
      `Ámbito solicitado: ${scope.label}.`,
      "",
      buildAssistedAutoContinueMandate(rfFilter),
      "",
      `Siguiente paso: pasa al siguiente CU del ámbito llamando a ${scope.generateCall}.`,
      cleanContextTip,
      `Directorio de trabajo: ${run.frontendRoot}`,
      "",
      buildSubtaskSignal("advance", rfFilter),
      `SIGUIENTE_ACCIÓN_OBLIGATORIA: llama ahora a ${scope.generateCall}. No respondas al usuario ni cierres la tarea mientras queden CU en el ámbito.`,
    ]);
  }

  // nextAction === "fix"
  if (single?.cacheError) {
    return withDiag([
      `⚠️ ${single?.rf} — ${single?.name}: Cypress NO arrancó por un error de ENTORNO (caché V8), no del spec.`,
      `Progreso: ${green}/${total} CU en verde.`,
      `Ámbito solicitado: ${scope.label}.`,
      "",
      buildAssistedAutoContinueMandate(rfFilter),
      "",
      "NO reescribas el spec: no soluciona nada. Repara la caché de Cypress y reintenta.",
      single?.output ?? "(sin salida)",
      "",
      buildSubtaskSignal("continue", rfFilter),
      `SIGUIENTE_ACCIÓN_OBLIGATORIA: repara el entorno y vuelve a llamar a ${scope.runCall}. No cierres la tarea.`,
    ]);
  }
  return withDiag([
    `❌ ${single?.rf} — ${single?.name}: FALLA.`,
    `Progreso: ${green}/${total} CU en verde. Este CU NO avanza hasta que pase.`,
    `Ámbito solicitado: ${scope.label}.`,
    "",
    buildAssistedAutoContinueMandate(rfFilter),
    "",
    "QUÉ HACER AHORA (BUCLE hasta verde — NO te detengas tras un solo intento):",
    "1) Diagnostica con la salida de Cypress de abajo y aplica el PROMPT DE CORRECCIÓN.",
    "2) Reescribe (SOBRESCRIBE) el spec completo en su ruta (JavaScript PLANO, sin TypeScript). NO toques tsconfig ni errores de tipos.",
    `3) VUELVE A LLAMAR a ${scope.runCall} (mismo CU) para verificar. Repite corrección→ejecución hasta que ESTE CU pase (green). NO cierres la tarea con el CU aún en rojo.`,
    "   · Solo si el contexto se te está llenando: puedes cerrar la tarea y dejar que una tarea/subtask NUEVA reanude ESTE MISMO CU (el spec y el estado están en disco; el servidor reengancha el primer CU no verde). Es un OFFLOAD opcional, no un fin del bucle.",
    "",
    `===== ${single?.rf} — ${single?.name} =====`,
    `Ruta del spec (reescribe aquí): ${single?.filePath}`,
    single?.logPath ? `Log de feedback (raw Cypress + prompt, se sobrescribe cada iteración): ${single.logPath}` : "",
    "--- SALIDA DE CYPRESS (errores) ---",
    single?.output ?? "(sin salida)",
    "--- PROMPT DE CORRECCIÓN ---",
    single?.fixPrompt ?? "(no disponible)",
    "--- FIN PROMPT ---",
    "",
    buildSubtaskSignal("continue", rfFilter),
    `SIGUIENTE_ACCIÓN_OBLIGATORIA: aplica el prompt de corrección al spec y llama inmediatamente a ${scope.runCall}. No respondas al usuario ni cierres la tarea con el CU rojo.`,
  ].filter(Boolean));
}

registerToolCompat(
  server,
  "autoCompleteRfCu",
  "SOLO edita/rellena rf-cu.md. Cada CU debe declarar en `Valores de controles` todos los input/select/checkbox con su tipo, clave de baseline, selector, valor literal y acción NN; en selects se usa el texto visible y en checkbox true/false. No puede indicar `Ninguno` si selecciona un dropdown. Cada interacción ocupa una acción independiente. NO genera tests ni ejecuta Cypress. Si el cliente no soporta sampling, devuelve al agente el prompt completo integrado.",
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
  "Genera y EJECUTA tests Cypress CU a CU hasta verde. Acepta `rf` para limitar el ciclo a un RF. Fija viewport 1920x1080 y escala/DPR 1 (100 %), y rechaza PNG que no midan exactamente 1920x1080. Todos los datos declarados en `Valores de controles` se establecen mediante setDocumentedControl: input, select/dropdown y checkbox se vuelven a localizar, entran en viewport, se valida su valor/estado visible, se resaltan y se capturan en rfx_cuy_NN; además coinciden con e2e-baseline.json. No considera completo un CU sin spec vigente, green:true, contrato actual, llamadas y PNG Full HD. Rechaza rf-cu antiguos, dropdowns no documentados, acciones agrupadas o evidencias genéricas. Sin sampling devuelve instrucciones autónomas integradas. El progreso queda en disco.",
  {
    promptOverride: z.string().optional(),
    runTests: z.boolean().optional(),
    maxIterations: z.number().int().min(1).max(10).optional(),
    rf: z.string().min(1).optional().describe("ID exacto de un único RF, p. ej. RF-3. Limita todo el ciclo a sus CU."),
    rfFilter: z.array(z.string().min(1)).optional().describe("Compatibilidad: lista de uno o varios RF. No combinar con rf."),
    assisted: z.boolean().optional(),
  },
  async ({ promptOverride, runTests, maxIterations, rf, rfFilter, assisted }) => {
    const context = await loadContext();
    const selectedRfFilter = resolveRfSelection(rf, rfFilter);

    if (assisted || !clientSupportsSampling()) {
      const fallback = await prepareE2EFallback(context, {
        promptOverride,
        rfFilter: selectedRfFilter,
        untilGreen: true,
        leanFrontend: true,
      });
      return asToolResult(formatE2EFallback(fallback, selectedRfFilter));
    }

    const result = await generateE2ETests(context, sampleWithClient, {
      promptOverride,
      runTests,
      maxIterations,
      rfFilter: selectedRfFilter,
    });

    const lines: string[] = [
      `[qa-mcp] Contrato E2E activo: v${E2E_CONTRACT_VERSION}.`,
      `Generados o reparados ${result.files.length} specs Cypress en ${context.config.e2eTests}.`,
      `Ámbito procesado: ${assistedScope(selectedRfFilter).label}.`,
      `Estado acumulado: ${result.greenCount}/${result.rfCount} CU en verde.`,
    ];

    if (result.skippedGreenCount > 0) {
      lines.push(
        `Omitidos ${result.skippedGreenCount} CU completos (spec, green: true y una captura PNG por acción).`
      );
    }

    if (runTests === false) {
      lines.push("Ejecución de Cypress omitida (runTests=false).");
    } else {
      const passed = result.iterations.filter((it) => it.passed);
      const failed = result.iterations.filter((it) => !it.passed);
      lines.push(
        `Resultado de esta ejecución: ${passed.length}/${result.iterations.length} CU procesados en verde.`
      );
      for (const it of result.iterations) {
        lines.push(
          `- ${it.rf}: ${it.passed ? "PASA" : "FALLA"} (intentos: ${it.attempts}).`
        );
      }
      if (failed.length > 0) {
        lines.push("");
        lines.push("Detalle de los CU que siguen fallando:");
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
  "EJECUTA en Cypress el CU EN CURSO y devuelve feedback. Acepta `rf` para limitar estrictamente la ejecución a un único requisito funcional; durante un ciclo iniciado con generateE2ETests({rf}) debe repetirse el mismo `rf` en cada llamada. `rfFilter` permite varios RF por compatibilidad. Ejecuta sólo un CU por llamada y persiste el progreso en disco.",
  {
    rf: z.string().min(1).optional().describe("ID exacto del único RF cuyo CU debe ejecutarse, p. ej. RF-3."),
    rfFilter: z.array(z.string().min(1)).optional().describe("Compatibilidad: lista de uno o varios RF. No combinar con rf."),
    promptOverride: z.string().optional(),
  },
  async ({ rf, rfFilter, promptOverride }) => {
    const context = await loadContext();
    const selectedRfFilter = resolveRfSelection(rf, rfFilter);
    const run = await runE2EFallback(context, {
      rfFilter: selectedRfFilter,
      promptOverride,
      untilGreen: true,
      leanFrontend: true,
    });
    return asToolResult(formatE2ERun(run, selectedRfFilter));
  }
);

registerToolCompat(
  server,
  "exportETPAsExcel",
  "Genera un ETP Excel con la misma estructura y estilos de evidence.excelTemplate (evidences.xlsx). Sustituye las filas de ejemplo de la plantilla por una fila para CADA método @Test Rest Assured y cada it()/test() Cypress encontrado, mostrando primero todos los REST y después todos los E2E; dentro de cada bloque ordena por R. Funcional y Nombre/CU. Relaciona los tests con RF/CU y refleja el estado green/log de E2E cuando existe. No se limita a listar ficheros.",
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
  "Genera un ETP Word desde rf-cu.md, con un encabezado por RF, un subencabezado por CU y cada acción seguida de su captura PNG de Cypress. Exige que todos los CU estén en verde y que exista una evidencia por acción; si falta alguna, devuelve un error en vez de crear un documento incompleto.",
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
