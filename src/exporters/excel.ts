import ExcelJS from "exceljs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { LoadedContext } from "../types";
import { collectEvidence } from "../evidence";

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function exportETPAsExcel(context: LoadedContext, outputFileName?: string): Promise<string> {
  const configRoot = path.dirname(context.configPath);
  const templatePath = path.resolve(configRoot, context.config.evidence.excelTemplate);
  const outputDir = path.resolve(configRoot, context.config.evidence.output);
  const outputPath = path.join(outputDir, outputFileName ?? "ETP.xlsx");

  await fs.mkdir(outputDir, { recursive: true });

  const workbook = new ExcelJS.Workbook();
  if (await exists(templatePath)) {
    await workbook.xlsx.readFile(templatePath);
  }

  const sheet = workbook.worksheets[0] ?? workbook.addWorksheet("ETP");
  sheet.getCell("A1").value = "Plan de Pruebas (ETP)";
  sheet.getCell("A2").value = "OpenAPI";
  sheet.getCell("B2").value = context.openApiPath;
  sheet.getCell("A3").value = "Configuración MCP";
  sheet.getCell("B3").value = context.configPath;
  sheet.getCell("A4").value = "Contexto OpenAPI";
  sheet.getCell("B4").value = context.openApiContent.split("\n").slice(0, 3).join(" | ");

  const evidence = await collectEvidence(context);
  let row = 6;
  sheet.getCell(`A${row}`).value = "Evidencias API (Rest Assured)";
  row += 1;
  for (const file of evidence.restFiles) {
    sheet.getCell(`A${row}`).value = path.basename(file);
    sheet.getCell(`B${row}`).value = file;
    row += 1;
  }

  row += 1;
  sheet.getCell(`A${row}`).value = "Evidencias E2E (Cypress)";
  row += 1;
  for (const file of evidence.e2eFiles) {
    sheet.getCell(`A${row}`).value = path.basename(file);
    sheet.getCell(`B${row}`).value = file;
    row += 1;
  }

  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}
