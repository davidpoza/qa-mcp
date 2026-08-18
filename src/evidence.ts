import { promises as fs } from "node:fs";
import path from "node:path";
import { extractOrBuildRfEntries } from "./rfcu";
import { E2EStatusLike, isCurrentGreenE2EStatus } from "./e2e-contract";
import { CuCase, LoadedContext, RfEntry } from "./types";

export type EvidenceTestKind = "REST" | "E2E";
export type EvidenceTestStatus = "OK" | "KO" | "OMITIDO" | "NO EJECUTADO";

/** Un test real encontrado en los artefactos generados por qa-mcp. */
export interface EvidenceTestCase {
  kind: EvidenceTestKind;
  technicalName: string;
  title: string;
  sourceFile: string;
  logFile?: string;
  rf?: RfEntry;
  cu?: CuCase;
  status: EvidenceTestStatus;
  executedAt?: string;
}

interface CuUnit {
  rf: RfEntry;
  cu: CuCase;
  unitId: string;
  e2eFileName: string;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function javaClassName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9]+/g, " ");
  const pascal = cleaned
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
  return pascal || "GeneratedApi";
}

function javaMethodName(value: string): string {
  const cls = javaClassName(value);
  return cls.charAt(0).toLowerCase() + cls.slice(1);
}

function expandToCuUnits(entries: RfEntry[]): CuUnit[] {
  const units: CuUnit[] = [];
  for (const rf of entries) {
    const cases = rf.cases.length > 0 ? rf.cases : [{ id: "CU-1", name: rf.name, steps: [] }];
    for (const cu of cases) {
      units.push({
        rf,
        cu,
        unitId: `${rf.id}.${cu.id}`,
        e2eFileName: `${slug(rf.id)}-${slug(cu.id)}-${slug(cu.name)}.cy.js`,
      });
    }
  }
  return units;
}

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
    return output.sort((a, b) => a.localeCompare(b));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return undefined;
    throw error;
  }
}

