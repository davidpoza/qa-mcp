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

const baselineFixtureRelativePath = "cypress/fixtures/e2e-baseline.json";
const baselineSupportRelativePath = "cypress/support/e2e-baseline.js";

/**
 * Firma de la función de muestreo LLM (MCP sampling) para generación E2E.
 */
export type E2ESampleFn = (prompt: string, maxTokens?: number) => Promise<string>;

interface FrontendSource {
  rel: string;
  content: string;
}

function endpointPathFromMethodPath(methodPath: string): string {
  const match = methodPath.match(/^[A-Z]+\s+(.+)$/);
  return match ? match[1].trim() : methodPath.trim();
}

/**
 * Deriva un patrón glob de intercept a partir de un path OpenAPI:
 * los parámetros `{x}` se sustituyen por `*` y se antepone `**` para
 * ser agnóstico al host del API. Ej: /sales/{saleId}/airports → **‍/sales/*‍/airports*
 */
function interceptGlobFromPath(endpointPath: string): string {
  const normalized = endpointPath
    .replace(/\{[^}]+\}/g, "*")
    .replace(/\/+/g, "/");
  return `**${normalized}*`;
}

/**
 * Resumen de la API de helpers genéricos disponibles en
 * `cypress/support/e2e-helpers.js` (para que el LLM los reutilice).
 */
function helperApiSummary(): string {
  return [
    "- `persistOrAssertBaseline(key, currentSnapshot, options?)`: autocaptura/compara el snapshot en el baseline.",
    "- `normalizeAmount(text)`: convierte importes/textos numéricos (con € y separadores) a número.",
    "- `findMatchingOption($options, textoOValor)`: localiza una <option> por texto o value.",
    "- `resolveNativeSelect(rootSelector)`: resuelve el `<select>` nativo aunque `rootSelector` apunte a un componente contenedor (custom control que envuelve un `<select>`, p. ej. un web component). Devuelve el `<select>` real (vía cy.then).",
    "- `getSelectOptions(rootSelector)`: devuelve (vía cy.then) `[{value,text,disabled}]` SIN esperar a que existan opciones. ÚSALO para aserciones de estado vacío/negativas (no cuelga).",
    "- `waitForSelectableOptions(rootSelector, minCount=1)`: espera (reintentable) a que el desplegable tenga opciones SELECCIONABLES (las options se rellenan de forma asíncrona tras la respuesta del backend) y devuelve entonces su snapshot. ÚSALO en escenarios NOMINALES antes de leer/validar opciones. NO uses `getSelectOptions` para afirmar que HAY opciones: leería demasiado pronto (0).",
    "- `selectRequiredOptionByTextOrValue(rootSelector, textoOValor)`: valida que existe y selecciona (resuelve el select nativo internamente).",
    "- `selectOptionByTextOrValueIfPresent(rootSelector, textoOValor)`: selecciona si existe.",
    "- `selectFirstSelectableOption(rootSelector)`: selecciona la primera opción válida.",
    "- `setInputValue(inputSelector, value)`: rellena un input disparando eventos Angular (input/change).",
    "- `setNumericFieldValue(fieldSelector, value)`: igual para campos numéricos (usa `input:not([type=hidden])`).",
    "- `setValueByFormControl(componentSelector, formControlName, value)`: rellena `[formcontrolname=...] input`.",
    "- `dismissKnownOverlays(extraSelectors?)`: cierra cookies/overlays comunes.",
    "- `openAccordionByComponent(componentSelector)`: abre el acordeón/tarjeta que contiene un componente.",
  ].join("\n");
}

/**
 * Esqueleto genérico (sin dominio) que modela la estructura de un spec
 * útil: imports de helpers, beforeEach, un CU nominal (intercept real +
 * lectura API/UI + baseline) y un CU de error (intercept stub).
 */
