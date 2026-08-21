import ExcelJS from "exceljs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { LoadedContext } from "../types";
import { collectEvidenceTestCases, EvidenceTestCase } from "../evidence";
import { extractOrBuildRfEntries, manualInstructions, rfCuContractErrors } from "../rfcu";

const HEADERS = [
  "index",
  "Caso de prueba",
  "R. Funcional",
  "Aplicacion",
  "Nombre",
  "Objetivo Funcionalidad",
  "Requisitos Previos / Restricciones",
  "Acciones",
  "Resultado",
  "Resultado reproducido",
  "Responsable",
];

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function relativePath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function projectApplication(context: LoadedContext, kind: EvidenceTestCase["kind"]): string {
  const configRoot = path.dirname(context.configPath);
  const configuredRoot = kind === "REST" ? context.config.backend.root : context.config.frontend.root;
  const role = kind === "REST" ? "BACKEND" : "FRONTEND";
  const absoluteRoot = configuredRoot ? path.resolve(configRoot, configuredRoot) : configRoot;
  let project = path.basename(absoluteRoot);
  if (/^(backend|frontend|src)$/i.test(project)) project = path.basename(configRoot);
  const normalized = project.replace(/[-_]+/g, " ").trim().toUpperCase() || "APLICACIÓN";
  return normalized.includes(role) ? normalized : `${normalized} ${role}`;
}

function testActions(test: EvidenceTestCase): string {
  const steps = test.cu ? manualInstructions(test.cu) : [];
  const numbered = steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
  if (test.kind === "REST") {
    const request = test.rf?.methodPath
      ? `Invocar ${test.rf.methodPath}.`
      : `Ejecutar el test automatizado ${test.technicalName}.`;
    return numbered ? `${request}\n${numbered}` : request;
  }
  return numbered || `Ejecutar el escenario Cypress \"${test.technicalName}\".`;
}

function reproducedResult(root: string, test: EvidenceTestCase): string {
  const source = relativePath(root, test.sourceFile);
  const location = test.logFile ? `${source} | Log: ${relativePath(root, test.logFile)}` : source;
  if (test.status === "OK") return `PASS | ${location}`;
  if (test.status === "KO") return `FAIL | ${location}`;
  if (test.status === "OMITIDO") return `SKIPPED | ${location}`;
  return `PENDIENTE | ${location}${test.kind === "REST" ? `#${test.technicalName}` : ""}`;
}

function prerequisites(root: string, test: EvidenceTestCase): string {
  const technology = test.kind === "REST" ? "Rest Assured" : "Cypress";
  const parts = [`Tecnología: ${technology}`, `Fuente: ${relativePath(root, test.sourceFile)}`];
  if (test.executedAt) parts.push(`Última ejecución: ${test.executedAt}`);
  return parts.join(" | ");
}

