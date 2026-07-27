import { promises as fs } from "node:fs";
import path from "node:path";
import { LoadedContext, RfEntry } from "./types";

function normalizeLine(line: string): string {
  return line.replace(/\r/g, "").trimEnd();
}

function rfHeaderRegex(): RegExp {
  return /^\d+\.\s+\*\*(RF-\d+)\s+—\s+(.+)\*\*\s+\(`([^`]+)`,\s*`([^`]+)`\)\./;
}

function cuRegex(): RegExp {
  return /^-\s+\*\*(CU-\d+):\s+(.+)\.\*\*/;
}

function stepRegex(): RegExp {
  return /^\d+\.\s+(.+)/;
}

export function parseRfCu(content: string): RfEntry[] {
  const lines = content.split("\n").map(normalizeLine);
  const rfEntries: RfEntry[] = [];
  let currentRf: RfEntry | undefined;
  let currentCuIndex = -1;

  for (const line of lines) {
    const rfMatch = line.match(rfHeaderRegex());
    if (rfMatch) {
      const [, id, name, methodPath, operationId] = rfMatch;
      currentRf = {
        id,
        name,
        methodPath,
        operationId,
        cases: [],
      };
      rfEntries.push(currentRf);
      currentCuIndex = -1;
      continue;
    }

    const cuMatch = line.match(cuRegex());
    if (cuMatch && currentRf) {
      const [, id, name] = cuMatch;
      currentRf.cases.push({ id, name, steps: [] });
      currentCuIndex = currentRf.cases.length - 1;
      continue;
    }

    const stepMatch = line.match(stepRegex());
    if (stepMatch && currentRf && currentCuIndex >= 0) {
      currentRf.cases[currentCuIndex].steps.push(stepMatch[1]);
    }
  }

  return rfEntries;
}

function fallbackRfFromRoutes(routes: string[]): RfEntry[] {
  if (routes.length === 0) {
    return [
      {
        id: "RF-01",
        name: "Flujo principal",
        methodPath: "OPENAPI-CONTEXT",
        operationId: "derivado-del-contexto",
        cases: [
          {
            id: "CU-1",
            name: "Ejecutar flujo base",
            steps: [
              "Preparar datos de prueba y contexto.",
              "Ejecutar el flujo principal desde la interfaz.",
              "Validar respuesta visible y estado de backend.",
              "Registrar evidencia del resultado.",
            ],
          },
        ],
      },
    ];
  }

  return routes.map((route, index) => ({
    id: `RF-${String(index + 1).padStart(2, "0")}`,
    name: `Navegación a ${route}`,
    methodPath: "OPENAPI-CONTEXT",
    operationId: `route_${route.replace(/[^\w]/g, "_") || "root"}`,
    cases: [
      {
        id: "CU-1",
        name: `Validar acceso a ${route}`,
        steps: [
          `Abrir la ruta ${route}.`,
          "Completar la acción principal de la pantalla.",
          "Verificar comportamiento esperado en UI.",
          "Registrar evidencia de resultado y datos clave.",
        ],
      },
    ],
  }));
}

function ensureCasesAndSteps(rfEntries: RfEntry[]): RfEntry[] {
  return rfEntries.map((rf) => {
    const cases = rf.cases.length > 0 ? rf.cases : [{ id: "CU-1", name: `Validación de ${rf.name}`, steps: [] }];

    const completedCases = cases.map((cu, index) => {
      const steps = cu.steps.length > 0
        ? cu.steps
        : [
            "Preparar precondiciones y datos necesarios.",
            "Ejecutar la acción principal del caso de uso.",
            "Validar resultado esperado con criterios verificables.",
            "Registrar evidencia del resultado.",
          ];
      return {
        id: `CU-${index + 1}`,
        name: cu.name,
        steps,
      };
    });

    return {
      ...rf,
      cases: completedCases,
    };
  });
}

export function renderRfCu(entries: RfEntry[], sourceOpenApi: string, sourceFront: string, scope = "General"): string {
  const normalized = ensureCasesAndSteps(entries);
  const lines: string[] = [];
  lines.push(`# Requisitos funcionales (RF) y casos de uso (CU) — ${scope}`);
  lines.push("");
  lines.push(`> Fuente de RF: ${sourceOpenApi}`);
  lines.push(`> Derivación de CU: ${sourceFront}`);
  lines.push("");

  normalized.forEach((rf, rfIndex) => {
    lines.push(`${rfIndex + 1}. **${rf.id} — ${rf.name}** (\`${rf.methodPath}\`, \`${rf.operationId}\`).`);
    lines.push("");
    rf.cases.forEach((cu, cuIndex) => {
      lines.push(`- **CU-${cuIndex + 1}: ${cu.name}.**`);
      cu.steps.forEach((step, stepIndex) => {
        lines.push(`  ${stepIndex + 1}. ${step}`);
      });
      lines.push("");
    });
  });

  return `${lines.join("\n").trim()}\n`;
}

function resolveRoutingPath(context: LoadedContext): string {
  const configRoot = path.dirname(context.configPath);
  if (context.config.appRouting) {
    if (path.isAbsolute(context.config.appRouting)) {
      return context.config.appRouting;
    }
    return path.resolve(configRoot, context.config.appRouting);
  }
  const frontendRoot = path.resolve(configRoot, context.config.frontend.root);
  return path.join(frontendRoot, "src", "app", "app-routing.module.ts");
}

async function tryReadRoutes(routingPath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(routingPath, "utf8");
    const matches = [...content.matchAll(/path:\s*['"`]([^'"`]+)['"`]/g)];
    const unique = new Set<string>();
    for (const match of matches) {
      const value = match[1].trim();
      if (value.length > 0) {
        unique.add(`/${value}`);
      }
    }
    return Array.from(unique);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function autoCompleteRfCu(context: LoadedContext, requirementsPathOverride?: string): Promise<{ outputPath: string; count: number }> {
  const outputPath = requirementsPathOverride
    ? path.resolve(process.cwd(), requirementsPathOverride)
    : context.requirementsPath ?? path.resolve(path.dirname(context.configPath), "docs", "rf-cu.md");

  const sourceOpenApi = context.openApiPath;
  const routingPath = resolveRoutingPath(context);
  const sourceFront = routingPath;
  const routes = await tryReadRoutes(routingPath);

  let entries: RfEntry[] = [];
  const existing = await readTextIfExists(outputPath);
  if (existing) {
    entries = parseRfCu(existing);
  }
  if (entries.length === 0) {
    entries = fallbackRfFromRoutes(routes);
  }

  const rendered = renderRfCu(entries, sourceOpenApi, sourceFront);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, rendered, "utf8");
  return { outputPath, count: entries.length };
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function extractOrBuildRfEntries(context: LoadedContext): RfEntry[] {
  if (context.requirementsContent) {
    const parsed = parseRfCu(context.requirementsContent);
    if (parsed.length > 0) {
      return ensureCasesAndSteps(parsed);
    }
  }
  return ensureCasesAndSteps(fallbackRfFromRoutes([]));
}
