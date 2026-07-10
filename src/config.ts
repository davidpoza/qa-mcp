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
    root: z.string().min(1),
    framework: z.string().min(1),
    e2e: z.string().min(1),
  }),
  openApi: z.string().min(1),
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

  const rawConfig = await fs.readFile(configPath, "utf8");
  const parsed = JSON.parse(rawConfig);
  const config = configSchema.parse(parsed) as McpQaConfig;
  const configDir = path.dirname(configPath);

  const openApiPath = absoluteFrom(configDir, config.openApi);
  const openApiContent = await fs.readFile(openApiPath, "utf8");

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
