import { promises as fs } from "node:fs";
import path from "node:path";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { actionScreenshots, screenshotEvidenceDirectory } from "../evidence-screenshots";
import { E2EStatusLike, isCurrentGreenE2EStatus } from "../e2e-contract";
import { extractOrBuildRfEntries, manualInstructions, rfCuContextContractErrors } from "../rfcu";
import { CuCase, LoadedContext, RfEntry } from "../types";

const naturalOrder = new Intl.Collator("es", { numeric: true, sensitivity: "base" });

async function readE2EStatus(context: LoadedContext): Promise<Record<string, E2EStatusLike>> {
  const configRoot = path.dirname(context.configPath);
  const statusPath = path.resolve(
    configRoot,
    context.config.e2eTests,
    ".qa-mcp-e2e-status.json"
  );
  try {
    const parsed = JSON.parse(await fs.readFile(statusPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, E2EStatusLike>)
      : {};
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

function sortedEntries(context: LoadedContext): RfEntry[] {
  return extractOrBuildRfEntries(context)
    .map((rf) => ({
      ...rf,
      cases: [...rf.cases].sort((left, right) =>
        naturalOrder.compare(left.id, right.id) || naturalOrder.compare(left.name, right.name)
      ),
    }))
    .sort((left, right) =>
      naturalOrder.compare(left.id, right.id) || naturalOrder.compare(left.name, right.name)
    );
}

function pngDimensions(data: Buffer): { width: number; height: number } {
  const pngSignature = "89504e470d0a1a0a";
  if (data.length < 24 || data.subarray(0, 8).toString("hex") !== pngSignature) {
    throw new Error("La evidencia no es un PNG válido.");
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width <= 0 || height <= 0) throw new Error("La evidencia PNG tiene dimensiones inválidas.");
  const scale = Math.min(1, 600 / width, 720 / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function casesForRf(rf: RfEntry): CuCase[] {
  return rf.cases.length > 0 ? rf.cases : [{ id: "CU-1", name: rf.name, steps: [] }];
}

interface LoadedScreenshot {
  rf: RfEntry;
  cu: CuCase;
  evidenceIndex: number;
  actionIndex: number;
  operationIndex: number;
  action: string;
  fileName: string;
  data: Buffer;
  width: number;
  height: number;
}

async function loadCompleteEvidence(
  context: LoadedContext,
  entries: RfEntry[]
): Promise<Map<string, LoadedScreenshot>> {
  const status = await readE2EStatus(context);
  const directory = screenshotEvidenceDirectory(context);
  const screenshots = new Map<string, LoadedScreenshot>();
  const notGreen: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const rf of entries) {
    for (const cu of casesForRf(rf)) {
      const unitId = `${rf.id}.${cu.id}`;
      if (!isCurrentGreenE2EStatus(status[unitId.toLowerCase()])) notGreen.push(unitId);

      for (const screenshot of actionScreenshots(rf, cu)) {
        const imagePath = path.join(directory, screenshot.fileName);
        try {
          const data = await fs.readFile(imagePath);
          const dimensions = pngDimensions(data);
          screenshots.set(`${unitId}.${screenshot.evidenceIndex}`, {
            rf,
            cu,
            evidenceIndex: screenshot.evidenceIndex,
            actionIndex: screenshot.actionIndex,
            operationIndex: screenshot.operationIndex,
            action: screenshot.action,
            fileName: screenshot.fileName,
            data,
            ...dimensions,
          });
        } catch (error) {
          const nodeError = error as NodeJS.ErrnoException;
          if (nodeError.code === "ENOENT") missing.push(screenshot.fileName);
          else invalid.push(`${screenshot.fileName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  if (notGreen.length > 0 || missing.length > 0 || invalid.length > 0) {
    const details = [
      notGreen.length > 0
        ? `CU no verdes (${notGreen.length}): ${notGreen.slice(0, 12).join(", ")}${notGreen.length > 12 ? ", ..." : ""}`
        : "",
      missing.length > 0
        ? `capturas ausentes (${missing.length}): ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? ", ..." : ""}`
        : "",
      invalid.length > 0
        ? `capturas inválidas (${invalid.length}): ${invalid.slice(0, 6).join("; ")}${invalid.length > 6 ? "; ..." : ""}`
        : "",
    ].filter(Boolean);
    throw new Error(
      "No se puede exportar un ETP Word incompleto. Ejecuta generateE2ETests hasta que todos los CU " +
        `estén en verde y exista un PNG por operación documentada. ${details.join(" | ")}`
    );
  }

  return screenshots;
}

export async function exportETPAsWord(context: LoadedContext, outputFileName?: string): Promise<string> {
  const configRoot = path.dirname(context.configPath);
  const outputDir = path.resolve(configRoot, context.config.evidence.output);
  const outputPath = path.join(outputDir, outputFileName ?? "ETP.docx");
  const entries = sortedEntries(context);
  if (entries.length === 0) {
    throw new Error("No se encontraron RF/CU en rf-cu.md para generar el ETP Word.");
  }
  const contractErrors = await rfCuContextContractErrors(context, entries);
  if (contractErrors.length > 0) {
    throw new Error(
      "No se puede exportar el ETP Word porque rf-cu.md contiene acciones ambiguas o divergentes:\n- " +
        contractErrors.join("\n- ")
    );
  }

  const screenshots = await loadCompleteEvidence(context, entries);
  const paragraphs: Paragraph[] = [
    new Paragraph({
      text: "Plan de Pruebas (ETP)",
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
    }),
    new Paragraph({
      children: [new TextRun({ text: "Evidencias E2E generadas con Cypress", italics: true })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 360 },
    }),
  ];

  entries.forEach((rf, rfIndex) => {
    paragraphs.push(
      new Paragraph({
        text: `${rf.id} — ${rf.name}`,
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: rfIndex > 0,
        spacing: { before: 240, after: 160 },
      })
    );

    for (const cu of casesForRf(rf)) {
      const unitId = `${rf.id}.${cu.id}`;
      paragraphs.push(
        new Paragraph({
          text: `${cu.id} — ${cu.name}`,
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 180, after: 120 },
        })
      );

      const humanActions = manualInstructions(cu);
      if (humanActions.length === 0) {
        paragraphs.push(
          new Paragraph({
            children: [new TextRun({ text: "Este CU no define acciones en rf-cu.md.", italics: true })],
          })
        );
        continue;
      }

      const evidence = actionScreenshots(rf, cu);
      for (const [actionIndex, action] of humanActions.entries()) {
        const actionEvidence = evidence.filter((item) => item.actionIndex === actionIndex);
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `Acción ${String(actionIndex + 1).padStart(2, "0")}. `,
                bold: true,
              }),
              new TextRun({ text: action }),
            ],
            spacing: { before: 140, after: 100 },
          })
        );
        for (const screenshot of actionEvidence) {
          const loaded = screenshots.get(`${unitId}.${screenshot.evidenceIndex}`);
          if (!loaded) {
            throw new Error(`No se cargó la evidencia ${screenshot.fileName} de ${unitId}.`);
          }
          paragraphs.push(new Paragraph({
            children: [
              new ImageRun({
                type: "png",
                data: loaded.data,
                transformation: { width: loaded.width, height: loaded.height },
              }),
            ],
            alignment: AlignmentType.CENTER,
            spacing: { after: 80 },
          }));
          paragraphs.push(new Paragraph({
            children: [
              new TextRun({
                text: actionEvidence.length > 1
                  ? `Evidencia ${actionIndex + 1}.${screenshot.operationIndex + 1} — ${screenshot.fileName}`
                  : screenshot.fileName,
                italics: true,
                size: 18,
              }),
            ],
            alignment: AlignmentType.CENTER,
            spacing: { after: 160 },
          }));
        }
      }
    }
  });

  const doc = new Document({
    creator: "qa-mcp",
    title: "Plan de Pruebas (ETP)",
    description: "Evidencias E2E organizadas por requisito funcional y caso de uso.",
    sections: [{ properties: {}, children: paragraphs }],
  });
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputPath, await Packer.toBuffer(doc));
  return outputPath;
}
