import { promises as fs } from "node:fs";
import path from "node:path";
import { CuCase, LoadedContext, RfEntry } from "./types";

/**
 * Firma de la función de muestreo LLM (MCP sampling).
 * La implementa el servidor MCP delegando en el modelo del cliente
 * (p. ej. Copilot vía `server.createMessage`).
 */
export type SampleFn = (prompt: string, maxTokens?: number) => Promise<string>;

function normalizeLine(line: string): string {
  return line.replace(/\r/g, "").trimEnd();
}

function rfHeaderRegex(): RegExp {
  // Acepta uno o varios pares endpoint/operationId separados por `;`.
  return /^\d+\.\s+\*\*(RF-\d+)\s+—\s+(.+)\*\*\s+\((.+)\)\.\s*$/;
}

function cuRegex(): RegExp {
  return /^-\s+\*\*(CU-\d+):\s+(.+)\.\*\*/;
}

function stepRegex(): RegExp {
  return /^\d+\.\s+(.+)/;
}

function inputValuesHeaderRegex(): RegExp {
  return /^\s*-\s+\*\*Valores de (?:controles|inputs):\*\*\s*$/i;
}

function inputValueRegex(): RegExp {
  return /^\s+-\s+`([^`]+)`\s+\|\s+(?:tipo\s+`(input|select|checkbox)`\s+\|\s+)?selector\s+`([^`]+)`\s+\|\s+valor\s+`([^`]+)`(?:\s+\|\s+acción\s+`(\d{2})`)?\s*\.?\s*$/i;
}

function noInputValuesRegex(): RegExp {
  return /^\s+-\s+Ninguno\.\s*$/i;
}

/**
 * Parsea un rf-cu.md ya existente al modelo `RfEntry[]`.
 * Lo usan los generadores de tests (rest/e2e) para construir artefactos.
 */
export function parseRfCu(content: string): RfEntry[] {
  const lines = content.split("\n").map(normalizeLine);
  const rfEntries: RfEntry[] = [];
  let currentRf: RfEntry | undefined;
  let currentCuIndex = -1;

  for (const line of lines) {
    const rfMatch = line.match(rfHeaderRegex());
    if (rfMatch) {
      const [, id, name, endpointBlock] = rfMatch;
      const quotedValues = [...endpointBlock.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
      const methodPath = quotedValues.filter((_, index) => index % 2 === 0).join("; ") || endpointBlock.trim();
      const operationId = quotedValues.filter((_, index) => index % 2 === 1).join("; ") || "sin-operation-id";
      currentRf = { id, name, methodPath, operationId, cases: [] };
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

    if (inputValuesHeaderRegex().test(line) && currentRf && currentCuIndex >= 0) {
      currentRf.cases[currentCuIndex].inputValues = [];
      continue;
    }

    const inputValueMatch = line.match(inputValueRegex());
    if (inputValueMatch && currentRf && currentCuIndex >= 0) {
      const inputValues = currentRf.cases[currentCuIndex].inputValues;
      if (inputValues) {
        const [, key, kind, selector, value, actionNumber] = inputValueMatch;
        inputValues.push({
          key: key.trim(),
          kind: kind ? kind.toLowerCase() as "input" | "select" | "checkbox" : undefined,
          selector: selector.trim(),
          value,
          actionNumber: actionNumber ? Number(actionNumber) : undefined,
        });
      }
      continue;
    }

    if (noInputValuesRegex().test(line) && currentRf && currentCuIndex >= 0) {
      continue;
    }

    const stepMatch = line.trim().match(stepRegex());
    if (stepMatch && currentRf && currentCuIndex >= 0) {
      currentRf.cases[currentCuIndex].steps.push(stepMatch[1]);
    }
  }

  return rfEntries;
}

/**
 * Valida la relación 1:1 entre controles documentados y acciones. Una acción que
 * escriba varios controles sólo produciría una captura del último, por lo que
 * cada control debe tener su propio número de acción.
 */
export function inputActionContractErrors(rfId: string, cu: CuCase): string[] {
  if (cu.inputValues === undefined) return [];
  const errors: string[] = [];
  const usedActions = new Set<number>();
  let previousAction = 0;

  for (const input of cu.inputValues) {
    const action = input.actionNumber;
    const label = `${rfId}.${cu.id} control ${input.key}`;
    if (!input.kind) {
      errors.push(`${label}: falta el tipo obligatorio input/select/checkbox`);
    }
    if (!Number.isInteger(action) || !action || action < 1 || action > cu.steps.length) {
      errors.push(`${label}: falta una acción NN válida dentro del rango 01-${String(cu.steps.length).padStart(2, "0")}`);
      continue;
    }
    if (usedActions.has(action)) {
      errors.push(`${label}: la acción ${String(action).padStart(2, "0")} ya pertenece a otro control; cada control necesita su propia acción/captura`);
    }
    if (action <= previousAction) {
      errors.push(`${label}: las entradas deben listarse en el mismo orden ascendente que sus acciones`);
    }
    usedActions.add(action);
    previousAction = action;

    const step = cu.steps[action - 1] ?? "";
    if (!step.includes(input.selector) || !step.includes(input.value)) {
      errors.push(
        `${label}: la acción ${String(action).padStart(2, "0")} debe mencionar literalmente el selector ` +
          `\`${input.selector}\` y el valor \`${input.value}\``
      );
    }
  }

  const declaredActions = new Set(
    cu.inputValues
      .map((control) => control.actionNumber)
      .filter((action): action is number => Number.isInteger(action))
  );
  const valueInteraction = /\b(?:ingresar|introducir|escribir|rellenar|seleccionar|elegir|marcar|desmarcar|establecer|cambiar\s+(?:el|la)?\s*(?:valor|categoría|idioma))\b/i;
  cu.steps.forEach((step, index) => {
    const action = index + 1;
    if (valueInteraction.test(step) && !declaredActions.has(action)) {
      errors.push(
        `${rfId}.${cu.id} acción ${String(action).padStart(2, "0")}: interactúa con un control con valor/estado, ` +
          "pero no existe una entrada en `Valores de controles` para documentar y capturar ese dato de prueba"
      );
    }
  });
  return errors;
}

