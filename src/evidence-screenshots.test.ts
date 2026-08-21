import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  actionScreenshots,
  EVIDENCE_SCREENSHOT_HEIGHT,
  EVIDENCE_SCREENSHOT_WIDTH,
  persistScreenshotEvidence,
  screenshotEvidenceDirectory,
} from "./evidence-screenshots";
import { CuCase, LoadedContext, RfEntry } from "./types";

const cu: CuCase = {
  id: "CU-2",
  name: "Valores inválidos",
  steps: ["Abrir", "Seleccionar", "Validar"],
};

const rf: RfEntry = {
  id: "RF-2",
  name: "Campos numéricos",
  methodPath: "ui",
  operationId: "ui-campos-numericos",
  cases: [cu],
};

async function makeWorkspace(t: test.TestContext): Promise<{
  root: string;
  frontendRoot: string;
  context: LoadedContext;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-mcp-evidence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const frontendRoot = path.join(root, "frontend");
  await fs.mkdir(frontendRoot, { recursive: true });
  const context: LoadedContext = {
    configPath: path.join(root, "mcp.config.json"),
    openApiPath: path.join(root, "openapi.yaml"),
    openApiContent: "",
    config: {
      version: 1,
      backend: { root: "backend", language: "java", build: "maven" },
      frontend: { root: frontendRoot, framework: "angular", e2e: "cypress" },
      openApi: "openapi.yaml",
      restTests: "backend/tests",
      e2eTests: "frontend/cypress/e2e",
      evidence: { excelTemplate: "template.xlsx", output: "output" },
    },
  };
  return { root, frontendRoot, context };
}

function png(width: number, height: number, marker: number): Buffer {
  const result = Buffer.alloc(25);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(result, 0);
  result.writeUInt32BE(width, 16);
  result.writeUInt32BE(height, 20);
  result[24] = marker;
  return result;
}

async function writeCypressScreenshot(params: {
  frontendRoot: string;
  baseName: string;
  attempt: number;
  marker?: number;
  width?: number;
  height?: number;
  mtimeMs?: number;
}): Promise<string> {
  const directory = path.join(params.frontendRoot, "cypress", "screenshots", "spec.cy.js");
  await fs.mkdir(directory, { recursive: true });
  const suffix = params.attempt === 1 ? "" : ` (attempt ${params.attempt})`;
  const filePath = path.join(directory, `${params.baseName}${suffix}.png`);
  await fs.writeFile(
    filePath,
    png(
      params.width ?? EVIDENCE_SCREENSHOT_WIDTH,
      params.height ?? EVIDENCE_SCREENSHOT_HEIGHT,
      params.marker ?? params.attempt
    )
  );
  if (params.mtimeMs !== undefined) {
    const timestamp = new Date(params.mtimeMs);
    await fs.utimes(filePath, timestamp, timestamp);
  }
  return filePath;
}

test("persiste el juego completo del retry y no mezcla intentos", async (t) => {
  const { frontendRoot, context } = await makeWorkspace(t);
  const expected = actionScreenshots(rf, cu);
  const runStartedAt = Date.now() - 1000;

  await writeCypressScreenshot({ frontendRoot, baseName: expected[0].baseName, attempt: 1 });
  await writeCypressScreenshot({ frontendRoot, baseName: expected[1].baseName, attempt: 1 });
  for (const screenshot of expected) {
    await writeCypressScreenshot({
      frontendRoot,
      baseName: screenshot.baseName,
      attempt: 2,
      marker: 2,
    });
  }

  const persisted = await persistScreenshotEvidence(
    context,
    frontendRoot,
    rf,
    cu,
    runStartedAt
  );

  assert.deepEqual(
    persisted.map((filePath) => path.basename(filePath)),
    expected.map((screenshot) => screenshot.fileName)
  );
  for (const filePath of persisted) {
    const contents = await fs.readFile(filePath);
    assert.equal(contents[24], 2, `${path.basename(filePath)} debe proceder del segundo intento`);
  }
});

