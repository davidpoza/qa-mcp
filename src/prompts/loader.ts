import { promises as fs } from "node:fs";
import path from "node:path";
import { LoadedContext, RfEntry } from "../types";
import { requireFrontendRoot } from "../config";

export interface PromptContext {
  rfId: string;
  cuId?: string;
}

function resolvePromptPath(context: LoadedContext): string {
  const configuredPath = context.config.prompts?.e2e;
  const configRoot = path.dirname(context.configPath);
  if (configuredPath && configuredPath.length > 0) {
    return path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(configRoot, configuredPath);
  }
  return path.resolve(__dirname, "..", "..", "prompts", "e2e.md");
}

function interpolatePrompt(template: string, context: LoadedContext, promptContext: PromptContext): string {
  const frontendRoot = requireFrontendRoot(context);
  const replacements: Record<string, string> = {
    openApiPath: context.openApiPath,
    frontendRoot,
    rfId: promptContext.rfId,
    cuId: promptContext.cuId ?? "",
  };

  let output = template;
  for (const [key, value] of Object.entries(replacements)) {
    output = output.replaceAll(`{{${key}}}`, value);
  }
  return output;
}

export async function loadE2EPrompt(
  context: LoadedContext,
  rf: RfEntry,
  cuId?: string,
  promptOverride?: string
): Promise<{ text: string; sourcePath: string }> {
  const promptPath = resolvePromptPath(context);
  const basePrompt = await fs.readFile(promptPath, "utf8");
  const interpolated = interpolatePrompt(basePrompt, context, { rfId: rf.id, cuId });

  let finalPrompt = interpolated;
  if (promptOverride && promptOverride.trim().length > 0) {
    finalPrompt = `${interpolated}\n\n# Override de ejecución\n${promptOverride.trim()}\n`;
  }

  return { text: finalPrompt, sourcePath: promptPath };
}
