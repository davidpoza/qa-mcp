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

interface OpenApiEndpoint {
  method: string;
  path: string;
  operationId: string;
}

interface CuTemplateSeed {
  nameTemplate: string;
  stepTemplates: string[];
}

interface CuTemplateResolved {
  name: string;
  steps: string[];
}

function endpointTokens(endpointPath: string): string[] {
  return endpointPath
    .split("/")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 1 && !part.startsWith("{"))
    .map((part) => part.replace(/[^a-z0-9_-]/g, ""));
}

function routeTokens(route: string): string[] {
  return route
    .split("/")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
    .map((part) => part.replace(/[^a-z0-9_-]/g, ""));
}

function parseOpenApiEndpoints(openApiContent: string): OpenApiEndpoint[] {
  const lines = openApiContent.split("\n");
  const endpoints: OpenApiEndpoint[] = [];

  let currentPath: string | undefined;
  let currentMethod: string | undefined;
  let currentOperationId = "";
  let currentMethodIndent = 0;

  const flushCurrent = () => {
    if (!currentPath || !currentMethod) {
      return;
    }
    endpoints.push({
      method: currentMethod.toUpperCase(),
      path: currentPath,
      operationId:
        currentOperationId || `${currentMethod}_${currentPath.replace(/[^\w]/g, "_")}`.replace(/_+/g, "_"),
    });
    currentMethod = undefined;
    currentOperationId = "";
    currentMethodIndent = 0;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r/g, "");
    const trimmed = line.trim();
    const indent = line.search(/\S|$/);

    const pathMatch = trimmed.match(/^\/[^:]*:\s*$/);
    if (pathMatch && indent <= 4) {
      flushCurrent();
      currentPath = trimmed.slice(0, -1).trim();
      continue;
    }

    const methodMatch = trimmed.match(/^(get|post|put|patch|delete|options|head):\s*$/i);
    if (methodMatch && currentPath) {
      flushCurrent();
      currentMethod = methodMatch[1].toLowerCase();
      currentMethodIndent = indent;
      continue;
    }

    if (currentMethod && indent > currentMethodIndent) {
      const opMatch = trimmed.match(/^operationId:\s*(.+)\s*$/i);
      if (opMatch) {
        currentOperationId = opMatch[1].replace(/^["']|["']$/g, "").trim();
      }
      continue;
    }

    if (currentMethod && indent <= currentMethodIndent && trimmed.length > 0) {
      flushCurrent();
    }
  }

  flushCurrent();
  return endpoints;
}

async function listFrontendSourceFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
          continue;
        }
        await walk(fullPath);
      } else if (/\.(ts|tsx|js|jsx|html)$/i.test(entry.name)) {
        output.push(fullPath);
      }
    }
  };
  await walk(root);
  return output;
}

function scoreRouteAgainstEndpoint(route: string, endpointPath: string): number {
  const routeSet = new Set(routeTokens(route));
  const endpointSet = new Set(endpointTokens(endpointPath));
  let score = 0;
  for (const token of endpointSet) {
    if (routeSet.has(token)) {
      score += 1;
    }
  }
  return score;
}

interface FrontendCorpusEntry {
  path: string;
  content: string;
}

async function buildFrontendCorpus(frontendRoot: string): Promise<FrontendCorpusEntry[]> {
  const srcRoot = path.join(frontendRoot, "src");
  const files = await listFrontendSourceFiles(srcRoot);
  const corpus: FrontendCorpusEntry[] = [];
  for (const file of files) {
    try {
      corpus.push({
        path: file,
        content: (await fs.readFile(file, "utf8")).toLowerCase(),
      });
    } catch {
      continue;
    }
  }
  return corpus;
}

function estimateFrontendEvidence(
  corpus: FrontendCorpusEntry[],
  endpoint: OpenApiEndpoint,
  relatedRoutes: string[]
): { endpointMatches: number; routeMatches: number } {
  const endpointNeedles = [endpoint.path, ...endpointTokens(endpoint.path)].filter((value) => value.length >= 2);
  const routeNeedles = relatedRoutes.flatMap((route) => [route, ...routeTokens(route)]).filter((value) => value.length >= 2);

  let endpointMatches = 0;
  let routeMatches = 0;
  for (const entry of corpus) {
    const content = entry.content;
    if (endpointNeedles.some((needle) => content.includes(needle.toLowerCase()))) {
      endpointMatches += 1;
    }
    if (routeNeedles.some((needle) => content.includes(needle.toLowerCase()))) {
      routeMatches += 1;
    }
  }
  return { endpointMatches, routeMatches };
}

