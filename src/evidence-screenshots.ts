import { promises as fs } from "node:fs";
import path from "node:path";
import { CuCase, LoadedContext, RfEntry } from "./types";

export interface ActionScreenshot {
  actionIndex: number;
  action: string;
  baseName: string;
  fileName: string;
}

export const EVIDENCE_SCREENSHOT_WIDTH = 1920;
export const EVIDENCE_SCREENSHOT_HEIGHT = 1080;

function evidenceId(value: string, fallback: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return normalized || fallback;
}

/**
 * Nombres estables compartidos por el generador Cypress y el exportador Word.
 * La primera acción usa el número 01, como en `rf1_cu1_01.png`.
 */
export function actionScreenshots(rf: RfEntry, cu: CuCase): ActionScreenshot[] {
  if (cu.steps.length > 99) {
    throw new Error(`${rf.id}.${cu.id} define más de 99 acciones; el sufijo de evidencia admite dos dígitos.`);
  }
  const rfId = evidenceId(rf.id, "rf");
  const cuId = evidenceId(cu.id, "cu");
  return cu.steps.map((action, actionIndex) => {
    const baseName = `${rfId}_${cuId}_${String(actionIndex + 1).padStart(2, "0")}`;
    return {
      actionIndex,
      action,
      baseName,
      fileName: `${baseName}.png`,
    };
  });
}

export function screenshotEvidenceDirectory(context: LoadedContext): string {
  const configRoot = path.dirname(context.configPath);
  return path.resolve(configRoot, context.config.evidence.output, "screenshots");
}

export function screenshotEvidencePath(
  context: LoadedContext,
  rf: RfEntry,
  cu: CuCase,
  actionIndex: number
): string {
  const screenshot = actionScreenshots(rf, cu)[actionIndex];
  if (!screenshot) {
    throw new Error(
      `No existe la acción ${actionIndex + 1} en ${rf.id}.${cu.id}; no se puede resolver su captura.`
    );
  }
  return path.join(screenshotEvidenceDirectory(context), screenshot.fileName);
}

function screenshotCallPattern(baseName: string): RegExp {
  return new RegExp(
    "\\bcy\\s*\\.\\s*screenshot\\s*\\(\\s*([\"'`])" +
      baseName +
      "\\1(?:\\s*,|\\s*\\))"
  );
}

function documentedControlEvidencePattern(baseName: string): RegExp {
  return new RegExp(
    "\\bsetDocumented(?:Control|Input)\\s*\\([^;]*([\"'`])" +
      baseName +
      "\\1\\s*\\)"
  );
}

/** Devuelve las capturas obligatorias que no están llamadas desde el spec. */
export function missingScreenshotCalls(spec: string, rf: RfEntry, cu: CuCase): ActionScreenshot[] {
  return actionScreenshots(rf, cu).filter(
    (screenshot) =>
      !screenshotCallPattern(screenshot.baseName).test(spec) &&
      !documentedControlEvidencePattern(screenshot.baseName).test(spec)
  );
}

async function pngDimensions(filePath: string): Promise<{ width: number; height: number } | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const isPng =
      bytesRead === header.length &&
      header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!isPng) return undefined;
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function isFullHdEvidence(filePath: string): Promise<boolean> {
  const dimensions = await pngDimensions(filePath);
  return dimensions?.width === EVIDENCE_SCREENSHOT_WIDTH &&
    dimensions.height === EVIDENCE_SCREENSHOT_HEIGHT;
}

export async function hasAllScreenshotEvidence(
  context: LoadedContext,
  rf: RfEntry,
  cu: CuCase
): Promise<boolean> {
  const directory = screenshotEvidenceDirectory(context);
  const expected = actionScreenshots(rf, cu);
  const present = await Promise.all(
    expected.map((screenshot) => isFullHdEvidence(path.join(directory, screenshot.fileName)))
  );
  return present.every(Boolean);
}

/** Elimina sólo las evidencias conocidas del CU antes de volver a ejecutarlo. */
export async function clearScreenshotEvidence(
  context: LoadedContext,
  rf: RfEntry,
  cu: CuCase
): Promise<void> {
  const directory = screenshotEvidenceDirectory(context);
  await Promise.all(
    actionScreenshots(rf, cu).map(async (screenshot) => {
      try {
        await fs.unlink(path.join(directory, screenshot.fileName));
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== "ENOENT") throw error;
      }
    })
  );
}

async function listFilesRecursive(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFilesRecursive(fullPath)));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

async function cypressScreenshotDirectory(frontendRoot: string): Promise<string> {
  const configNames = [
    "cypress.config.js",
    "cypress.config.cjs",
    "cypress.config.mjs",
    "cypress.config.ts",
  ];
  for (const configName of configNames) {
    try {
      const content = await fs.readFile(path.join(frontendRoot, configName), "utf8");
      const configured = content.match(/\bscreenshotsFolder\s*:\s*["'`]([^"'`]+)["'`]/)?.[1];
      if (configured) return path.resolve(frontendRoot, configured);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") throw error;
    }
  }
  return path.resolve(frontendRoot, "cypress", "screenshots");
}

/**
 * Copia las capturas PNG nativas producidas por Cypress a una ubicación estable
 * que no se borra al ejecutar el siguiente spec.
 */
export async function persistScreenshotEvidence(
  context: LoadedContext,
  frontendRoot: string,
  rf: RfEntry,
  cu: CuCase,
  notBeforeMs?: number
): Promise<string[]> {
  const expected = actionScreenshots(rf, cu);
  if (expected.length === 0) return [];

  const cypressScreenshots = await cypressScreenshotDirectory(frontendRoot);
  const files = await listFilesRecursive(cypressScreenshots);
  const destination = screenshotEvidenceDirectory(context);
  await fs.mkdir(destination, { recursive: true });

  const persisted: string[] = [];
  for (const screenshot of expected) {
    const matches = files.filter(
      (file) => path.basename(file).toLowerCase() === screenshot.fileName.toLowerCase()
    );
    if (matches.length === 0) {
      throw new Error(
        `Cypress terminó en verde, pero no generó la captura ${screenshot.fileName} ` +
          `para la acción ${screenshot.actionIndex + 1} de ${rf.id}.${cu.id}.`
      );
    }
    const candidates = (await Promise.all(
      matches.map(async (file) => ({ file, mtimeMs: (await fs.stat(file)).mtimeMs }))
    )).filter((candidate) => notBeforeMs === undefined || candidate.mtimeMs >= notBeforeMs - 2000);
    if (candidates.length === 0) {
      throw new Error(
        `La captura ${screenshot.fileName} existe, pero no fue generada por la ejecución actual de ${rf.id}.${cu.id}.`
      );
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const selected = candidates[0].file;
    const dimensions = await pngDimensions(selected);
    if (
      dimensions?.width !== EVIDENCE_SCREENSHOT_WIDTH ||
      dimensions.height !== EVIDENCE_SCREENSHOT_HEIGHT
    ) {
      const actual = dimensions ? `${dimensions.width}x${dimensions.height}` : "formato no-PNG";
      throw new Error(
        `La captura ${screenshot.fileName} tiene resolución ${actual}; ` +
          `las evidencias deben generarse a ${EVIDENCE_SCREENSHOT_WIDTH}x${EVIDENCE_SCREENSHOT_HEIGHT} con escala 100%.`
      );
    }
    const outputPath = path.join(destination, screenshot.fileName);
    await fs.copyFile(selected, outputPath);
    persisted.push(outputPath);
  }
  return persisted;
}
