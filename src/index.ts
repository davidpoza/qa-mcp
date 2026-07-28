import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadContext } from "./config";
import { autoCompleteRfCu } from "./rfcu";
import { generateRestTests } from "./generators/rest";
import { generateE2ETests } from "./generators/e2e";
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

registerToolCompat(
  server,
  "autoCompleteRfCu",
  "Completa RF/CU/pasos en rf-cu.md según formato requerido.",
  {
    requirementsPath: z.string().optional(),
  },
  async ({ requirementsPath }) => {
    const context = await loadContext();
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
  "Genera tests E2E Cypress en la ruta configurada.",
  {
    promptOverride: z.string().optional(),
  },
  async ({ promptOverride }) => {
    const context = await loadContext();
    const result = await generateE2ETests(context, sampleWithClient, promptOverride);
    return asToolResult(`Generados ${result.files.length} specs Cypress en ${context.config.e2eTests}.`);
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
