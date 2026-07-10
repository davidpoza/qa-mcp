import { promises as fs } from "node:fs";
import path from "node:path";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { LoadedContext } from "../types";
import { collectEvidence } from "../evidence";

export async function exportETPAsWord(context: LoadedContext, outputFileName?: string): Promise<string> {
  const configRoot = path.dirname(context.configPath);
  const outputDir = path.resolve(configRoot, context.config.evidence.output);
  const outputPath = path.join(outputDir, outputFileName ?? "ETP.docx");
  await fs.mkdir(outputDir, { recursive: true });

  const evidence = await collectEvidence(context);
  const paragraphs: Paragraph[] = [];
  paragraphs.push(new Paragraph({ children: [new TextRun({ text: "Plan de Pruebas (ETP)", bold: true })] }));
  paragraphs.push(new Paragraph(`OpenAPI: ${context.openApiPath}`));
  paragraphs.push(new Paragraph(`Contexto OpenAPI: ${context.openApiContent.split("\n").slice(0, 3).join(" | ")}`));
  paragraphs.push(new Paragraph(`Config MCP: ${context.configPath}`));
  paragraphs.push(new Paragraph(""));
  paragraphs.push(new Paragraph({ children: [new TextRun({ text: "Evidencias API (Rest Assured)", bold: true })] }));
  for (const file of evidence.restFiles) {
    paragraphs.push(new Paragraph(`- ${file}`));
  }
  paragraphs.push(new Paragraph(""));
  paragraphs.push(new Paragraph({ children: [new TextRun({ text: "Evidencias E2E (Cypress)", bold: true })] }));
  for (const file of evidence.e2eFiles) {
    paragraphs.push(new Paragraph(`- ${file}`));
  }

  const wordTemplate = context.config.evidence.wordTemplate;
  if (wordTemplate) {
    paragraphs.push(new Paragraph(""));
    paragraphs.push(new Paragraph(`Plantilla de referencia configurada: ${path.resolve(configRoot, wordTemplate)}`));
  }

  const doc = new Document({
    sections: [{ properties: {}, children: paragraphs }],
  });
  const buffer = await Packer.toBuffer(doc);
  await fs.writeFile(outputPath, buffer);
  return outputPath;
}
