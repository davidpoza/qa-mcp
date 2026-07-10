import { promises as fs } from "node:fs";
import path from "node:path";
import { LoadedContext, RfEntry } from "../types";
import { extractOrBuildRfEntries } from "../rfcu";
import { loadE2EPrompt } from "../prompts/loader";

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function openApiSnippet(content: string): string {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.slice(0, 4).join(" | ");
}

function promptHeader(prompt: string): string {
  const compact = prompt
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 4)
    .join(" | ");
  return compact;
}

const baselineFixtureRelativePath = "cypress/fixtures/e2e-baseline.json";
const baselineSupportRelativePath = "cypress/support/e2e-baseline.js";

function baselineKeyFromEntry(entry: RfEntry, cuId: string): string {
  return `${entry.id}.${cuId}`;
}

function buildCypressSpec(
  entry: RfEntry,
  openApiContext: string,
  promptSummary: string,
  promptPath: string
): string {
  const describeName = `${entry.id} - ${entry.name}`;
  const tests = entry.cases
    .map((cu) => {
      const name = `${cu.id} ${cu.name}`;
      const key = baselineKeyFromEntry(entry, cu.id);
      return [
        `  it("${name}", () => {`,
        "    const currentSnapshot = {};",
        "    // TODO: poblar currentSnapshot con datos API/UI relevantes (totales, filas, columnas, estados, etc.)",
        "    cy.visit('/');",
        `    cy.log("RF: ${entry.id} | CU: ${cu.id}");`,
        `    cy.log("Prompt: ${promptSummary.replace(/"/g, '\\"')}");`,
        ...cu.steps.map((step) => `    cy.log("${step.replace(/"/g, '\\"')}");`),
        `    persistOrAssertBaseline("${key}", currentSnapshot);`,
        "  });",
      ].join("\n");
    })
    .join("\n\n");

  return [
    "const {",
    "  DEFAULT_NUMERIC_TOLERANCE,",
    "  compareBaselineRecord",
    `} = require("../support/e2e-baseline");`,
    "",
    `const baselineFixturePath = "${baselineFixtureRelativePath}";`,
    "const autoCaptureMissingBaseline = String(",
    "  Cypress.env(\"AUTO_CAPTURE_MISSING_BASELINE\") || \"true\"",
    ")",
    "  .toLowerCase()",
    "  .trim() === \"true\";",
    "",
    "function persistOrAssertBaseline(key, currentSnapshot, compareOptions = {}) {",
    "  cy.task(\"readBaseline\", { filePath: baselineFixturePath }).then((baseline) => {",
    "    const nextBaseline = baseline || {};",
    "    const expectedSnapshot = nextBaseline[key];",
    "    if (!expectedSnapshot && autoCaptureMissingBaseline) {",
    "      nextBaseline[key] = currentSnapshot;",
    "      cy.task(\"writeBaseline\", {",
    "        filePath: baselineFixturePath,",
    "        data: nextBaseline",
    "      }).then(() => {",
    "        cy.log(`Baseline autocapturado para \"${key}\". En la siguiente ejecución se validará.`);",
    "      });",
    "      return;",
    "    }",
    "",
    "    expect(expectedSnapshot, `No existe baseline para \"${key}\".`).to.exist;",
    "    const comparison = compareBaselineRecord(",
    "      currentSnapshot,",
    "      expectedSnapshot,",
    "      {",
    "        numericTolerance: DEFAULT_NUMERIC_TOLERANCE,",
    "        ...compareOptions",
    "      }",
    "    );",
    "    expect(",
    "      comparison.isMatch,",
    "      `Diferencias baseline en \"${key}\": ${JSON.stringify(comparison.mismatches, null, 2)}`",
    "    ).to.eq(true);",
    "  });",
    "}",
    "",
    `// Contexto OpenAPI: ${openApiContext}`,
    `// Prompt E2E origen: ${promptPath}`,
    `// Prompt E2E resumen: ${promptSummary}`,
    "// Requiere registrar tareas Cypress readBaseline/writeBaseline.",
    "// Usa cypress/support/baseline-tasks.js desde setupNodeEvents(on).",
    `describe("${describeName}", () => {`,
    tests,
    "});",
    "",
  ].join("\n");
}

