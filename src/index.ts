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
 * Construye la salida del modo ASISTIDO de generateE2ETests: instrucciones +
 * prompts por RF para que el agente del cliente genere, escriba y ejecute los
 * specs cuando no hay sampling disponible.
 */
function formatE2EFallback(fallback: E2EFallbackResult): string {
  const generated = fallback.totalCount - fallback.pendingCount;

  if (fallback.allGenerated) {
    return [
      "✅ MODO ASISTIDO: todos los specs del ámbito ya están escritos en disco.",
      `RF con spec: ${fallback.totalCount}/${fallback.totalCount}.`,
      "",
      "Siguiente paso: llama a la tool `runE2ETests` para EJECUTAR Cypress y obtener el feedback.",
      "Para cada RF que falle, `runE2ETests` te devuelve la salida real + un PROMPT DE CORRECCIÓN; aplícalo reescribiendo el fichero y vuelve a llamar a `runE2ETests` hasta que todos pasen.",
      `Directorio de trabajo: ${fallback.frontendRoot}`,
      "(Si quieres regenerar algún RF desde cero, borra su .cy.ts y vuelve a llamar a generateE2ETests.)",
    ].join("\n");
  }

  const spec = fallback.specs[0];
  return [
    "⚠️ MODO ASISTIDO: este cliente MCP no soporta 'sampling/createMessage'. El servidor NO genera el spec; te da el prompt para que lo generes tú (el agente).",
    "El entorno Cypress YA está preparado (helpers, config y baseline escritos).",
    "",
    `Progreso: ${generated}/${fallback.totalCount} RF con spec. Este mensaje contiene el SIGUIENTE RF pendiente (se emite de UNO EN UNO para no desbordar el contexto).`,
    "",
    "QUÉ HACER AHORA:",
    "1) Genera el contenido del `.cy.ts` siguiendo EXACTAMENTE el PROMPT de abajo.",
    "2) Escríbelo en la RUTA DE SALIDA exacta (no cambies el nombre).",
    `3) Vuelve a llamar a \`generateE2ETests\` para recibir el siguiente RF pendiente (quedan ${fallback.pendingCount}). Repite hasta que no queden pendientes.`,
    "4) Cuando todos los specs estén escritos, llama a `runE2ETests` para ejecutarlos e iterar con el feedback real de Cypress hasta que pasen.",
    "",
    `===== ${spec.rf} — ${spec.name} =====`,
    `Ruta de salida (escribe aquí el .cy.ts): ${spec.filePath}`,
    `Spec relativo (para --spec): ${spec.specRelPath}`,
    `Directorio de trabajo para Cypress: ${fallback.frontendRoot}`,
    "--- PROMPT DE GENERACIÓN ---",
    spec.prompt,
    "--- FIN PROMPT ---",
  ].join("\n");
}

/**
 * Construye la salida de `runE2ETests`: reporte de ejecución de Cypress y, para
 * los RF que fallan, la salida real + un prompt de corrección para el agente.
 */
function formatE2ERun(run: E2ERunFallbackResult): string {
  const passed = run.results.filter((r) => r.passed);
  const failed = run.results.filter((r) => !r.passed && !r.missing);
  const missing = run.results.filter((r) => r.missing);

  const lines: string[] = [
    `Ejecución Cypress: ${passed.length}/${run.results.length} RF en verde.`,
    `Directorio de trabajo: ${run.frontendRoot}`,
  ];
  for (const r of run.results) {
    const state = r.missing ? "SIN SPEC (genéralo primero)" : r.passed ? "PASA" : "FALLA";
    lines.push(`- ${r.rf} — ${r.name}: ${state}`);
  }

  if (missing.length > 0) {
    lines.push("");
    lines.push("Faltan specs por generar (usa generateE2ETests para obtener sus prompts):");
    for (const r of missing) {
      lines.push(`- ${r.rf}: escribe el spec en ${r.filePath}`);
    }
  }

  if (failed.length > 0) {
    lines.push("");
    lines.push(
      `RF que FALLAN: ${failed.length}. Se incluye el PROMPT DE CORRECCIÓN de UNO de ellos (de uno en uno para no desbordar el contexto).`
    );
    lines.push(
      "Aplica ese prompt reescribiendo el fichero en su ruta y vuelve a llamar a `runE2ETests`; recibirás el siguiente que falle hasta que todos pasen."
    );
    const withFix = failed.find((r) => r.fixPrompt) ?? failed[0];
    lines.push("");
    lines.push(`===== ${withFix.rf} — ${withFix.name} =====`);
    lines.push(`Ruta del spec (reescribe aquí): ${withFix.filePath}`);
    lines.push("--- SALIDA DE CYPRESS (errores) ---");
    lines.push(withFix.output ?? "(sin salida)");
    lines.push("--- PROMPT DE CORRECCIÓN ---");
    lines.push(withFix.fixPrompt ?? "(no disponible)");
    lines.push("--- FIN PROMPT ---");
  } else if (missing.length === 0) {
    lines.push("");
    lines.push("✅ Todos los RF ejecutados pasan.");
  }

  return lines.join("\n");
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
  "Genera y EJECUTA los tests E2E de Cypress (.cy.ts), iterando y corrigiéndolos hasta que pasen. Herramienta AUTÓNOMA: obtiene los RF/CU de rf-cu.md o los deriva de OpenAPI automáticamente; NO requiere ejecutar antes autoCompleteRfCu ni ninguna otra tool. Es la tool a usar cuando el usuario pide 'generar/ejecutar tests E2E o Cypress'. Si el cliente no soporta MCP sampling, prepara el entorno Cypress y devuelve los prompts + rutas para que el agente genere, escriba y ejecute los specs (modo asistido).",
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
        oneAtATime: true,
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
  "EJECUTA los tests E2E de Cypress ya generados y devuelve el resultado como feedback. Para cada RF que falla, incluye la salida real de Cypress y un PROMPT DE CORRECCIÓN listo para reescribir el spec. Úsala para cerrar el bucle de auto-corrección en clientes SIN sampling (Roo/Cline/opencode): genera los specs con generateE2ETests (modo asistido), luego llama a runE2ETests, aplica los prompts de corrección de los RF que fallan y vuelve a llamar hasta que todos pasen.",
  {
    rfFilter: z.array(z.string()).optional(),
    promptOverride: z.string().optional(),
  },
  async ({ rfFilter, promptOverride }) => {
    const context = await loadContext();
    const run = await runE2EFallback(context, {
      rfFilter,
      promptOverride,
      oneFixAtATime: true,
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