function referenceSkeleton(): string {
  return [
    "const {",
    "  persistOrAssertBaseline,",
    "  normalizeAmount,",
    "  selectFirstSelectableOption,",
    "  selectRequiredOptionByTextOrValue,",
    "  waitForSelectableOptions,",
    "  getSelectOptions,",
    "  setValueByFormControl,",
    "  dismissKnownOverlays,",
    "  openAccordionByComponent",
    "} = require(\"../support/e2e-helpers\");",
    "",
    "const APP_URL = \"<visitUrl>\";",
    "",
    "describe(\"<RF-id> - <nombre RF>\", () => {",
    "  beforeEach(() => {",
    "    cy.visit(APP_URL);",
    "    dismissKnownOverlays();",
    "  });",
    "",
    "  it(\"<CU-1> <nombre nominal>\", () => {",
    "    cy.intercept(\"<METHOD>\", \"<glob-intercept>\").as(\"op\");",
    "    cy.reload();",
    "    dismissKnownOverlays();",
    "    cy.wait(\"@op\").then(({ response }) => {",
    "      const body = response?.body || {};",
    "      // Las <option> se rellenan async: ESPERA a que existan antes de leerlas.",
    "      waitForSelectableOptions(\"#sociedad\").then((opts) => {",
    "        expect(opts.filter((o) => o.value && !o.disabled).length).to.be.greaterThan(0);",
    "      });",
    "      // Interacción real: usa helpers sobre el contenedor (resuelven el select nativo).",
    "      selectFirstSelectableOption(\"#sociedad\");",
    "      // abrir el componente/acordeón, rellenar campos y pulsar la acción.",
    "      cy.get(\"<selector-resultado-ui>\").invoke(\"text\").then((uiText) => {",
    "        persistOrAssertBaseline(\"<RF-id>.<CU-id>\", {",
    "          api: body,",
    "          uiTotal: normalizeAmount(uiText)",
    "        });",
    "      });",
    "    });",
    "  });",
    "",
    "  it(\"<CU-2> escenario de error/vacío\", () => {",
    "    cy.intercept(\"<METHOD>\", \"<glob-intercept>\", { statusCode: 200, body: [] }).as(\"opEmpty\");",
    "    cy.reload();",
    "    dismissKnownOverlays();",
    "    cy.wait(\"@opEmpty\");",
    "    // Estado vacío: NUNCA uses .find('option') (cuelga). Usa getSelectOptions.",
    "    // Limita la aserción al control DIRECTAMENTE afectado por el endpoint.",
    "    getSelectOptions(\"#sociedad\").then((opts) => {",
    "      const selectable = opts.filter((o) => o.value && !o.disabled);",
    "      expect(selectable.length).to.eq(0);",
    "    });",
    "  });",
    "});",
  ].join("\n");
}

async function readFrontendSources(frontendRoot: string, maxPerFile = 8000): Promise<FrontendSource[]> {
  const excludedDirs = new Set([
    "node_modules",
    "dist",
    ".git",
    ".angular",
    "coverage",
    "target",
    "cypress",
    ".husky",
    ".vscode",
    "apache-config",
    "proxy",
    "local_ws_config",
    "schematics",
  ]);
  const sources: FrontendSource[] = [];
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
        if (excludedDirs.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        await walk(fullPath);
      } else if (/\.(ts|html)$/i.test(entry.name) && !/\.spec\.ts$/i.test(entry.name)) {
        let content: string;
        try {
          content = await fs.readFile(fullPath, "utf8");
        } catch {
          continue;
        }
        if (content.trim().length === 0) {
          continue;
        }
        sources.push({
          rel: path.relative(frontendRoot, fullPath).replace(/\\/g, "/"),
          content: content.length > maxPerFile ? `${content.slice(0, maxPerFile)}\n/* ...truncado... */` : content,
        });
      }
    }
  };
  await walk(frontendRoot);
  return sources;
}

/**
 * Construye un paquete amplio de código frontend (componentes, plantillas,
 * routing, servicios) acotado en tamaño, priorizando lo más útil para derivar
 * selectores y flujos. Genérico, sin conocimiento del dominio.
 */