function buildBaselineSupportFile(): string {
  return [
    "const DEFAULT_NUMERIC_TOLERANCE = 0.01;",
    "",
    "function parseLooseNumber(value) {",
    "  if (typeof value === \"number\") {",
    "    return Number.isFinite(value) ? value : null;",
    "  }",
    "  if (typeof value !== \"string\") {",
    "    return null;",
    "  }",
    "  const raw = value.trim();",
    "  if (!raw) {",
    "    return null;",
    "  }",
    "  const cleaned = raw",
    "    .replace(/\\s/g, \"\")",
    "    .replace(/[€$]/g, \"\")",
    "    .replace(/\\./g, \"\")",
    "    .replace(\",\", \".\")",
    "    .replace(/[^\\d.-]/g, \"\");",
    "  if (!/^[-+]?\\d*(\\.\\d+)?$/.test(cleaned) || cleaned === \".\" || cleaned === \"\" || cleaned === \"-\" || cleaned === \"+\") {",
    "    return null;",
    "  }",
    "  const parsed = Number(cleaned);",
    "  return Number.isFinite(parsed) ? parsed : null;",
    "}",
    "",
    "function isPlainObject(value) {",
    "  return value !== null && typeof value === \"object\" && !Array.isArray(value);",
    "}",
    "",
    "function pushMismatch(mismatches, path, actual, expected, reason) {",
    "  mismatches.push({ path, actual, expected, reason });",
    "}",
    "",
    "function compareValue(actual, expected, path, options, mismatches) {",
    "  const numericTolerance = typeof options.numericTolerance === \"number\" ? options.numericTolerance : DEFAULT_NUMERIC_TOLERANCE;",
    "",
    "  const actualAsNumber = parseLooseNumber(actual);",
    "  const expectedAsNumber = parseLooseNumber(expected);",
    "  if (actualAsNumber !== null && expectedAsNumber !== null) {",
    "    const diff = Math.abs(actualAsNumber - expectedAsNumber);",
    "    if (diff > numericTolerance) {",
    "      pushMismatch(mismatches, path, actual, expected, `Diferencia numérica ${diff} > tolerancia ${numericTolerance}`);",
    "    }",
    "    return;",
    "  }",
    "",
    "  if (Array.isArray(actual) || Array.isArray(expected)) {",
    "    if (!Array.isArray(actual) || !Array.isArray(expected)) {",
    "      pushMismatch(mismatches, path, actual, expected, \"Tipo distinto (array vs no array)\");",
    "      return;",
    "    }",
    "    if (actual.length !== expected.length) {",
    "      pushMismatch(mismatches, path, actual.length, expected.length, \"Longitud de array distinta\");",
    "    }",
    "    const maxLength = Math.max(actual.length, expected.length);",
    "    for (let index = 0; index < maxLength; index += 1) {",
    "      compareValue(actual[index], expected[index], `${path}[${index}]`, options, mismatches);",
    "    }",
    "    return;",
    "  }",
    "",
    "  if (isPlainObject(actual) || isPlainObject(expected)) {",
    "    if (!isPlainObject(actual) || !isPlainObject(expected)) {",
    "      pushMismatch(mismatches, path, actual, expected, \"Tipo distinto (objeto vs no objeto)\");",
    "      return;",
    "    }",
    "    const keys = Array.from(new Set([...Object.keys(actual), ...Object.keys(expected)]));",
    "    keys.forEach((key) => {",
    "      const childPath = path ? `${path}.${key}` : key;",
    "      compareValue(actual[key], expected[key], childPath, options, mismatches);",
    "    });",
    "    return;",
    "  }",
    "",
    "  if (actual !== expected) {",
    "    pushMismatch(mismatches, path, actual, expected, \"Valor distinto\");",
    "  }",
    "}",
    "",
    "function compareBaselineRecord(actualRecord, expectedRecord, options = {}) {",
    "  const mismatches = [];",
    "  compareValue(actualRecord, expectedRecord, \"\", options, mismatches);",
    "",
    "  return {",
    "    isMatch: mismatches.length === 0,",
    "    mismatches",
    "  };",
    "}",
    "",
    "module.exports = {",
    "  DEFAULT_NUMERIC_TOLERANCE,",
    "  compareBaselineRecord",
    "};",
    "",
  ].join("\n");
}

