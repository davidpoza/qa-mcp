import { promises as fs } from "node:fs";
import path from "node:path";
import { LoadedContext } from "./types";

async function listFilesRecursive(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const output: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        output.push(...(await listFilesRecursive(full)));
      } else {
        output.push(full);
      }
    }
    return output;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function collectEvidence(context: LoadedContext): Promise<{ restFiles: string[]; e2eFiles: string[] }> {
  const root = path.dirname(context.configPath);
  const restDir = path.resolve(root, context.config.restTests);
  const e2eDir = path.resolve(root, context.config.e2eTests);

  const [restFiles, e2eFiles] = await Promise.all([listFilesRecursive(restDir), listFilesRecursive(e2eDir)]);
  return { restFiles, e2eFiles };
}

