import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { LoadedContext, McpQaConfig } from "./types";

const configSchema = z.object({
  version: z.number().int().positive(),
  backend: z.object({
    root: z.string().min(1),
    language: z.string().min(1),
    build: z.string().min(1),
  }),
  frontend: z.object({
    root: z.string().min(1).optional(),
    framework: z.string().min(1),
    e2e: z.string().min(1),
  }),
  e2eBaseUrl: z.string().min(1).optional(),
  e2eRunCommand: z.string().min(1).optional(),
  e2eNodePath: z.string().min(1).optional(),
  e2eEnv: z.record(z.string()).optional(),
  openApi: z.string().min(1),
  appRouting: z.string().min(1).optional(),
  requirements: z.string().min(1).optional(),
  restTests: z.string().min(1),
  e2eTests: z.string().min(1),
  evidence: z.object({
    excelTemplate: z.string().min(1),
    wordTemplate: z.string().min(1).optional(),
    output: z.string().min(1),
  }),
  prompts: z.object({
    e2e: z.string().min(1).optional(),
    rfcu: z.string().min(1).optional(),
  }).optional(),
});

function absoluteFrom(configDir: string, maybeRelative: string): string {
  if (path.isAbsolute(maybeRelative)) {
    return maybeRelative;
  }
  return path.resolve(configDir, maybeRelative);
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function loadContext(configPathInput?: string): Promise<LoadedContext> {
  const configPath = configPathInput
    ? path.resolve(process.cwd(), configPathInput)
    : path.resolve(process.cwd(), "mcp.config.json");

  let rawConfig: string;
  try {
    rawConfig = await fs.readFile(configPath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new Error(
        `No se encontró mcp.config.json en ${configPath}. ` +
          "Revisa el cwd configurado para el servidor MCP en VS Code."
      );
    }
    throw error;
  }
  const parsed = JSON.parse(rawConfig);
  const config = configSchema.parse(parsed) as McpQaConfig;
  const configDir = path.dirname(configPath);

  const openApiPath = absoluteFrom(configDir, config.openApi);
  let openApiContent: string;
  try {
    openApiContent = await fs.readFile(openApiPath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new Error(
        `No se encontró openapi.yaml en ${openApiPath}. ` +
          `Config usada: ${configPath}. Valor openApi: ${config.openApi}`
      );
    }
    throw error;
  }

  let requirementsPath: string | undefined;
  let requirementsContent: string | undefined;

  if (config.requirements) {
    const fullPath = absoluteFrom(configDir, config.requirements);
    requirementsPath = fullPath;
    requirementsContent = await readTextIfExists(fullPath);
  }

  return {
    config,
    configPath,
    openApiPath,
    openApiContent,
    requirementsPath,
    requirementsContent,
  };
}

export function resolveFromConfig(context: LoadedContext, maybeRelative: string): string {
  const configDir = path.dirname(context.configPath);
  return absoluteFrom(configDir, maybeRelative);
}

/**
 * Resuelve la ruta absoluta del repositorio frontend. Lanza un error claro si
 * `frontend.root` no está definido: las operaciones E2E (Cypress) lo requieren.
 * La generación de rf-cu.md, en cambio, tolera su ausencia (modo OpenAPI-first).
 */
export function requireFrontendRoot(context: LoadedContext): string {
  const root = context.config.frontend.root;
  if (!root) {
    throw new Error(
      "Esta operación requiere 'frontend.root' en mcp.config.json (ruta del repositorio frontend con la UI a probar)."
    );
  }
  return absoluteFrom(path.dirname(context.configPath), root);
}