function buildBaselineTasksSnippetFile(): string {
  return [
    "const fs = require('fs');",
    "const path = require('path');",
    "",
    "function ensureDirectory(filePath) {",
    "  const directory = path.dirname(filePath);",
    "  if (!fs.existsSync(directory)) {",
    "    fs.mkdirSync(directory, { recursive: true });",
    "  }",
    "}",
    "",
    "function registerBaselineTasks(on) {",
    "  on('task', {",
    "    readBaseline({ filePath }) {",
    "      if (!filePath || typeof filePath !== 'string') {",
    "        throw new Error('readBaseline requiere filePath válido');",
    "      }",
    "      const absolutePath = path.resolve(filePath);",
    "      if (!fs.existsSync(absolutePath)) {",
    "        return {};",
    "      }",
    "      const content = fs.readFileSync(absolutePath, 'utf8');",
    "      if (!content.trim()) {",
    "        return {};",
    "      }",
    "      return JSON.parse(content);",
    "    },",
    "    writeBaseline({ filePath, data }) {",
    "      if (!filePath || typeof filePath !== 'string') {",
    "        throw new Error('writeBaseline requiere filePath válido');",
    "      }",
    "      const absolutePath = path.resolve(filePath);",
    "      ensureDirectory(absolutePath);",
    "      fs.writeFileSync(",
    "        absolutePath,",
    "        `${JSON.stringify(data || {}, null, 2)}\\n`,",
    "        'utf8'",
    "      );",
    "      return true;",
    "    }",
    "  });",
    "}",
    "",
    "module.exports = { registerBaselineTasks };",
    "",
  ].join("\n");
}

async function writeBaselineAssets(context: LoadedContext): Promise<void> {
  const configRoot = path.dirname(context.configPath);
  const frontendRoot = path.resolve(configRoot, context.config.frontend.root);
  const supportPath = path.resolve(frontendRoot, baselineSupportRelativePath);
  const fixturesPath = path.resolve(frontendRoot, baselineFixtureRelativePath);
  const tasksSnippetPath = path.resolve(frontendRoot, "cypress", "support", "baseline-tasks.js");

  await fs.mkdir(path.dirname(supportPath), { recursive: true });
  await fs.mkdir(path.dirname(fixturesPath), { recursive: true });
  await fs.mkdir(path.dirname(tasksSnippetPath), { recursive: true });

  await fs.writeFile(supportPath, buildBaselineSupportFile(), "utf8");

  try {
    await fs.access(fixturesPath);
  } catch {
    await fs.writeFile(fixturesPath, "{}\n", "utf8");
  }

  await fs.writeFile(tasksSnippetPath, buildBaselineTasksSnippetFile(), "utf8");
}

export async function generateE2ETests(
  context: LoadedContext,
  promptOverride?: string
): Promise<{ files: string[]; rfCount: number }> {
  await writeBaselineAssets(context);

  const outputRoot = path.resolve(path.dirname(context.configPath), context.config.e2eTests);
  await fs.mkdir(outputRoot, { recursive: true });

  const entries: RfEntry[] = extractOrBuildRfEntries(context);
  const files: string[] = [];

  for (const entry of entries) {
    const fileName = `${slug(entry.id)}-${slug(entry.name)}.cy.ts`;
    const fullPath = path.join(outputRoot, fileName);
    const promptData = await loadE2EPrompt(context, entry, undefined, promptOverride);
    await fs.writeFile(
      fullPath,
      buildCypressSpec(
        entry,
        openApiSnippet(context.openApiContent),
        promptHeader(promptData.text),
        promptData.sourcePath
      ),
      "utf8"
    );
    files.push(fullPath);
  }

  return { files, rfCount: entries.length };
}