function defaultCuTemplateSeeds(): CuTemplateSeed[] {
  return [
    {
      nameTemplate: "Flujo nominal de {RF_NAME}",
      stepTemplates: [
        "Preparar precondiciones y datos válidos del escenario.",
        "Ejecutar la operación principal vinculada a {METHOD_PATH}.",
        "Validar resultado esperado en backend y UI.",
        "Registrar evidencia del resultado nominal.",
      ],
    },
    {
      nameTemplate: "Validaciones y errores de {RF_NAME}",
      stepTemplates: [
        "Preparar entradas inválidas o incompletas para el escenario.",
        "Intentar ejecutar la operación asociada a {METHOD_PATH}.",
        "Verificar mensajes de validación y restricciones funcionales esperadas.",
        "Registrar evidencia del manejo de error.",
      ],
    },
    {
      nameTemplate: "Consistencia y actualización de {RF_NAME}",
      stepTemplates: [
        "Ejecutar nuevamente el escenario con una variación relevante de datos.",
        "Capturar valores clave de la respuesta API y de la UI para {METHOD_PATH}.",
        "Verificar coherencia entre datos recibidos y datos mostrados.",
        "Registrar evidencia comparativa del resultado.",
      ],
    },
  ];
}

function replaceTemplateVars(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

function resolveCuTemplates(seeds: CuTemplateSeed[], vars: Record<string, string>): CuTemplateResolved[] {
  return seeds.map((seed) => ({
    name: replaceTemplateVars(seed.nameTemplate, vars),
    steps: seed.stepTemplates.map((step) => replaceTemplateVars(step, vars)),
  }));
}

function parsePromptCuSeeds(content: string): CuTemplateSeed[] {
  const lines = content.split("\n").map((line) => line.replace(/\r/g, "").trim());
  const map = new Map<number, { nameTemplate?: string; stepTemplates: string[] }>();
  for (const line of lines) {
    const nameMatch = line.match(/^CU([1-9])_NAME:\s*(.+)$/i);
    if (nameMatch) {
      const index = Number(nameMatch[1]);
      const current = map.get(index) ?? { stepTemplates: [] };
      current.nameTemplate = nameMatch[2].trim();
      map.set(index, current);
      continue;
    }
    const stepMatch = line.match(/^CU([1-9])_STEP([1-9]):\s*(.+)$/i);
    if (stepMatch) {
      const index = Number(stepMatch[1]);
      const stepIndex = Number(stepMatch[2]) - 1;
      const current = map.get(index) ?? { stepTemplates: [] };
      current.stepTemplates[stepIndex] = stepMatch[3].trim();
      map.set(index, current);
    }
  }
  const seeds: CuTemplateSeed[] = [];
  for (let index = 1; index <= 3; index += 1) {
    const current = map.get(index);
    if (!current?.nameTemplate || current.stepTemplates.length < 4) {
      return defaultCuTemplateSeeds();
    }
    seeds.push({
      nameTemplate: current.nameTemplate,
      stepTemplates: current.stepTemplates.slice(0, 4),
    });
  }
  return seeds;
}

async function loadRfCuTemplateSeeds(context: LoadedContext): Promise<CuTemplateSeed[]> {
  const configRoot = path.dirname(context.configPath);
  const promptPathRaw = context.config.prompts?.rfcu;
  const defaultPromptPath = path.resolve(__dirname, "..", "prompts", "rfcu.md");
  const promptPath = promptPathRaw
    ? (path.isAbsolute(promptPathRaw) ? promptPathRaw : path.resolve(configRoot, promptPathRaw))
    : defaultPromptPath;
  try {
    const content = await fs.readFile(promptPath, "utf8");
    return parsePromptCuSeeds(content);
  } catch {
    return defaultCuTemplateSeeds();
  }
}

function buildRfFromEndpoint(
  endpoint: OpenApiEndpoint,
  index: number,
  relatedRoutes: string[],
  evidence: { endpointMatches: number; routeMatches: number },
  templateSeeds: CuTemplateSeed[]
): RfEntry {
  const routeText = relatedRoutes.length > 0 ? relatedRoutes.join(", ") : "sin ruta directa";
  const frontEvidenceText = `${evidence.endpointMatches} ficheros endpoint / ${evidence.routeMatches} ficheros ruta`;
  const readableName = endpoint.operationId
    ? endpoint.operationId.replace(/[_-]+/g, " ").trim()
    : `${endpoint.method} ${endpoint.path}`;
  const resolved = resolveCuTemplates(templateSeeds, {
    RF_NAME: readableName,
    METHOD_PATH: `${endpoint.method} ${endpoint.path}`,
    OPERATION_ID: endpoint.operationId,
    ROUTES: routeText,
    FRONT_EVIDENCE: frontEvidenceText,
  });

  return {
    id: `RF-${String(index + 1).padStart(2, "0")}`,
    name: readableName.charAt(0).toUpperCase() + readableName.slice(1),
    methodPath: `${endpoint.method} ${endpoint.path}`,
    operationId: endpoint.operationId,
    cases: [
      {
        id: "CU-1",
        name: resolved[0].name,
        steps: resolved[0].steps,
      },
      {
        id: "CU-2",
        name: resolved[1].name,
        steps: resolved[1].steps,
      },
      {
        id: "CU-3",
        name: resolved[2].name,
        steps: resolved[2].steps,
      },
    ],
  };
}

async function buildRfFromOpenApiAndFrontend(
  context: LoadedContext,
  routes: string[],
  templateSeeds: CuTemplateSeed[]
): Promise<RfEntry[]> {
  const endpoints = parseOpenApiEndpoints(context.openApiContent);
  if (endpoints.length === 0) {
    return [];
  }
  const configRoot = path.dirname(context.configPath);
  const frontendRoot = path.resolve(configRoot, context.config.frontend.root);
  const corpus = await buildFrontendCorpus(frontendRoot);
  const output: RfEntry[] = [];

  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index];
    const scored = routes
      .map((route) => ({ route, score: scoreRouteAgainstEndpoint(route, endpoint.path) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    const relatedRoutes = scored.map((entry) => entry.route);
    const evidence = estimateFrontendEvidence(corpus, endpoint, relatedRoutes);
    output.push(buildRfFromEndpoint(endpoint, index, relatedRoutes, evidence, templateSeeds));
  }
  return output;
}

function ensureCasesAndSteps(rfEntries: RfEntry[], templateSeeds: CuTemplateSeed[]): RfEntry[] {
  return rfEntries.map((rf) => {
    const minimumCuCount = 3;
    const baseCases = rf.cases.length > 0 ? [...rf.cases] : [{ id: "CU-1", name: `Validación de ${rf.name}`, steps: [] }];
    const templates = resolveCuTemplates(templateSeeds, {
      RF_NAME: rf.name,
      METHOD_PATH: rf.methodPath,
      OPERATION_ID: rf.operationId,
      ROUTES: "sin ruta directa",
      FRONT_EVIDENCE: "sin evidencia",
    });
    while (baseCases.length < minimumCuCount) {
      const template = templates[baseCases.length] ?? templates[templates.length - 1] ?? templates[0];
      baseCases.push({
        id: `CU-${baseCases.length + 1}`,
        name: template.name,
        steps: template.steps,
      });
    }

    const completedCases = baseCases.map((cu, index) => {
      const steps = cu.steps.length > 0
        ? cu.steps
        : (templates[index]?.steps ?? templates[0].steps);
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
  const normalized = ensureCasesAndSteps(entries, defaultCuTemplateSeeds());
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
  const templateSeeds = await loadRfCuTemplateSeeds(context);

  let entries: RfEntry[] = [];
  const existing = await readTextIfExists(outputPath);
  if (existing) {
    entries = parseRfCu(existing);
  }
  if (entries.length === 0) {
    const generatedFromOpenApi = await buildRfFromOpenApiAndFrontend(context, routes, templateSeeds);
    entries = generatedFromOpenApi.length > 0 ? generatedFromOpenApi : [];
  }
  if (entries.length === 0) {
    entries = [
      {
        id: "RF-01",
        name: "Flujo principal",
        methodPath: "OPENAPI-CONTEXT",
        operationId: "derivado-del-contexto",
        cases: resolveCuTemplates(templateSeeds, {
          RF_NAME: "flujo principal",
          METHOD_PATH: "OPENAPI-CONTEXT",
          OPERATION_ID: "derivado-del-contexto",
          ROUTES: "sin ruta directa",
          FRONT_EVIDENCE: "sin evidencia",
        }).map((template, index) => ({
          id: `CU-${index + 1}`,
          name: template.name,
          steps: template.steps,
        })),
      },
    ];
  }

  const rendered = renderRfCu(ensureCasesAndSteps(entries, templateSeeds), sourceOpenApi, sourceFront);
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
      return ensureCasesAndSteps(parsed, defaultCuTemplateSeeds());
    }
  }
  return ensureCasesAndSteps([
    {
      id: "RF-01",
      name: "Flujo principal",
      methodPath: "OPENAPI-CONTEXT",
      operationId: "derivado-del-contexto",
      cases: [],
    },
  ], defaultCuTemplateSeeds());
}
