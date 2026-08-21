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

interface CypressScreenshotCandidate {
  filePath: string;
  /** Cypress deja el primer intento sin sufijo y añade `(attempt N)` a los retries. */
  attempt: number;
  mtimeMs: number;
}

interface CompleteScreenshotAttempt {
  attempt: number;
  files: Array<{
    screenshot: ActionScreenshot;
    candidate: CypressScreenshotCandidate;
    dimensions: { width: number; height: number } | undefined;
  }>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resuelve el número de intento a partir del nombre que genera Cypress:
 * `evidence.png` para el primero y `evidence (attempt 2).png` para el segundo.
 */
function screenshotAttempt(filePath: string, expectedFileName: string): number | undefined {
  const actual = path.basename(filePath);
  if (actual.localeCompare(expectedFileName, undefined, { sensitivity: "accent" }) === 0) {
    return 1;
  }

  const parsed = path.parse(expectedFileName);
  const retryPattern = new RegExp(
    `^${escapeRegExp(parsed.name)} \\(attempt ([1-9]\\d*)\\)${escapeRegExp(parsed.ext)}$`,
    "i"
  );
  const retry = retryPattern.exec(actual);
  if (!retry) return undefined;
  return Number(retry[1]);
}

async function screenshotCandidates(
  files: string[],
  screenshot: ActionScreenshot,
  notBeforeMs?: number
): Promise<CypressScreenshotCandidate[]> {
  const candidates = await Promise.all(
    files.map(async (filePath): Promise<CypressScreenshotCandidate | undefined> => {
      const attempt = screenshotAttempt(filePath, screenshot.fileName);
      if (attempt === undefined) return undefined;
      const mtimeMs = (await fs.stat(filePath)).mtimeMs;
      if (notBeforeMs !== undefined && mtimeMs < notBeforeMs - 2000) return undefined;
      return { filePath, attempt, mtimeMs };
    })
  );
  return candidates.filter(
    (candidate): candidate is CypressScreenshotCandidate => candidate !== undefined
  );
}

/**
 * Devuelve el último intento de Cypress sólo si contiene el juego COMPLETO de
 * evidencias. Es importante no caer a un intento anterior: el último es el que
 * determina el resultado final del test y tampoco se deben mezclar sus PNG con
 * los de un retry previo.
 */
async function resolveCompleteScreenshotAttempt(
  files: string[],
  expected: ActionScreenshot[],
  notBeforeMs?: number
): Promise<CompleteScreenshotAttempt | undefined> {
  const candidatesByScreenshot = await Promise.all(
    expected.map((screenshot) => screenshotCandidates(files, screenshot, notBeforeMs))
  );
  const attempts = new Set<number>();
  candidatesByScreenshot.forEach((candidates) =>
    candidates.forEach((candidate) => attempts.add(candidate.attempt))
  );

  if (attempts.size === 0) return undefined;
  const attempt = Math.max(...attempts);
  const selected = expected.map((screenshot, index) => {
    const candidates = candidatesByScreenshot[index]
      .filter((candidate) => candidate.attempt === attempt)
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    return candidates[0]
      ? { screenshot, candidate: candidates[0], dimensions: undefined }
      : undefined;
  });
  if (selected.some((candidate) => candidate === undefined)) return undefined;
  return {
    attempt,
    files: selected as CompleteScreenshotAttempt["files"],
  };
}

function availableAttemptsDescription(
  expected: ActionScreenshot[],
  files: string[]
): string {
  const attempts = new Map<number, string[]>();
  for (const screenshot of expected) {
    for (const file of files) {
      const attempt = screenshotAttempt(file, screenshot.fileName);
      if (attempt === undefined) continue;
      const names = attempts.get(attempt) ?? [];
      names.push(screenshot.fileName);
      attempts.set(attempt, names);
    }
  }
  if (attempts.size === 0) return "No se encontró ninguna evidencia esperada.";
  return [...attempts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([attempt, names]) => {
      const present = new Set(names);
      const missing = expected
        .filter((screenshot) => !present.has(screenshot.fileName))
        .map((screenshot) => screenshot.fileName);
      return `Intento ${attempt}: faltan ${missing.length > 0 ? missing.join(", ") : "ninguna"}.`;
    })
    .join(" ");
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
  const completeAttempt = await resolveCompleteScreenshotAttempt(files, expected, notBeforeMs);
  if (!completeAttempt) {
    const currentFiles = notBeforeMs === undefined
      ? files
      : (await Promise.all(
          files.map(async (filePath) => ({ filePath, mtimeMs: (await fs.stat(filePath)).mtimeMs }))
        ))
          .filter((file) => file.mtimeMs >= notBeforeMs - 2000)
          .map((file) => file.filePath);
    throw new Error(
      `Cypress terminó en verde, pero el último intento no generó el juego completo de capturas ` +
        `para ${rf.id}.${cu.id}. ${availableAttemptsDescription(expected, currentFiles)}`
    );
  }

  // Primero valida el lote completo. Así un error tardío no deja evidencias
  // parciales que parezcan pertenecer a una ejecución válida.
  for (const item of completeAttempt.files) {
    item.dimensions = await pngDimensions(item.candidate.filePath);
    const dimensions = item.dimensions;
    if (
      dimensions?.width !== EVIDENCE_SCREENSHOT_WIDTH ||
      dimensions.height !== EVIDENCE_SCREENSHOT_HEIGHT
    ) {
      const actual = dimensions ? `${dimensions.width}x${dimensions.height}` : "formato no-PNG";
      throw new Error(
        `La captura ${item.screenshot.fileName} del intento ${completeAttempt.attempt} tiene resolución ${actual}; ` +
          `las evidencias deben generarse a ${EVIDENCE_SCREENSHOT_WIDTH}x${EVIDENCE_SCREENSHOT_HEIGHT} con escala 100%.`
      );
    }
  }

  await fs.mkdir(destination, { recursive: true });
  const persisted: string[] = [];
  for (const item of completeAttempt.files) {
    const outputPath = path.join(destination, item.screenshot.fileName);
    await fs.copyFile(item.candidate.filePath, outputPath);
    persisted.push(outputPath);
  }
  return persisted;
}