function buildBroadFrontendBundle(sources: FrontendSource[], maxTotalChars = 90000): string {
  const rank = (source: FrontendSource): number => {
    const lower = source.rel.toLowerCase();
    const content = source.content;
    let score = 0;
    if (/routing|routes/.test(lower)) score += 6;
    if (/\.component\.html$/.test(lower)) score += 5;
    if (/\.component\.ts$/.test(lower)) score += 4;
    if (/(page|view|screen|container|simulad|form)/.test(lower)) score += 3;
    if (/\.service\.ts$/.test(lower)) score += 2;
    // Prioriza plantillas con elementos interactivos reales (fuente de selectores).
    if (/formcontrolname=/i.test(content)) score += 6;
    if (/<select|<input|<button|empresas-ui-|\(click\)=/i.test(content)) score += 4;
    if (/id=['"][a-z]/i.test(content)) score += 2;
    if (/(environment|polyfill|main\.ts|app\.module\.ts$)/.test(lower)) score -= 3;
    return score;
  };

  const ordered = [...sources].sort((a, b) => rank(b) - rank(a));
  const parts: string[] = [];
  let total = 0;
  for (const source of ordered) {
    const block = `\n### ${source.rel}\n\`\`\`\n${source.content}\n\`\`\`\n`;
    if (total + block.length > maxTotalChars) {
      continue;
    }
    parts.push(block);
    total += block.length;
  }
  return parts.length > 0 ? parts.join("") : "(sin código frontend disponible)";
}

/**
 * Tokens de correlación para localizar el componente frontend que consume un
 * endpoint concreto. Combina segmentos del path y tokens del operationId
 * (inglés), que suelen aparecer en los ficheros `api/`/`model` co-ubicados
 * dentro de la carpeta del componente (aunque el nombre de carpeta esté en
 * otro idioma). Genérico, sin conocimiento del dominio.
 */
function rfCorrelationTokens(entry: RfEntry): string[] {
  const stop = new Set(["get", "post", "put", "delete", "list", "find", "byid", "with"]);
  const tokens = new Set<string>();
  const endpointPath = endpointPathFromMethodPath(entry.methodPath);
  for (const seg of endpointPath.split("/")) {
    const s = seg.replace(/[{}]/g, "").toLowerCase();
    if (s.length >= 4 && !/^\d+$/.test(s)) tokens.add(s);
  }
  for (const raw of entry.operationId.split(/[-_\s]|(?=[A-Z])/)) {
    const s = raw.trim().toLowerCase();
    if (s.length >= 4 && !stop.has(s)) tokens.add(s);
  }
  return [...tokens];
}

/**
 * Construye un bundle de código frontend ENFOCADO en un RF concreto: localiza
 * el/los directorio(s) de componente que consumen su endpoint (por tokens del
 * path/operationId presentes en ficheros co-ubicados) y arrastra sus plantillas
 * y presenters (fuente de selectores reales), añadiendo además el contexto
 * global (pantalla principal con filtros, routing). Genérico y agnóstico de
 * idioma/dominio.
 */
function buildRfFocusedBundle(sources: FrontendSource[], entry: RfEntry, maxTotalChars = 90000): string {
  const tokens = rfCorrelationTokens(entry);
  const countHits = (text: string): number => {
    const lower = text.toLowerCase();
    return tokens.reduce((n, token) => n + (lower.split(token).length - 1), 0);
  };
  const groupKey = (rel: string): string => {
    const match = rel.match(/^(.*?\/components\/[^/]+)\//i);
    return match ? match[1] : rel.split("/").slice(0, -1).join("/");
  };

  const groupScore = new Map<string, number>();
  for (const source of sources) {
    const score = countHits(source.rel) * 4 + Math.min(countHits(source.content), 20);
    if (score > 0) {
      const key = groupKey(source.rel);
      groupScore.set(key, (groupScore.get(key) ?? 0) + score);
    }
  }
  const focused = new Set(
    [...groupScore.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .filter(([, value]) => value > 0)
      .map(([key]) => key)
  );

  // Núcleo global: plantillas "anfitrionas" (pantalla principal que hospeda los
  // componentes hijos y define los filtros globales). Se detectan por densidad
  // de tags `<app-*>` y de `formcontrolname`. Se garantizan en el bundle para
  // que el test pueda inicializar el contexto base. Genérico, sin dominio.
  const globalScore = (source: FrontendSource): number => {
    if (!/\.component\.html$/i.test(source.rel)) return 0;
    const childTags = (source.content.match(/<app-[a-z]/gi) ?? []).length;
    const controls = (source.content.match(/formcontrolname=/gi) ?? []).length;
    const globalIds = (source.content.match(/id=['"][a-z][\w-]*['"]/gi) ?? []).length;
    return childTags * 3 + controls + globalIds;
  };
  const globalCore = new Set(
    [...sources]
      .map((s) => ({ s, g: globalScore(s) }))
      .filter((x) => x.g > 0)
      .sort((a, b) => b.g - a.g)
      .slice(0, 2)
      .map((x) => x.s.rel)
  );

  const priority = (source: FrontendSource): number => {
    const rel = source.rel.toLowerCase();
    const content = source.content;
    let score = 0;
    if (globalCore.has(source.rel)) score += 120;
    if (focused.has(groupKey(source.rel))) {
      score += /(\.component\.html$|presenter\.ts$|interactor\.ts$|\.component\.ts$)/.test(rel) ? 100 : 30;
    }
    if (/\.component\.html$/.test(rel)) score += 20;
    if (/(presenter|interactor)\.ts$|\.component\.ts$/.test(rel)) score += 15;
    if (/routing|routes/.test(rel)) score += 18;
    if (/formcontrolname=/i.test(content)) score += 10;
    if (/<select|<input|<button|empresas-ui-|\(click\)=/i.test(content)) score += 6;
    if (/id=['"][a-z]/i.test(content)) score += 3;
    if (/(\.model\.ts$|mock)/.test(rel)) score -= 4;
    if (/(environment|polyfill|main\.ts|app\.module\.ts$)/.test(rel)) score -= 5;
    return score;
  };

  const ordered = [...sources].sort((a, b) => priority(b) - priority(a));
  const parts: string[] = [];
  let total = 0;
  for (const source of ordered) {
    const block = `\n### ${source.rel}\n\`\`\`\n${source.content}\n\`\`\`\n`;
    if (total + block.length > maxTotalChars) {
      continue;
    }
    parts.push(block);
    total += block.length;
  }
  return parts.length > 0 ? parts.join("") : buildBroadFrontendBundle(sources, maxTotalChars);
}

function formatCasesForPrompt(entry: RfEntry): string {
  return entry.cases
    .map((cu) => {
      const steps = cu.steps.map((step, index) => `     ${index + 1}. ${step}`).join("\n");
      return `- ${cu.id}: ${cu.name}\n   Clave baseline: "${entry.id}.${cu.id}"\n   Pasos:\n${steps}`;
    })
    .join("\n");
}

/**
 * Construye el prompt que se envía al LLM del cliente (vía sampling) para
 * generar un spec Cypress REAL (con cy.intercept, interacción y aserciones)
 * para un RF y sus CU, reutilizando la librería de helpers compartida y
 * derivando selectores del código frontend.
 */
function buildE2EGenerationPrompt(params: {
  entry: RfEntry;
  rules: string;
  frontendContext: string;
  visitUrl: string;
  openApiContext: string;
  promptOverride?: string;
}): string {
  const { entry, rules, frontendContext, visitUrl, openApiContext, promptOverride } = params;
  const method = entry.methodPath.split(/\s+/)[0] ?? "GET";
  const endpointPath = endpointPathFromMethodPath(entry.methodPath);
  const glob = interceptGlobFromPath(endpointPath);

  return [
    "Eres un ingeniero de QA experto en Cypress. Genera un fichero de test E2E COMPLETO y EJECUTABLE (`.cy.ts`) para el siguiente Requisito Funcional y sus Casos de Uso.",
    "",
    `## Requisito funcional: ${entry.id} — ${entry.name}`,
    `- Endpoint asociado: \`${entry.methodPath}\` (operationId: \`${entry.operationId}\`).`,
    `- Patrón de intercept sugerido: \`cy.intercept("${method}", "${glob}")\` (agnóstico al host).`,
    `- URL de arranque para \`cy.visit\`: ${visitUrl}`,
    "",
    "## Casos de uso a implementar (un `it()` por CU, con su clave de baseline exacta):",
    formatCasesForPrompt(entry),
    "",
    "## Cómo implementar (OBLIGATORIO):",
    "- Reutiliza los helpers compartidos importándolos de `../support/e2e-helpers` (NO reimplementes utilidades):",
    helperApiSummary(),
    "- Estructura: un `describe` para el RF, un `beforeEach` que haga `cy.visit(APP_URL)` + `dismissKnownOverlays()`, y un `it` por CU (nombres `\"<CU-id> <nombre>\"`, en español).",
    "- **REGLA CRÍTICA DE SELECTORES**: usa ÚNICAMENTE selectores que aparezcan LITERALMENTE en el código frontend proporcionado (busca `id=\"...\"`, `formcontrolname=\"...\"`, tags de componentes `app-*`/`empresas-ui-*`, clases CSS, `data-*`, y textos exactos de botones). PROHIBIDO inventar selectores a partir del `operationId` o de nombres en inglés del OpenAPI. Si el endpoint es `get-salesOrganizations` pero en el HTML el control es `id=\"sociedad\"`, DEBES usar `#sociedad`, nunca `[formcontrolname='salesOrganization']`.",
    "- Antes de escribir cada selector, localízalo en el bloque de código frontend. Si un campo/desplegable no existe con ese nombre, busca el equivalente real (a menudo en español) en las plantillas.",
    "- **CONTROLES CUSTOM (MUY IMPORTANTE)**: muchos controles son web components que envuelven un elemento nativo (p. ej. `<empresas-ui-dropdown id=\"sociedad\">` contiene un `<select>` nativo, `<empresas-ui-input>` contiene un `<input>`). NUNCA llames `.select()` ni `.find('option')` directamente sobre el wrapper custom: fallará (`cy.select() can only be called on a <select>`). En su lugar:",
    "   - Para desplegables usa SIEMPRE los helpers pasando el selector del contenedor (`selectFirstSelectableOption('#sociedad')`, `selectRequiredOptionByTextOrValue('#sociedad', 'AASA')`); resuelven el `<select>` nativo internamente.",
    "   - Para LEER opciones en escenarios NOMINALES (afirmar que HAY opciones) usa `waitForSelectableOptions('#sociedad').then((opts) => { ... })`, que ESPERA a que se rellenen (son asíncronas). NO uses `getSelectOptions` para eso: leería 0 antes de que Angular renderice las `<option>`.",
    "   - Para LEER opciones en escenarios VACÍOS/negativos usa `getSelectOptions('#sociedad').then((opts) => { ... })`. NUNCA uses `cy.get('#sociedad').find('option')` porque `.find` reintenta hasta que exista una opción y COLGARÁ el test en escenarios vacíos.",
    "   - Para inputs custom usa `setInputValue`/`setNumericFieldValue`/`setValueByFormControl` (resuelven el `<input>` interno).",
    "- **Contexto base**: identifica en la plantilla principal (simulador/pantalla principal) los filtros globales (p. ej. selects de sociedad/aeropuerto e inputs numéricos requeridos) y establécelos ANTES de interactuar con el componente concreto, si dicho componente los necesita para renderizarse o para que su llamada se dispare. Deriva esos selectores del código, no los inventes.",
    "- Identifica el componente/pantalla que consume este endpoint (correlaciona por operationId, campos de la respuesta y textos) y realiza el flujo real: fijar filtros globales necesarios, abrir el componente/acordeón (`openAccordionByComponent('app-...')`), rellenar campos requeridos y pulsar la acción que dispara la petición (normalmente un botón con texto \"Calcular importe\" u similar presente en el código).",
    "- CU nominal: usa `cy.intercept` real + `cy.wait('@alias').then(({ response }) => ...)`, lee valores de la respuesta y del DOM (con `normalizeAmount` para importes) y llama a `persistOrAssertBaseline(\"<RF>.<CU>\", { ...api, ...ui })` con datos reales. NO dejes el snapshot vacío ni pongas TODOs.",
    "- CU de error/vacío (500, 404, `[]`): haz **stub** con `cy.intercept(method, glob, { statusCode, body })`, dispara la acción y verifica un efecto observable QUE EXISTA en el código: cambio de ruta (p. ej. `cy.url().should('include', '/error')` si el routing redirige a una pantalla de error), o el control DIRECTAMENTE afectado por el endpoint sin opciones seleccionables (compruébalo con `getSelectOptions(...).then(...)`, nunca con `.find('option')`). LIMITA la aserción al control directamente afectado. NO asumas que otros controles \"dependientes\" se deshabilitan o se vacían salvo que el código lo demuestre (p. ej. un binding `[disabled]=\"...\"` o `*ngIf` ligado a esos datos): esas asunciones suelen ser falsas y hacen fallar el test. NO asumas clases genéricas como `.error-message` o `.alert-danger` si no están en el código.",
    "- Si el flujo necesita datos de entorno (aeropuerto/sociedad/fechas), decláralos como constantes al inicio usando valores plausibles derivados del código.",
    "",
    "## Esqueleto de referencia (estructura a seguir; adáptalo con selectores/valores reales):",
    "```js",
    referenceSkeleton(),
    "```",
    "",
    "## Reglas de estilo e interacción del proyecto:",
    rules,
    "",
    `## Contexto OpenAPI: ${openApiContext}`,
    "",
    "## Código frontend (fuente de selectores y comportamiento real):",
    frontendContext,
    promptOverride && promptOverride.trim().length > 0
      ? `\n## Instrucciones adicionales de esta ejecución:\n${promptOverride.trim()}`
      : "",
    "",
    "## Salida:",
    "Devuelve ÚNICAMENTE el contenido del fichero `.cy.ts`, sin explicaciones y sin vallas de código (` ``` `). Debe empezar por el `require` de `../support/e2e-helpers` y contener el `describe` con todos los `it` implementados de forma ejecutable.",
  ].join("\n");
}

/**
 * Limpia el código generado por el LLM: quita vallas de código y texto
 * previo al primer `require`/`const`/`describe`/`import`.
 */
function sanitizeGeneratedSpec(raw: string): string {
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:[a-z]+)?\s*\n([\s\S]*?)\n```$/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  } else {
    text = text.replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  }
  const anchorMatch = text.match(/^(const |import |describe\(|\/\/|\/\*)/m);
  if (anchorMatch && anchorMatch.index && anchorMatch.index > 0) {
    text = text.slice(anchorMatch.index).trim();
  }
  return `${text}\n`;
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

function buildE2EHelpersFile(): string {
  return [
    "const {",
    "  DEFAULT_NUMERIC_TOLERANCE,",
    "  compareBaselineRecord",
    "} = require('./e2e-baseline');",
    "",
    "const DEFAULT_BASELINE_FIXTURE = 'cypress/fixtures/e2e-baseline.json';",
    "",
    "function normalizeAmount(value) {",
    "  if (typeof value === 'number') {",
    "    return Number.isFinite(value) ? value : null;",
    "  }",
    "  if (typeof value !== 'string') {",
    "    return null;",
    "  }",
    "  const cleaned = value",
    "    .trim()",
    "    .replace(/\\s/g, '')",
    "    .replace(/[€$]/g, '')",
    "    .replace(/\\./g, '')",
    "    .replace(',', '.')",
    "    .replace(/[^\\d.-]/g, '');",
    "  const parsed = Number(cleaned);",
    "  return Number.isFinite(parsed) ? parsed : null;",
    "}",
    "",
    "function findMatchingOption($options, expectedTextOrValue) {",
    "  const expected = String(expectedTextOrValue || '').trim().toLowerCase();",
    "  return Array.from($options).find((option) => {",
    "    const text = (option.textContent || '').trim().toLowerCase();",
    "    const value = (option.value || '').trim().toLowerCase();",
    "    return text.includes(expected) || value === expected;",
    "  });",
    "}",
    "",
    "// Resuelve el <select> nativo a partir de un selector que puede apuntar",
    "// directamente a un <select> o a un componente contenedor (p. ej. un web",
    "// component/custom control que envuelve un <select> nativo).",
    "function resolveNativeSelect(rootSelector) {",
    "  return cy.get(rootSelector, { timeout: 10000 }).then(($root) => {",
    "    const $select = $root.is('select') ? $root : $root.find('select');",
    "    expect($select.length, `<select> nativo bajo ${rootSelector}`).to.be.greaterThan(0);",
    "    return cy.wrap($select.first(), { log: false });",
    "  });",
    "}",
    "",
    "// Devuelve (vía cy.then) la lista de opciones [{value,text,disabled}] SIN",
    "// esperar a que existan: seguro para escenarios vacíos (no cuelga).",
    "function getSelectOptions(rootSelector) {",
    "  return cy.get(rootSelector, { timeout: 10000 }).then(($root) => {",
    "    const $select = $root.is('select') ? $root : $root.find('select');",
    "    const $options = $select.find('option');",
    "    return Array.from($options).map((option) => ({",
    "      value: (option.value || '').trim(),",
    "      text: (option.textContent || '').trim(),",
    "      disabled: !!option.disabled",
    "    }));",
    "  });",
    "}",
    "",
    "// Espera (reintentable) a que un desplegable tenga al menos `minCount`",
    "// opciones SELECCIONABLES (value no vacío y no disabled) y devuelve entonces",
    "// su snapshot. Úsalo en escenarios NOMINALES donde las opciones se rellenan",
    "// de forma asíncrona tras la respuesta del backend (change detection/render).",
    "function waitForSelectableOptions(rootSelector, minCount = 1) {",
    "  return resolveNativeSelect(rootSelector).then(($select) => {",
    "    return cy",
    "      .wrap($select)",
    "      .find('option', { timeout: 10000 })",
    "      .should(($options) => {",
    "        const selectable = Array.from($options).filter(",
    "          (option) => (option.value || '').trim() !== '' && !option.disabled",
    "        );",
    "        expect(selectable.length, `opciones seleccionables en ${rootSelector}`).to.be.at.least(minCount);",
    "      })",
    "      .then(() => getSelectOptions(rootSelector));",
    "  });",
    "}",
    "",
    "function selectRequiredOptionByTextOrValue(rootSelector, expectedTextOrValue) {",
    "  resolveNativeSelect(rootSelector).then(($select) => {",
    "    cy.wrap($select)",
    "      .find('option', { timeout: 10000 })",
    "      .should(($options) => {",
    "        expect(findMatchingOption($options, expectedTextOrValue), `opción \"${expectedTextOrValue}\"`).to.exist;",
    "      })",
    "      .then(($options) => {",
    "        const match = findMatchingOption($options, expectedTextOrValue);",
    "        cy.wrap($select).select(match.value || (match.textContent || '').trim(), { force: true });",
    "      });",
    "  });",
    "}",
    "",
    "function selectOptionByTextOrValueIfPresent(rootSelector, expectedTextOrValue) {",
    "  resolveNativeSelect(rootSelector).then(($select) => {",
    "    const match = findMatchingOption($select.find('option'), expectedTextOrValue);",
    "    if (!match) return;",
    "    cy.wrap($select).select(match.value || (match.textContent || '').trim(), { force: true });",
    "  });",
    "}",
    "",
    "function selectFirstSelectableOption(rootSelector) {",
    "  resolveNativeSelect(rootSelector).then(($select) => {",
    "    cy.wrap($select)",
    "      .find('option', { timeout: 10000 })",
    "      .should('have.length.greaterThan', 0)",
    "      .then(($options) => {",
    "        const selectable = Array.from($options).find(",
    "          (option) => (option.value || '').trim() !== '' && !option.disabled",
    "        );",
    "        if (!selectable) return;",
    "        cy.wrap($select).select(selectable.value || (selectable.textContent || '').trim(), { force: true });",
    "      });",
    "  });",
    "}",
    "",
    "function setInputValue(inputSelector, value) {",
    "  const valueAsText = String(value);",
    "  cy.get(inputSelector, { timeout: 10000 })",
    "    .first()",
    "    .then(($input) => {",
    "      cy.wrap($input)",
    "        .click({ force: true })",
    "        .invoke('val', valueAsText)",
    "        .trigger('input', { force: true })",
    "        .trigger('change', { force: true });",
    "      cy.wrap($input).should('have.value', valueAsText);",
    "    });",
    "}",
    "",
    "function setNumericFieldValue(fieldSelector, value) {",
    "  setInputValue(`${fieldSelector} input:not([type='hidden'])`, value);",
    "}",
    "",
    "function setValueByFormControl(componentSelector, formControlName, value) {",
    "  setInputValue(`${componentSelector} [formcontrolname='${formControlName}'] input`, value);",
    "}",
    "",
    "function dismissKnownOverlays(extraSelectors = []) {",
    "  const knownButtons = [",
    "    '#onetrust-accept-btn-handler',",
    "    \"button[aria-label='Aceptar']\",",
    "    \"button[title='Aceptar']\",",
    "    ...extraSelectors",
    "  ];",
    "  cy.get('body').then(($body) => {",
    "    knownButtons.forEach((selector) => {",
    "      if ($body.find(selector).length > 0) {",
    "        cy.get(selector).first().click({ force: true });",
    "      }",
    "    });",
    "  });",
    "}",
    "",
    "function openAccordionByComponent(componentSelector) {",
    "  cy.get(componentSelector, { timeout: 10000 })",
    "    .first()",
    "    .then(($el) => {",
    "      const card = $el.closest('.card, .accordion-item, mat-expansion-panel');",
    "      const header = card",
    "        .find('.card-header, .accordion-header, mat-expansion-panel-header')",
    "        .first();",
    "      if (header && header.length > 0) {",
    "        cy.wrap(header).click({ force: true });",
    "      }",
    "    });",
    "}",
    "",
    "function persistOrAssertBaseline(key, currentSnapshot, options = {}) {",
    "  const baselineFixturePath = options.baselineFixturePath || DEFAULT_BASELINE_FIXTURE;",
    "  const envFlag = options.autoCapture !== undefined",
    "    ? options.autoCapture",
    "    : Cypress.env('AUTO_CAPTURE_MISSING_BASELINE');",
    "  const autoCapture = String(envFlag === undefined ? 'true' : envFlag)",
    "    .toLowerCase()",
    "    .trim() !== 'false';",
    "  cy.task('readBaseline', { filePath: baselineFixturePath }).then((baseline) => {",
    "    const nextBaseline = baseline || {};",
    "    const expectedSnapshot = nextBaseline[key];",
    "    if (!expectedSnapshot && autoCapture) {",
    "      nextBaseline[key] = currentSnapshot;",
    "      cy.task('writeBaseline', { filePath: baselineFixturePath, data: nextBaseline }).then(() => {",
    "        cy.log(`Baseline autocapturado para \"${key}\". En la siguiente ejecución se validará.`);",
    "      });",
    "      return;",
    "    }",
    "    expect(expectedSnapshot, `No existe baseline para \"${key}\".`).to.exist;",
    "    const comparison = compareBaselineRecord(currentSnapshot, expectedSnapshot, {",
    "      numericTolerance: DEFAULT_NUMERIC_TOLERANCE,",
    "      ...(options.compareOptions || {})",
    "    });",
    "    expect(",
    "      comparison.isMatch,",
    "      `Diferencias baseline en \"${key}\": ${JSON.stringify(comparison.mismatches, null, 2)}`",
    "    ).to.eq(true);",
    "  });",
    "}",
    "",
    "module.exports = {",
    "  normalizeAmount,",
    "  findMatchingOption,",
    "  resolveNativeSelect,",
    "  getSelectOptions,",
    "  waitForSelectableOptions,",
    "  selectRequiredOptionByTextOrValue,",
    "  selectOptionByTextOrValueIfPresent,",
    "  selectFirstSelectableOption,",
    "  setInputValue,",
    "  setNumericFieldValue,",
    "  setValueByFormControl,",
    "  dismissKnownOverlays,",
    "  openAccordionByComponent,",
    "  persistOrAssertBaseline",
    "};",
    "",
  ].join("\n");
}

async function writeBaselineAssets(context: LoadedContext): Promise<void> {
  const configRoot = path.dirname(context.configPath);
  const frontendRoot = path.resolve(configRoot, context.config.frontend.root);
  const supportPath = path.resolve(frontendRoot, baselineSupportRelativePath);
  const helpersPath = path.resolve(frontendRoot, "cypress", "support", "e2e-helpers.js");
  const fixturesPath = path.resolve(frontendRoot, baselineFixtureRelativePath);
  const tasksSnippetPath = path.resolve(frontendRoot, "cypress", "support", "baseline-tasks.js");

  await fs.mkdir(path.dirname(supportPath), { recursive: true });
  await fs.mkdir(path.dirname(fixturesPath), { recursive: true });
  await fs.mkdir(path.dirname(tasksSnippetPath), { recursive: true });

  await fs.writeFile(supportPath, buildBaselineSupportFile(), "utf8");
  await fs.writeFile(helpersPath, buildE2EHelpersFile(), "utf8");

  try {
    await fs.access(fixturesPath);
  } catch {
    await fs.writeFile(fixturesPath, "{}\n", "utf8");
  }

  await fs.writeFile(tasksSnippetPath, buildBaselineTasksSnippetFile(), "utf8");
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

function buildDefaultCypressConfigFileWithBaseUrl(baseUrl?: string): string {
  return [
    "const { defineConfig } = require(\"cypress\");",
    "const { registerBaselineTasks } = require(\"./cypress/support/baseline-tasks\");",
    "",
    "module.exports = defineConfig({",
    "  e2e: {",
    "    specPattern: \"cypress/e2e/**/*.cy.{js,ts}\",",
    ...(baseUrl ? [`    baseUrl: \"${baseUrl.replace(/"/g, '\\"')}\",`] : []),
    "    setupNodeEvents(on) {",
    "      registerBaselineTasks(on);",
    "    }",
    "  },",
    "  video: false",
    "});",
    "",
  ].join("\n");
}

function injectBaselineTasksIntoConfig(configContent: string): string {
  let updated = configContent;

  // Si el config del usuario ya define las tareas readBaseline/writeBaseline
  // (inline), no inyectamos registerBaselineTasks para evitar tareas duplicadas.
  const alreadyDefinesTasks =
    /readBaseline\s*\(/.test(updated) && /writeBaseline\s*\(/.test(updated);
  if (alreadyDefinesTasks && !updated.includes("registerBaselineTasks")) {
    return updated;
  }

  const hasRequire =
    updated.includes("registerBaselineTasks") &&
    (updated.includes("./cypress/support/baseline-tasks") || updated.includes(".\\\\cypress\\\\support\\\\baseline-tasks"));

  if (!hasRequire) {
    updated = `const { registerBaselineTasks } = require("./cypress/support/baseline-tasks");\n${updated}`;
  }

  if (updated.includes("registerBaselineTasks(on);")) {
    return updated;
  }

  const setupNodeEventsRegex = /setupNodeEvents\s*\(\s*on(?:\s*,[^)]*)?\s*\)\s*\{/;
  if (setupNodeEventsRegex.test(updated)) {
    return updated.replace(setupNodeEventsRegex, (match) => `${match}\n      registerBaselineTasks(on);`);
  }

  return updated;
}

async function ensureFrontendCypressSetup(context: LoadedContext): Promise<void> {
  const configRoot = path.dirname(context.configPath);
  const frontendRoot = path.resolve(configRoot, context.config.frontend.root);
  const packageJsonPath = path.resolve(frontendRoot, "package.json");
  const cypressConfigPath = path.resolve(frontendRoot, "cypress.config.js");

  await fs.mkdir(frontendRoot, { recursive: true });

  const packageJsonRaw = await readTextIfExists(packageJsonPath);
  const packageJson = packageJsonRaw
    ? (JSON.parse(packageJsonRaw) as Record<string, unknown>)
    : {
        name: path.basename(frontendRoot) || "frontend",
        private: true,
        version: "0.0.0",
      };

  const scripts =
    typeof packageJson.scripts === "object" && packageJson.scripts !== null
      ? (packageJson.scripts as Record<string, string>)
      : {};
  if (!scripts["e2e"]) {
    scripts["e2e"] = "cypress run";
  }
  if (!scripts["e2e:open"]) {
    scripts["e2e:open"] = "cypress open";
  }
  packageJson.scripts = scripts;

  const devDependencies =
    typeof packageJson.devDependencies === "object" && packageJson.devDependencies !== null
      ? (packageJson.devDependencies as Record<string, string>)
      : {};
  if (!devDependencies.cypress) {
    devDependencies.cypress = "^13.17.0";
  }
  packageJson.devDependencies = devDependencies;

  await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

  const existingConfig = await readTextIfExists(cypressConfigPath);
  if (!existingConfig) {
    await fs.writeFile(cypressConfigPath, buildDefaultCypressConfigFileWithBaseUrl(context.config.e2eBaseUrl), "utf8");
    return;
  }

  const updatedConfig = injectBaselineTasksIntoConfig(existingConfig);
  if (updatedConfig !== existingConfig) {
    await fs.writeFile(cypressConfigPath, updatedConfig, "utf8");
  }
}

export async function generateE2ETests(
  context: LoadedContext,
  sample: E2ESampleFn,
  promptOverride?: string
): Promise<{ files: string[]; rfCount: number }> {
  await ensureFrontendCypressSetup(context);
  await writeBaselineAssets(context);

  const outputRoot = path.resolve(path.dirname(context.configPath), context.config.e2eTests);
  await fs.mkdir(outputRoot, { recursive: true });

  const entries: RfEntry[] = extractOrBuildRfEntries(context);
  const files: string[] = [];
  const visitUrl = context.config.e2eBaseUrl ?? "/";

  const frontendRoot = path.resolve(path.dirname(context.configPath), context.config.frontend.root);
  const sources = await readFrontendSources(frontendRoot);
  const openApiContext = openApiSnippet(context.openApiContent);

  for (const entry of entries) {
    const fileName = `${slug(entry.id)}-${slug(entry.name)}.cy.ts`;
    const fullPath = path.join(outputRoot, fileName);

    const promptData = await loadE2EPrompt(context, entry, undefined, promptOverride);
    const frontendContext = buildRfFocusedBundle(sources, entry);
    const generationPrompt = buildE2EGenerationPrompt({
      entry,
      rules: promptData.text,
      frontendContext,
      visitUrl,
      openApiContext,
      promptOverride,
    });

    const generated = await sample(generationPrompt, 16000);
    if (!generated || generated.trim().length === 0) {
      throw new Error(
        `El modelo no devolvió contenido para el spec E2E de ${entry.id}. ` +
          "Verifica que el cliente MCP soporte sampling (createMessage)."
      );
    }

    await fs.writeFile(fullPath, sanitizeGeneratedSpec(generated), "utf8");
    files.push(fullPath);
  }

  return { files, rfCount: entries.length };
}