function humanizeTechnicalName(value: string): string {
  const text = value
    .replace(/_\d+$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : value;
}

function decodeQuotedTitle(value: string): string {
  return value
    .replace(/\\n/g, " ")
    .replace(/\\r/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\([\\'"`])/g, "$1")
    .trim();
}

function lastDisplayNameBefore(content: string, offset: number): string | undefined {
  const prefix = content.slice(Math.max(0, offset - 600), offset);
  const boundary = Math.max(prefix.lastIndexOf("}"), prefix.lastIndexOf(";"));
  const local = prefix.slice(boundary + 1);
  const matches = [...local.matchAll(/@DisplayName\(\s*"((?:\\.|[^"\\])*)"\s*\)/g)];
  const value = matches.at(-1)?.[1];
  return value ? decodeQuotedTitle(value) : undefined;
}

function parseJavaTests(content: string): Array<{ name: string; title: string; skipped: boolean }> {
  const tests: Array<{ name: string; title: string; skipped: boolean }> = [];
  const testRegex = /@Test(?:\s*\([^)]*\))?(?:\s*@[\w.]+(?:\([^\r\n]*\))?)*\s+(?:(?:public|protected|private|static|final|synchronized)\s+)*(?:void|[\w.<>,?\[\]]+)\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = testRegex.exec(content)) !== null) {
    const name = match[1];
    const before = content.slice(Math.max(0, match.index - 300), match.index);
    tests.push({
      name,
      title: lastDisplayNameBefore(content, match.index) ?? humanizeTechnicalName(name),
      skipped: /@Disabled\b/.test(before.slice(Math.max(before.lastIndexOf("}"), before.lastIndexOf(";")) + 1)),
    });
  }
  return tests;
}

function parseCypressTests(content: string): Array<{ name: string; title: string; skipped: boolean }> {
  const tests: Array<{ name: string; title: string; skipped: boolean }> = [];
  const testRegex = /\b(it|test)(?:\.(only|skip))?\s*\(\s*(["'`])((?:\\[\s\S]|(?!\3)[\s\S])*)\3/g;
  let match: RegExpExecArray | null;
  while ((match = testRegex.exec(content)) !== null) {
    const title = decodeQuotedTitle(match[4]);
    tests.push({
      name: title || `${match[1]}-${tests.length + 1}`,
      title: title || `Test Cypress ${tests.length + 1}`,
      skipped: match[2] === "skip",
    });
  }
  return tests;
}

async function readE2EStatus(e2eRoot: string): Promise<Record<string, E2EStatusLike>> {
  const raw = await readText(path.join(e2eRoot, ".qa-mcp-e2e-status.json"));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, E2EStatusLike>)
      : {};
  } catch {
    return {};
  }
}

async function e2eExecutionFromDisk(params: {
  specFile: string;
  unit?: CuUnit;
  status: Record<string, E2EStatusLike>;
  skipped: boolean;
}): Promise<{ status: EvidenceTestStatus; executedAt?: string; logFile?: string }> {
  if (params.skipped) return { status: "OMITIDO" };

  const specificKey = params.unit?.unitId.toLowerCase();
  const state = specificKey ? params.status[specificKey] : undefined;
  const logFile = params.specFile.replace(/\.cy\.js$/i, ".log");
  const log = await readText(logFile);
  const logResult = log?.match(/^Resultado:\s*(PASA|FALLA)/im)?.[1];
  const logDate = log?.match(/^Generado:\s*(.+)$/im)?.[1]?.trim();

  let testStatus: EvidenceTestStatus = "NO EJECUTADO";
  if (isCurrentGreenE2EStatus(state) || (!state && logResult === "PASA")) testStatus = "OK";
  else if (state?.green === false || (!state && logResult === "FALLA")) testStatus = "KO";

  return {
    status: testStatus,
    executedAt: typeof state?.at === "string" ? state.at : logDate,
    logFile: log ? logFile : undefined,
  };
}

function restMappingForFile(entries: RfEntry[], filePath: string): RfEntry | undefined {
  const base = path.basename(filePath).toLowerCase();
  return entries.find(
    (entry) => `${javaClassName(entry.name)}ApiTest.java`.toLowerCase() === base
  );
}

function cuForRestTest(
  rf: RfEntry | undefined,
  methodName: string,
  index: number,
  allEntries: RfEntry[]
): { rf?: RfEntry; cu?: CuCase } {
  if (rf) {
    const byName = rf.cases.find(
      (cu, cuIndex) => `${javaMethodName(cu.name)}_${cuIndex + 1}` === methodName
    );
    return { rf, cu: byName ?? rf.cases[index] };
  }
  for (const candidate of allEntries) {
    const cu = candidate.cases.find(
      (item, cuIndex) => `${javaMethodName(item.name)}_${cuIndex + 1}` === methodName
    );
    if (cu) return { rf: candidate, cu };
  }
  return {};
}

function unitForCypressTest(
  units: CuUnit[],
  specFile: string,
  title: string
): CuUnit | undefined {
  const base = path.basename(specFile).toLowerCase();
  const exact = units.find((unit) => unit.e2eFileName.toLowerCase() === base);
  if (exact) return exact;

  // Clasifica specs históricos cuyo prefijo RF quedó mal generado usando el
  // nombre completo del CU incluido en el título del `it()`.
  const titleSlug = slug(title);
  const byTitle = units.filter((unit) => {
    const cuSlug = slug(unit.cu.name);
    return cuSlug.length > 0 && titleSlug.includes(cuSlug);
  });
  if (byTitle.length === 1) return byTitle[0];

  const rfCandidates = units.filter((unit) => base.startsWith(`${slug(unit.rf.id)}-`));
  const byCuId = rfCandidates.find((unit) =>
    new RegExp(`(^|\\s)${unit.cu.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|:|—|-)`, "i").test(title)
  );
  return byCuId ?? (new Set(rfCandidates.map((unit) => unit.rf.id)).size === 1 ? rfCandidates[0] : undefined);
}

/**
 * Extrae una fila lógica por cada método `@Test` Rest Assured y por cada
 * `it()`/`test()` Cypress realmente presente en los directorios configurados.
 */
export async function collectEvidenceTestCases(context: LoadedContext): Promise<EvidenceTestCase[]> {
  const root = path.dirname(context.configPath);
  const restRoot = path.resolve(root, context.config.restTests);
  const e2eRoot = path.resolve(root, context.config.e2eTests);
  const entries = extractOrBuildRfEntries(context);
  const units = expandToCuUnits(entries);
  const [restFiles, e2eFiles, e2eStatus] = await Promise.all([
    listFilesRecursive(restRoot),
    listFilesRecursive(e2eRoot),
    readE2EStatus(e2eRoot),
  ]);
  const cases: EvidenceTestCase[] = [];

  for (const file of restFiles.filter((item) => /\.java$/i.test(item))) {
    const content = await readText(file);
    if (!content) continue;
    const tests = parseJavaTests(content);
    const fileRf = restMappingForFile(entries, file);
    tests.forEach((test, index) => {
      const mapped = cuForRestTest(fileRf, test.name, index, entries);
      cases.push({
        kind: "REST",
        technicalName: test.name,
        title: mapped.cu ? `${mapped.cu.id} — ${mapped.cu.name}` : test.title,
        sourceFile: file,
        rf: mapped.rf,
        cu: mapped.cu,
        status: test.skipped ? "OMITIDO" : "NO EJECUTADO",
      });
    });
  }

  for (const file of e2eFiles.filter((item) => /\.cy\.js$/i.test(item))) {
    const content = await readText(file);
    if (!content) continue;
    const tests = parseCypressTests(content);
    for (const test of tests) {
      const unit = unitForCypressTest(units, file, test.title);
      const execution = await e2eExecutionFromDisk({
        specFile: file,
        unit,
        status: e2eStatus,
        skipped: test.skipped,
      });
      cases.push({
        kind: "E2E",
        technicalName: test.name,
        title: unit ? `${unit.cu.id} — ${unit.cu.name}` : test.title,
        sourceFile: file,
        logFile: execution.logFile,
        rf: unit?.rf,
        cu: unit?.cu,
        status: execution.status,
        executedAt: execution.executedAt,
      });
    }
  }

  return cases;
}

export async function collectEvidence(context: LoadedContext): Promise<{ restFiles: string[]; e2eFiles: string[] }> {
  const root = path.dirname(context.configPath);
  const restDir = path.resolve(root, context.config.restTests);
  const e2eDir = path.resolve(root, context.config.e2eTests);

  const [restFiles, e2eFiles] = await Promise.all([listFilesRecursive(restDir), listFilesRecursive(e2eDir)]);
  return { restFiles, e2eFiles };
}