test("genera una evidencia por operación y conserva la acción humana padre", () => {
  const groupedCu: CuCase = {
    id: "CU-2",
    name: "Valores agrupados",
    steps: ["Introducir 15000 en Peso y 120 en Pasajeros.", "Comprobar Importe total visible."],
    actions: [
      {
        id: "A01",
        manual: "Introducir 15000 en Peso y 120 en Pasajeros.",
        automation: [
          {
            id: "A01.1", actionNumber: 1, kind: "set-control", key: "peso",
            controlType: "input", label: "Peso", selector: "#peso input", value: "15000",
          },
          {
            id: "A01.2", actionNumber: 1, kind: "set-control", key: "pasajeros",
            controlType: "input", label: "Pasajeros", selector: "#pasajeros input", value: "120",
          },
        ],
      },
      {
        id: "A02",
        manual: "Comprobar Importe total visible.",
        automation: [
          {
            id: "A02.1", actionNumber: 2, kind: "verify", label: "Importe total",
            selector: "#total", expected: "visible",
          },
        ],
      },
    ],
  };

  const screenshots = actionScreenshots(rf, groupedCu);
  assert.deepEqual(
    screenshots.map((item) => [item.fileName, item.actionIndex, item.operationIndex, item.operation?.id]),
    [
      ["rf2_cu2_01.png", 0, 0, "A01.1"],
      ["rf2_cu2_02.png", 0, 1, "A01.2"],
      ["rf2_cu2_03.png", 1, 0, "A02.1"],
    ]
  );
});

test("rechaza evidencias repartidas entre intentos incompletos", async (t) => {
  const { frontendRoot, context } = await makeWorkspace(t);
  const expected = actionScreenshots(rf, cu);
  await writeCypressScreenshot({ frontendRoot, baseName: expected[0].baseName, attempt: 1 });
  await writeCypressScreenshot({ frontendRoot, baseName: expected[1].baseName, attempt: 2 });
  await writeCypressScreenshot({ frontendRoot, baseName: expected[2].baseName, attempt: 2 });

  await assert.rejects(
    persistScreenshotEvidence(context, frontendRoot, rf, cu),
    (error: unknown) => {
      assert.match(String(error), /último intento no generó el juego completo/i);
      assert.match(String(error), /Intento 1: faltan/);
      assert.match(String(error), /Intento 2: faltan/);
      return true;
    }
  );
});

test("no reutiliza un intento completo anterior si el último quedó incompleto", async (t) => {
  const { frontendRoot, context } = await makeWorkspace(t);
  const expected = actionScreenshots(rf, cu);
  for (const screenshot of expected) {
    await writeCypressScreenshot({ frontendRoot, baseName: screenshot.baseName, attempt: 1 });
  }
  await writeCypressScreenshot({ frontendRoot, baseName: expected[0].baseName, attempt: 2 });
  await writeCypressScreenshot({ frontendRoot, baseName: expected[1].baseName, attempt: 2 });

  await assert.rejects(
    persistScreenshotEvidence(context, frontendRoot, rf, cu),
    (error: unknown) => {
      assert.match(String(error), /último intento no generó el juego completo/i);
      assert.match(String(error), /Intento 1: faltan ninguna/);
      assert.match(String(error), new RegExp(`Intento 2: faltan ${expected[2].fileName}`));
      return true;
    }
  );
});

test("ignora juegos completos obsoletos de ejecuciones anteriores", async (t) => {
  const { frontendRoot, context } = await makeWorkspace(t);
  const expected = actionScreenshots(rf, cu);
  const runStartedAt = Date.now();
  for (const screenshot of expected) {
    await writeCypressScreenshot({
      frontendRoot,
      baseName: screenshot.baseName,
      attempt: 3,
      mtimeMs: runStartedAt - 10_000,
    });
  }
  await writeCypressScreenshot({ frontendRoot, baseName: expected[0].baseName, attempt: 1 });

  await assert.rejects(
    persistScreenshotEvidence(context, frontendRoot, rf, cu, runStartedAt),
    /último intento no generó el juego completo/i
  );
});

test("valida todo el intento antes de persistir para no dejar un lote parcial", async (t) => {
  const { frontendRoot, context } = await makeWorkspace(t);
  const expected = actionScreenshots(rf, cu);
  for (const [index, screenshot] of expected.entries()) {
    await writeCypressScreenshot({
      frontendRoot,
      baseName: screenshot.baseName,
      attempt: 1,
      width: index === expected.length - 1 ? 1280 : EVIDENCE_SCREENSHOT_WIDTH,
      height: index === expected.length - 1 ? 720 : EVIDENCE_SCREENSHOT_HEIGHT,
    });
  }

  await assert.rejects(
    persistScreenshotEvidence(context, frontendRoot, rf, cu),
    /tiene resolución 1280x720/
  );

  const destination = screenshotEvidenceDirectory(context);
  const outputFiles = await fs.readdir(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(outputFiles, []);
});