interface OpenApiEndpoint {
  method: string;
  path: string;
  operationId: string;
}

/**
 * Extrae endpoints (método + path + operationId) de un openapi.yaml.
 * Extracción estructural mínima basada en indentación; no interpreta semántica.
 */
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

function extractOpenApiTitle(openApiContent: string): string | undefined {
  const match = openApiContent.match(/^\s{2,}title:\s*(.+)$/m);
  if (!match) {
    return undefined;
  }
  return match[1].replace(/^["']|["']$/g, "").trim() || undefined;
}

function resolveRoutingPath(context: LoadedContext): string | undefined {
  const configRoot = path.dirname(context.configPath);
  if (context.config.appRouting) {
    if (path.isAbsolute(context.config.appRouting)) {
      return context.config.appRouting;
    }
    return path.resolve(configRoot, context.config.appRouting);
  }
  if (!context.config.frontend.root) {
    return undefined;
  }
  const frontendRoot = path.resolve(configRoot, context.config.frontend.root);
  return path.join(frontendRoot, "src", "app", "app-routing.module.ts");
}

async function tryReadRoutes(routingPath: string | undefined): Promise<string[]> {
  if (!routingPath) {
    return [];
  }
  try {
    const content = await fs.readFile(routingPath, "utf8");
    const matches = [...content.matchAll(/path:\s*['"`]([^'"`]*)['"`]/g)];
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const match of matches) {
      const value = `/${match[1].trim()}`.replace(/\/+/g, "/");
      if (!seen.has(value)) {
        seen.add(value);
        unique.push(value);
      }
    }
    return unique;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return [];
    }
    throw error;
  }
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
        if (["node_modules", "dist", ".git", ".angular", "coverage"].includes(entry.name)) {
          continue;
        }
        await walk(fullPath);
      } else if (/\.(ts|html)$/i.test(entry.name) && !/\.spec\.ts$/i.test(entry.name)) {
        output.push(fullPath);
      }
    }
  };
  await walk(root);
  return output;
}

/**
 * Puntúa un fichero por su utilidad para inferir casos de uso.
 * Prioriza estructura Angular genérica (componentes, páginas, rutas, servicios),
 * sin ningún conocimiento del dominio concreto de la aplicación.
 */
function rankFrontendFile(filePath: string): number {
  const lower = filePath.toLowerCase();
  let score = 0;
  if (/routing|routes/.test(lower)) score += 6;
  if (/\.component\.(ts|html)$/.test(lower)) score += 5;
  if (/(page|view|screen|container)/.test(lower)) score += 4;
  if (/\.service\.ts$/.test(lower)) score += 3;
  if (/\.html$/.test(lower)) score += 2;
  if (/(environment|polyfill|main\.ts|\.module\.ts$)/.test(lower)) score -= 2;
  return score;
}

/**
 * Construye un paquete de código frontend acotado (con límites de tamaño)
 * que se entrega al LLM como fuente para estimar los casos de uso.
 */
async function buildFrontendCodeBundle(
  frontendRoot: string,
  maxTotalChars = 40000,
  maxPerFile = 3000
): Promise<string> {
  const srcRoot = path.join(frontendRoot, "src");
  const files = await listFrontendSourceFiles(srcRoot);
  files.sort((a, b) => rankFrontendFile(b) - rankFrontendFile(a));

  const parts: string[] = [];
  let total = 0;
  for (const file of files) {
    if (total >= maxTotalChars) {
      break;
    }
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    if (content.trim().length === 0) {
      continue;
    }
    const truncated = content.length > maxPerFile ? `${content.slice(0, maxPerFile)}\n/* ...truncado... */` : content;
    const rel = path.relative(frontendRoot, file).replace(/\\/g, "/");
    const block = `\n### ${rel}\n\`\`\`\n${truncated}\n\`\`\`\n`;
    if (total + block.length > maxTotalChars) {
      break;
    }
    parts.push(block);
    total += block.length;
  }

  return parts.length > 0 ? parts.join("") : "(sin código frontend disponible)";
}

function formatEndpointsForPrompt(endpoints: OpenApiEndpoint[]): string {
  if (endpoints.length === 0) {
    return "(no se detectaron endpoints en openapi)";
  }
  return endpoints.map((endpoint) => `- ${endpoint.method} ${endpoint.path} (${endpoint.operationId})`).join("\n");
}

function formatRoutesForPrompt(routes: string[]): string {
  if (routes.length === 0) {
    return "(no se detectaron rutas de enrutado)";
  }
  return routes.map((route) => `- ${route}`).join("\n");
}

function fillPromptTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

async function loadRfCuPrompt(context: LoadedContext): Promise<string> {
  const configRoot = path.dirname(context.configPath);
  const promptPathRaw = context.config.prompts?.rfcu;
  const defaultPromptPath = path.resolve(__dirname, "..", "prompts", "rfcu.md");
  const promptPath = promptPathRaw
    ? path.isAbsolute(promptPathRaw)
      ? promptPathRaw
      : path.resolve(configRoot, promptPathRaw)
    : defaultPromptPath;
  return fs.readFile(promptPath, "utf8");
}

/**
 * Elimina vallas de código (```), encabezados de lenguaje y texto sobrante
 * que el LLM pudiera añadir alrededor del markdown final.
 */
function sanitizeGeneratedMarkdown(raw: string): string {
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  const titleIndex = text.indexOf("# Requisitos funcionales");
  if (titleIndex > 0) {
    text = text.slice(titleIndex).trim();
  }
  return `${text}\n`;
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

/**
 * Construye el prompt de autocompletado de rf-cu.md (RF desde endpoints
 * OpenAPI + rutas de enrutado; CU inferidos del código frontend real) y
 * resuelve la ruta de salida. No usa sampling: lo comparten el modo sampling
 * (`autoCompleteRfCu`) y el modo ASISTIDO (fallback sin sampling).
 */
export async function buildRfCuPrompt(
  context: LoadedContext,
  requirementsPathOverride?: string
): Promise<{ outputPath: string; prompt: string }> {
  const configRoot = path.dirname(context.configPath);
  const outputPath = requirementsPathOverride
    ? path.resolve(process.cwd(), requirementsPathOverride)
    : context.requirementsPath ?? path.resolve(configRoot, "docs", "rf-cu.md");

  const endpoints = parseOpenApiEndpoints(context.openApiContent);
  const routingPath = resolveRoutingPath(context);
  const routes = await tryReadRoutes(routingPath);
  const hasFrontend = Boolean(context.config.frontend.root);
  const frontendRoot = hasFrontend
    ? path.resolve(configRoot, context.config.frontend.root as string)
    : undefined;
  const frontendCode = frontendRoot
    ? await buildFrontendCodeBundle(frontendRoot)
    : "(no se configuró frontend.root en mcp.config.json; no hay código de UI que analizar)";
  const existing = (await readTextIfExists(outputPath))?.trim();

  const frontSource = routes.length > 0 && routingPath
    ? routingPath
    : frontendRoot ?? "(sin frontend; RF derivados de OpenAPI)";

  const modeNote = hasFrontend
    ? "MODO UI-FIRST: hay frontend configurado (`frontend.root`). Deriva los RF y CU de lo que el usuario puede reproducir DESDE LA UI (rutas, componentes, acciones); usa OpenAPI SOLO como referencia. NO cubras endpoints que la UI no invoca."
    : "MODO SIN FRONTEND (fallback): NO se definió `frontend.root` en mcp.config.json, así que NO hay UI que analizar. En este caso INFIERE los RF DIRECTAMENTE a partir de los endpoints de OpenAPI (normalmente un RF por operación relevante, agrupando por recurso/funcionalidad) y define CU verificables a nivel de comportamiento esperado de cada endpoint (nominal, validación/errores 4xx, vacío/404). La trazabilidad RF↔endpoint es directa. Ignora las secciones de UI/rutas de abajo si vienen vacías.";

  const scope = extractOpenApiTitle(context.openApiContent) ?? "General";
  const promptTemplate = await loadRfCuPrompt(context);
  const basePrompt = fillPromptTemplate(promptTemplate, {
    MODE_NOTE: modeNote,
    SCOPE: scope,
    OPENAPI_SOURCE: context.openApiPath,
    FRONT_SOURCE: frontSource,
    OPENAPI_ENDPOINTS: formatEndpointsForPrompt(endpoints),
    ROUTES: formatRoutesForPrompt(routes),
    FRONTEND_CODE: frontendCode,
    EXISTING_RFCU: existing && existing.length > 0 ? existing : "(no existe; genéralo desde cero)",
  });
  const prompt = [
    basePrompt.trimEnd(),
    "",
    "--- CONTRATO INVARIANTE DE DATOS DE PRUEBA (OBLIGATORIO, incluso si prompts.rfcu es personalizado) ---",
    "Debajo del título de CADA CU incluye exactamente `  - **Valores de controles:**`.",
    "Por cada input, textarea, select/dropdown o checkbox cuyo valor/estado intervenga en el CU, añade una línea con este formato exacto:",
    "    - `<clave-baseline>` | tipo `<input|select|checkbox>` | selector `<selector-css-literal>` | valor `<valor-literal>` | acción `<NN>`",
    "En selects documenta el TEXTO VISIBLE exacto de la opción; en checkbox usa `true` o `false`. Usa una clave única, un selector literal del frontend y el número de dos dígitos de la acción que establece o verifica EXCLUSIVAMENTE ese control.",
    "Cada interacción de UI debe ser una acción independiente: nunca agrupes varios inputs, dropdowns, clicks o acordeones en un mismo paso, porque cada elemento necesita su propia captura.",
    "Si el CU no utiliza ningún control con valor/estado, añade exactamente `    - Ninguno.`. No uses expresiones ambiguas como «un valor válido» ni omitas dropdowns por no ser inputs de texto.",
    "Este bloque es el contrato que generateE2ETests validará contra setDocumentedControl, las capturas y e2e-baseline.json.",
    "--- FIN CONTRATO INVARIANTE ---",
    "",
  ].join("\n");

  return { outputPath, prompt };
}

/**
 * Autocompleta rf-cu.md de forma genérica:
 *  - Infiere los RF a partir de los endpoints OpenAPI + rutas de enrutado.
 *  - Estima los CU delegando en el LLM del cliente (MCP sampling), que analiza
 *    el código frontend real. No usa plantillas ni heurísticas de dominio.
 */
export async function autoCompleteRfCu(
  context: LoadedContext,
  sample: SampleFn,
  requirementsPathOverride?: string
): Promise<{ outputPath: string; count: number }> {
  const { outputPath, prompt } = await buildRfCuPrompt(context, requirementsPathOverride);

  const generated = await sample(prompt, 16000);
  if (!generated || generated.trim().length === 0) {
    throw new Error(
      "El modelo no devolvió contenido para rf-cu.md. Verifica que el cliente MCP soporte sampling (createMessage)."
    );
  }

  const markdown = sanitizeGeneratedMarkdown(generated);
  const parsed = parseRfCu(markdown);
  const missingInputDeclarations = parsed.flatMap((rf) =>
    rf.cases
      .filter((cu) => cu.inputValues === undefined)
      .map((cu) => `${rf.id}.${cu.id}`)
  );
  if (missingInputDeclarations.length > 0) {
    throw new Error(
      "El rf-cu.md generado no declara el bloque obligatorio `Valores de controles` en: " +
        missingInputDeclarations.join(", ") +
        ". Cada CU debe enumerar tipo, clave, selector y valor de todos los controles con datos de prueba, o indicar `Ninguno`."
    );
  }
  const duplicateInputKeys = parsed.flatMap((rf) =>
    rf.cases.flatMap((cu) => {
      const keys = cu.inputValues?.map((input) => input.key) ?? [];
      return new Set(keys).size === keys.length ? [] : [`${rf.id}.${cu.id}`];
    })
  );
  if (duplicateInputKeys.length > 0) {
    throw new Error(
      "El rf-cu.md generado repite claves de control dentro de estos CU: " +
        duplicateInputKeys.join(", ") +
        ". Cada valor/estado de prueba debe tener una clave de baseline única."
    );
  }
  const inputActionErrors = parsed.flatMap((rf) =>
    rf.cases.flatMap((cu) => inputActionContractErrors(rf.id, cu))
  );
  if (inputActionErrors.length > 0) {
    throw new Error(
      "El rf-cu.md generado no garantiza una captura independiente por control con datos de prueba:\n- " +
        inputActionErrors.join("\n- ")
    );
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, markdown, "utf8");

  const count = parsed.length;
  return { outputPath, count };
}

/**
 * Devuelve RF/CU a partir de un rf-cu.md existente (para generar tests).
 * Si no hay requisitos, entrega una entrada mínima genérica de arranque.
 */
export function extractOrBuildRfEntries(context: LoadedContext): RfEntry[] {
  if (context.requirementsContent) {
    const parsed = parseRfCu(context.requirementsContent);
    if (parsed.length > 0) {
      return parsed;
    }
  }
  return [
    {
      id: "RF-01",
      name: "Flujo principal",
      methodPath: "OPENAPI-CONTEXT",
      operationId: "derivado-del-contexto",
      cases: [
        {
          id: "CU-1",
          name: "Validación del flujo principal",
          steps: [
            "Acceder al módulo asociado y preparar datos válidos del escenario.",
            "Ejecutar la operación principal del flujo.",
            "Verificar la respuesta esperada en API y su reflejo en la interfaz.",
            "Registrar evidencia del resultado obtenido.",
          ],
        },
      ],
    },
  ];
}