function functionalRequirement(test: EvidenceTestCase): string {
  if (test.rf) return `${test.rf.id} — ${test.rf.name}`;
  return path.basename(test.sourceFile)
    .replace(/Test\.(java|js)$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

const evidenceOrder = new Intl.Collator("es", { numeric: true, sensitivity: "base" });

function compareEvidenceTests(left: EvidenceTestCase, right: EvidenceTestCase): number {
  if (left.kind !== right.kind) return left.kind === "REST" ? -1 : 1;

  const requirementOrder = evidenceOrder.compare(
    functionalRequirement(left),
    functionalRequirement(right)
  );
  if (requirementOrder !== 0) return requirementOrder;

  const nameOrder = evidenceOrder.compare(left.title, right.title);
  if (nameOrder !== 0) return nameOrder;

  return evidenceOrder.compare(left.sourceFile, right.sourceFile);
}

function objective(test: EvidenceTestCase): string {
  if (test.cu) return `Validar ${test.cu.name}`;
  return `Validar ${test.title}`;
}

function estimatedRowHeight(values: unknown[], widths: Array<number | undefined>, minimum: number): number {
  let lines = 1;
  values.forEach((value, index) => {
    const text = String(value ?? "");
    const width = Math.max(10, widths[index] ?? 20);
    const explicitLines = text.split("\n").reduce(
      (total, part) => total + Math.max(1, Math.ceil(part.length / Math.max(12, width * 1.25))),
      0
    );
    lines = Math.max(lines, explicitLines);
  });
  return Math.min(120, Math.max(minimum, lines * 15));
}

function applyDefaultHeaderStyle(cell: ExcelJS.Cell): void {
  cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF96CE00" } };
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  cell.border = {
    top: { style: "thin", color: { argb: "FF666666" } },
    left: { style: "thin", color: { argb: "FF666666" } },
    bottom: { style: "thin", color: { argb: "FF666666" } },
    right: { style: "thin", color: { argb: "FF666666" } },
  };
}

function applyDefaultDataStyle(cell: ExcelJS.Cell): void {
  cell.font = { name: "Calibri", size: 10 };
  cell.alignment = { vertical: "top", wrapText: true };
  cell.border = {
    top: { style: "thin", color: { argb: "FF666666" } },
    left: { style: "thin", color: { argb: "FF666666" } },
    bottom: { style: "thin", color: { argb: "FF666666" } },
    right: { style: "thin", color: { argb: "FF666666" } },
  };
}

/**
 * ExcelJS conserva en `_rows` las filas borradas si solo contienen estilos.
 * `evidences.xlsx` estiliza las 121 filas de ejemplo, por lo que `spliceRows`
 * deja huecos y `addRow` continuaría en la fila 123. Tras el borrado público,
 * recortamos esos modelos vacíos para que los casos reales empiecen en la 2.
 */
function clearTemplateDataRows(sheet: ExcelJS.Worksheet): void {
  if (sheet.rowCount <= 1) return;
  sheet.spliceRows(2, sheet.rowCount - 1);
  const internal = sheet as unknown as { _rows?: Array<ExcelJS.Row | undefined> };
  if (Array.isArray(internal._rows) && internal._rows.length > 1) {
    internal._rows.splice(1);
  }
}

export async function exportETPAsExcel(context: LoadedContext, outputFileName?: string): Promise<string> {
  const configRoot = path.dirname(context.configPath);
  const configuredTemplatePath = path.resolve(configRoot, context.config.evidence.excelTemplate);
  const bundledTemplatePath = path.resolve(__dirname, "..", "..", "templates", "evidences.xlsx");
  const outputDir = path.resolve(configRoot, context.config.evidence.output);
  const outputPath = path.join(outputDir, outputFileName ?? "ETP.xlsx");

  await fs.mkdir(outputDir, { recursive: true });
  const root = path.dirname(context.configPath);
  const contractErrors = rfCuContractErrors(extractOrBuildRfEntries(context));
  if (contractErrors.length > 0) {
    throw new Error(
      "No se puede exportar el ETP Excel porque rf-cu.md contiene acciones ambiguas o divergentes:\n- " +
        contractErrors.join("\n- ")
    );
  }
  const tests = (await collectEvidenceTestCases(context)).sort(compareEvidenceTests);
  if (tests.length === 0) {
    throw new Error(
      "No se encontraron tests para exportar: se esperaba al menos un método Java @Test en restTests " +
        "o un it()/test() Cypress en un .cy.js de e2eTests."
    );
  }

  const workbook = new ExcelJS.Workbook();
  const templatePath = (await exists(configuredTemplatePath))
    ? configuredTemplatePath
    : bundledTemplatePath;
  const hasTemplate = await exists(templatePath);
  if (hasTemplate) {
    await workbook.xlsx.readFile(templatePath);
  }

  const sheet = workbook.worksheets[0] ?? workbook.addWorksheet("Plantilla de Casos de Prueba");
  const templateDataStyles = Array.from({ length: HEADERS.length }, (_, index) =>
    clone(sheet.getCell(2, index + 1).style)
  );
  const templateRowHeight = sheet.getRow(2).height ?? 30;

  clearTemplateDataRows(sheet);
  HEADERS.forEach((header, index) => {
    const cell = sheet.getCell(1, index + 1);
    cell.value = header;
    if (!hasTemplate || Object.keys(cell.style).length === 0) applyDefaultHeaderStyle(cell);
  });

  const widths = [16.4, 20.3, 35.1, 31.2, 35.1, 50.7, 46.8, 58.5, 16.4, 66.4, 27.3];
  widths.forEach((width, index) => {
    if (!sheet.getColumn(index + 1).width) sheet.getColumn(index + 1).width = width;
  });

  const counters: Record<EvidenceTestCase["kind"], number> = { REST: 0, E2E: 0 };
  tests.forEach((test, index) => {
    counters[test.kind] += 1;
    const values = [
      index,
      `${test.kind}-${String(counters[test.kind]).padStart(3, "0")}`,
      functionalRequirement(test),
      projectApplication(context, test.kind),
      test.title,
      objective(test),
      prerequisites(root, test),
      testActions(test),
      test.status,
      reproducedResult(root, test),
      "QA Automation",
    ];
    const row = sheet.addRow(values);
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      const templateStyle = templateDataStyles[columnNumber - 1];
      if (templateStyle && Object.keys(templateStyle).length > 0) cell.style = clone(templateStyle);
      else applyDefaultDataStyle(cell);
      cell.alignment = { ...cell.alignment, vertical: "top", wrapText: true };
    });
    row.height = estimatedRowHeight(values, widths, templateRowHeight);
  });

  sheet.views = [{ state: "frozen", ySplit: 1, topLeftCell: "A2" }];
  sheet.autoFilter = `A1:K${Math.max(1, tests.length + 1)}`;
  workbook.creator = "qa-mcp";
  workbook.modified = new Date();

  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}
