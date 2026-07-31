import { promises as fs } from "node:fs";
import path from "node:path";
import { LoadedContext, RfEntry } from "../types";
import { requireFrontendRoot } from "../config";
import { extractOrBuildRfEntries } from "../rfcu";
import { loadE2EPrompt } from "../prompts/loader";
import { runCypressSpec, extractCypressFailureSummary, isCypressCacheError, repairCypressCache, CypressRunResult } from "./cypress-runner";

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Valor por defecto del NO_PROXY para entornos internos de AENA. */
const DEFAULT_E2E_NO_PROXY = "localhost,127.0.0.1,.aena.es";
/** Directorio de node por defecto (instalación nvm de AENA). */
const DEFAULT_E2E_NODE_PATH = "C:\\Users\\aena\\AppData\\Roaming\\nvm\\v24.16.0";

/**
 * Resuelve el directorio de node y las variables de entorno extra para ejecutar
 * Cypress, combinando los valores de la config con los defaults de AENA. El
 * NO_PROXY por defecto se aplica salvo que la config lo sobreescriba.
 */
function resolveE2ERuntime(context: LoadedContext): {
  nodePath: string | undefined;
  env: Record<string, string>;
  headed: boolean;
  browser: string | undefined;
} {
  const nodePath = context.config.e2eNodePath ?? DEFAULT_E2E_NODE_PATH;
  const env: Record<string, string> = {
    NO_PROXY: DEFAULT_E2E_NO_PROXY,
    no_proxy: DEFAULT_E2E_NO_PROXY,
    ...(context.config.e2eEnv ?? {}),
  };
  return {
    nodePath,
    env,
    headed: context.config.e2eHeaded ?? false,
    browser: context.config.e2eBrowser,
  };
}

/**
 * Ejecuta un spec de Cypress y, si detecta el error de caché V8 corrupta
 * (`cachedDataRejected` — un problema de ENTORNO, no del spec), repara la caché
 * del binario UNA vez y reintenta. Marca `cacheError` si tras reparar sigue
 * fallando por lo mismo, para que el flujo NO intente reescribir el test.
 */
async function runCypressSpecWithRepair(params: {
  frontendRoot: string;
  specRelPath: string;
  runCommand?: string;
  timeoutMs?: number;
  nodePath?: string;
  env?: Record<string, string>;
  headed?: boolean;
  browser?: string;
}): Promise<CypressRunResult & { cacheError?: boolean }> {
  const first = await runCypressSpec(params);
  if (first.passed || !isCypressCacheError(first.output)) {
    return first;
  }
  const repair = await repairCypressCache({
    frontendRoot: params.frontendRoot,
    nodePath: params.nodePath,
    env: params.env,
  });
  const second = await runCypressSpec(params);
  if (second.passed) {
    return second;
  }
  if (isCypressCacheError(second.output)) {
    return {
      ...second,
      cacheError: true,
      output: `${second.output}\n\n[qa-mcp] La reparación automática de la caché de Cypress no resolvió el error. Salida de la reparación:\n${extractCypressFailureSummary(repair.output, 3000)}`,
    };
  }
  return second;
}

/**
 * Mensaje para el flujo de ejecución cuando Cypress falla por caché corrupta.
 * NO es un fallo del spec: hay que reparar el entorno, no reescribir el test.
 */
function cypressCacheErrorNotice(nodePath: string | undefined): string {
  return [
    "⚠️ ERROR DE ENTORNO (NO del spec): Cypress no arranca por caché V8 corrupta/incompatible (`cachedDataRejected`).",
    "Esto ocurre al cambiar la versión de Node respecto a la que verificó Cypress. NO reescribas el spec: no lo soluciona.",
    "La reparación automática (cache clear + install + verify) tampoco lo resolvió. Ejecuta MANUALMENTE en el frontend, con el Node configurado en el PATH" +
      (nodePath ? ` (${nodePath})` : "") +
      ":",
    "  npx cypress cache clear",
    "  npx cypress install",
    "  npx cypress verify",
    "Si la descarga falla por proxy, comprueba NO_PROXY y la conectividad a download.cypress.io. Tras reparar, vuelve a llamar a runE2ETests.",
  ].join("\n");
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
    "    // Aserción AUTORITATIVA = la respuesta interceptada (siempre válida).",
    "    cy.wait(\"@opEmpty\").then(({ response }) => {",
    "      expect(response?.statusCode).to.eq(200);",
    "      expect(response?.body).to.deep.eq([]);",
    "    });",
    "    // NO afirmes recuentos exactos de opciones (hay placeholder con value).",
    "    // Para ERROR (4xx/5xx) verifica el manejo real: p. ej. cy.url().should('include', '/error') si el routing redirige.",
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

function rankRfSources(sources: FrontendSource[], entry: RfEntry): FrontendSource[] {
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
  // de tags `<app-*>` y de `formcontrolname`. Genérico, sin dominio.
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

  return [...sources].filter((s) => priority(s) > 0).sort((a, b) => priority(b) - priority(a));
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
  const ordered = rankRfSources(sources, entry);
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

/**
 * Variante LEAN para modo asistido: en vez de embeber el código frontend (que
 * desbordaría el contexto del cliente), devuelve la LISTA de rutas relativas de
 * los ficheros más relevantes para el RF, para que el propio agente los abra
 * con sus herramientas de fichero y derive de ahí los selectores reales.
 */
function buildRfFocusedFileList(sources: FrontendSource[], entry: RfEntry, maxFiles = 20): string {
  const ordered = rankRfSources(sources, entry).slice(0, maxFiles);
  if (ordered.length === 0) {
    return "(no se localizaron ficheros frontend relevantes; explora `src/` para derivar selectores)";
  }
  return ordered.map((s) => `- ${s.rel}`).join("\n");
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
  fix?: { currentSpec: string; cypressOutput: string; attempt: number };
  frontendIsFileList?: boolean;
}): string {
  const { entry, rules, frontendContext, visitUrl, openApiContext, promptOverride, fix, frontendIsFileList } = params;
  const method = entry.methodPath.split(/\s+/)[0] ?? "GET";
  const endpointPath = endpointPathFromMethodPath(entry.methodPath);
  const glob = interceptGlobFromPath(endpointPath);
  const isUiOnly =
    /acción de UI|sin endpoint directo/i.test(entry.methodPath) ||
    /^ui-/i.test(entry.operationId);
  const endpointLine = isUiOnly
    ? `- Acción de UI SIN endpoint directo (${entry.operationId}). NO asumas una petición de API concreta: verifica el efecto OBSERVABLE en la UI (descarga/exportación, cálculo o validación en cliente, navegación, cambios de estado). Usa \`cy.intercept\` SOLO si al inspeccionar el código descubres una llamada real involucrada.`
    : `- Endpoint asociado: \`${entry.methodPath}\` (operationId: \`${entry.operationId}\`).\n- Patrón de intercept sugerido: \`cy.intercept("${method}", "${glob}")\` (agnóstico al host).`;

  return [
    fix
      ? "Eres un ingeniero de QA experto en Cypress. El spec E2E de más abajo FALLÓ al ejecutarse en Cypress. CORRÍGELO para que TODOS los `it()` pasen sin errores, aplicando las reglas y usando la salida de Cypress para diagnosticar. Mantén la cobertura de TODOS los Casos de Uso."
      : "Eres un ingeniero de QA experto en Cypress. Genera un fichero de test E2E COMPLETO y EJECUTABLE en JavaScript PLANO (`.cy.js`) para el siguiente Requisito Funcional y sus Casos de Uso.",
    "",
    `## Requisito funcional: ${entry.id} — ${entry.name}`,
    endpointLine,
    `- URL de arranque para \`cy.visit\`: ${visitUrl}`,
    "",
    "## Casos de uso a implementar (un `it()` por CU, con su clave de baseline exacta):",
    formatCasesForPrompt(entry),
    "",
    "## Cómo implementar (OBLIGATORIO):",
    "- **JAVASCRIPT PLANO (CRÍTICO)**: el fichero es `.cy.js`, NO TypeScript. PROHIBIDO usar sintaxis TS: sin anotaciones de tipo (`: string`, `: number`, `param: Tipo`), sin aserciones `as` (`response.body as Array<...>`), sin `interface`/`type`, sin genéricos `<T>`, sin `!` de non-null. Escribe JavaScript ES2018 válido que un navegador ejecute sin transpilar tipos. (Cypress NO hace type-check; cualquier sintaxis TS rompe la ejecución del spec.)",
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
    "   - **VALORES SINTÉTICOS DE ANGULAR (`[ngValue]`) — MUY IMPORTANTE**: los `<select>` de Angular que enlazan objetos con `[ngValue]=\"item\"` (muy habitual aquí) renderizan el atributo `value` de cada `<option>` como un token SINTÉTICO tipo `\"0: Object\"`, `\"1: Object\"`, que NO es el valor de negocio. En consecuencia: (1) NUNCA compares `$select.val()` ni `option.value` con un id/código de la API o con un parámetro de la URL (fallarías con `expected 'AASA' to equal '0: Object'`). (2) Para seleccionar una opción concreta hazlo por su TEXTO visible (`selectRequiredOptionByTextOrValue('#sociedad', '<texto visible>')`), NUNCA pasando `option.value`. (3) Para correlacionar una selección con la petición que dispara, extrae el identificador del **URL/body de la petición interceptada** (`cy.wait('@alias')`) y, si necesitas un valor esperado, tómalo de la **RESPUESTA de la API** (p. ej. la lista de organizaciones y sus ids/códigos), NUNCA del `value` del DOM. Trata `option.text` como el identificador fiable; `option.value` puede ser sintético.",
    "- **Contexto base**: identifica en la plantilla principal (simulador/pantalla principal) los filtros globales (p. ej. selects de sociedad/aeropuerto e inputs numéricos requeridos) y establécelos ANTES de interactuar con el componente concreto, si dicho componente los necesita para renderizarse o para que su llamada se dispare. Deriva esos selectores del código, no los inventes.",
    "- Identifica el componente/pantalla que consume este endpoint (correlaciona por operationId, campos de la respuesta y textos) y realiza el flujo real: fijar filtros globales necesarios, abrir el componente/acordeón (`openAccordionByComponent('app-...')`), rellenar campos requeridos y pulsar la acción que dispara la petición (normalmente un botón con texto \"Calcular importe\" u similar presente en el código).",
    "- CU nominal: usa `cy.intercept` real + `cy.wait('@alias').then(({ response }) => ...)`, lee valores de la respuesta y del DOM (con `normalizeAmount` para importes) y llama a `persistOrAssertBaseline(\"<RF>.<CU>\", { ...api, ...ui })` con datos reales. NO dejes el snapshot vacío ni pongas TODOs.",
    "- CU de error/vacío (500, 404, `[]`): haz **stub** con `cy.intercept(method, glob, { statusCode, body })`, dispara la acción y comprueba el efecto observable QUE EXISTA en el código.",
    "- **Aserción AUTORITATIVA en vacío/error = la RESPUESTA interceptada**: `cy.wait('@alias').then(({ response }) => { expect(response?.statusCode).to.eq(<code>); ... })`. Esa es la comprobación principal y siempre válida; en muchos CU basta con ella.",
    "- **ERROR (4xx/5xx)**: además, verifica el manejo de error REAL del código. En esta clase de apps un interceptor/guard global suele redirigir a una ruta de error: en ese caso usa `cy.url().should('include', '/error')`. Búscalo en el código (error-interceptor, routing, pantalla de error). NO asumas que la vista permanece en la pantalla actual (NO escribas `cy.url().should('include','/<pantalla-actual>')`) salvo que el código lo demuestre.",
    "- **ERROR (4xx/5xx) — ACCIÓN MÍNIMA Y PARAR (MUY IMPORTANTE)**: si la app redirige a una pantalla de error global ante un fallo, la navegación DESMONTA la página. Por eso, en un CU de error: (1) haz SOLO la acción MÍNIMA que dispara el endpoint objetivo (a menudo basta con recargar o con fijar el ÚNICO filtro del que depende ese endpoint; NO montes todo el contexto ni fijes filtros/inputs que no hagan falta). (2) Afirma el efecto de error (`cy.url().should('include', '/error')`). (3) PARA: NO sigas seleccionando/escribiendo en otros controles ni leas combos después, porque el redirect los desmonta y obtendrás `cy.select() failed because the page updated while this command was executing` o `detached from the DOM`. NO reintentes el flujo dentro del mismo `it`.",
    "- **VACÍO (200 [])**: la comprobación principal es el body vacío (`expect(response?.body).to.deep.eq([])`). Si el código muestra un mensaje/estado vacío concreto (texto o selector real), puedes aférralo; si no, la aserción de la respuesta es suficiente.",
    "- **PROHIBIDO afirmar recuentos EXACTOS de opciones de un `<select>`** (p. ej. `expect(selectable.length).to.eq(0)`): los desplegables suelen conservar una opción placeholder/por defecto CON value, así que el recuento NO será 0 y el test fallará (`expected 1 to equal 0`). Si necesitas comprobar que un desplegable no recibió datos ausentes, verifica que NINGUNA `option` coincide (por texto) con datos de la API (para `[]` es trivialmente cierto); NUNCA un recuento exacto.",
    "- **PROHIBIDO en CU vacío/error**: NO leas ni afirmes sobre controles distintos del afectado DIRECTAMENTE por ese endpoint, NI sobre el número de llamadas a otros endpoints. Estas asunciones (controles dependientes deshabilitados/vaciados) suelen ser FALSAS y rompen el test. NO asumas clases genéricas como `.error-message` o `.alert-danger` si no están en el código.",
    "- **EXCEPCIONES DE TERCEROS**: la app carga SDKs externos (login/cookies/analítica) que a veces lanzan `uncaught:exception` cross-origin (`Script error.`) ajenas a la prueba. El fichero `../support/e2e-helpers` YA registra un handler global que las ignora al importarse; NO añadas tu propio `Cypress.on('uncaught:exception', ...)` en el spec, basta con importar cualquier helper.",
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
    frontendIsFileList
      ? "## Ficheros frontend relevantes (ÁBRELOS con tus herramientas de fichero para derivar los selectores y el comportamiento reales; NO inventes selectores):"
      : "## Código frontend (fuente de selectores y comportamiento real):",
    frontendContext,
    promptOverride && promptOverride.trim().length > 0
      ? `\n## Instrucciones adicionales de esta ejecución:\n${promptOverride.trim()}`
      : "",
    fix
      ? [
          "",
          `## Spec actual que FALLA (intento previo #${fix.attempt}):`,
          "```ts",
          fix.currentSpec.trim(),
          "```",
          "",
          "## Salida de Cypress con los errores a corregir:",
          "```",
          fix.cypressOutput.trim(),
          "```",
          "",
          "## Cómo corregir (OBLIGATORIO):",
          "- Diagnostica CADA test fallido a partir del mensaje de aserción, el code-frame y el stack de la salida de Cypress.",
          "- Corrige la causa REAL del fallo aplicando TODAS las reglas de arriba (selectores literales del código, controles custom, valores sintéticos `[ngValue]`, esperar opciones asíncronas con `waitForSelectableOptions`, CU de error = acción mínima + `cy.url().should('include','/error')` + PARAR, no afirmar recuentos exactos de opciones, no tocar controles no afectados, etc.).",
          "- Si un `it()` YA pasaba, NO cambies su lógica salvo que sea imprescindible; céntrate en los que fallan.",
          "- No elimines Casos de Uso ni los conviertas en `it.skip`. Todos deben quedar ejecutables y en verde.",
        ].join("\n")
      : "",
    "",
    "## Salida:",
    "Devuelve ÚNICAMENTE el contenido del fichero `.cy.js`, sin explicaciones y sin vallas de código (` ``` `). Debe empezar por el `require` de `../support/e2e-helpers` y contener el `describe` con todos los `it` implementados de forma ejecutable.",
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
    "// Los tests E2E corren contra una app real cargada de SDKs de terceros (Gigya, cookies, analitica).",
    "// Esos scripts cross-origin lanzan excepciones no capturadas ('Script error.') ajenas a lo que probamos.",
    "// Por defecto Cypress tumbaria el test (incluso en beforeEach, saltandose toda la suite), asi que las ignoramos.",
    "// Se registra una sola vez al importar este modulo desde cualquier spec.",
    "if (typeof Cypress !== 'undefined' && typeof Cypress.on === 'function' && !Cypress.__qaUncaughtHandlerRegistered) {",
    "  Cypress.__qaUncaughtHandlerRegistered = true;",
    "  Cypress.on('uncaught:exception', () => false);",
    "}",
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
  const frontendRoot = requireFrontendRoot(context);
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
    "    specPattern: \"cypress/e2e/**/*.cy.js\",",
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
  const frontendRoot = requireFrontendRoot(context);
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

/**
 * Elimina del fixture de baseline las claves pertenecientes a un RF concreto
 * (p. ej. `rf-01.cu-1`), para que cada re-ejecución dentro del bucle de
 * corrección vuelva a autocapturar y no falle por deriva del baseline previo.
 */
async function clearBaselineForRf(frontendRoot: string, rfId: string): Promise<void> {
  const fixturesPath = path.resolve(frontendRoot, baselineFixtureRelativePath);
  const raw = await readTextIfExists(fixturesPath);
  if (!raw) return;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const prefix = `${rfId.toLowerCase()}.`;
  let changed = false;
  for (const key of Object.keys(data)) {
    if (key.toLowerCase().startsWith(prefix)) {
      delete data[key];
      changed = true;
    }
  }
  if (changed) {
    await fs.writeFile(fixturesPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

export interface E2EIterationResult {
  rf: string;
  file: string;
  passed: boolean;
  attempts: number;
  lastOutput?: string;
}

export interface GenerateE2EOptions {
  promptOverride?: string;
  /** Si true (por defecto), ejecuta Cypress e itera hasta que el spec pase. */
  runTests?: boolean;
  /** Número máximo de intentos (generación + correcciones) por RF. */
  maxIterations?: number;
  /** Subconjunto de ids de RF a generar (p. ej. ["RF-01","RF-03"]). Vacío = todos. */
  rfFilter?: string[];
  /** Comando base para ejecutar Cypress (por defecto el de la config o `npx cypress run`). */
  runCommand?: string;
  /** Timeout por ejecución de Cypress en ms. */
  runTimeoutMs?: number;
}

export async function generateE2ETests(
  context: LoadedContext,
  sample: E2ESampleFn,
  options: GenerateE2EOptions = {}
): Promise<{ files: string[]; rfCount: number; iterations: E2EIterationResult[] }> {
  const {
    promptOverride,
    runTests = true,
    maxIterations = 3,
    rfFilter,
    runTimeoutMs,
  } = options;
  const runCommand = options.runCommand ?? context.config.e2eRunCommand;

  await ensureFrontendCypressSetup(context);
  await writeBaselineAssets(context);

  const outputRoot = path.resolve(path.dirname(context.configPath), context.config.e2eTests);
  await fs.mkdir(outputRoot, { recursive: true });

  let entries: RfEntry[] = extractOrBuildRfEntries(context);
  if (rfFilter && rfFilter.length > 0) {
    const wanted = new Set(rfFilter.map((id) => id.trim().toLowerCase()));
    entries = entries.filter((e) => wanted.has(e.id.toLowerCase()));
    if (entries.length === 0) {
      throw new Error(
        `Ningún RF coincide con rfFilter=[${rfFilter.join(", ")}]. ` +
          "Revisa los ids de RF disponibles en rf-cu.md/openapi."
      );
    }
  }

  const files: string[] = [];
  const iterations: E2EIterationResult[] = [];
  const visitUrl = context.config.e2eBaseUrl ?? "/";

  const frontendRoot = requireFrontendRoot(context);
  const sources = await readFrontendSources(frontendRoot);
  const openApiContext = openApiSnippet(context.openApiContent);

  for (const entry of entries) {
    const fileName = `${slug(entry.id)}-${slug(entry.name)}.cy.js`;
    const fullPath = path.join(outputRoot, fileName);
    const specRelPath = path.relative(frontendRoot, fullPath).split(path.sep).join("/");

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

    if (!runTests) {
      iterations.push({ rf: entry.id, file: fullPath, passed: false, attempts: 1 });
      continue;
    }

    let passed = false;
    let attempts = 0;
    let lastOutput = "";

    for (let attempt = 1; attempt <= maxIterations; attempt++) {
      attempts = attempt;
      await clearBaselineForRf(frontendRoot, entry.id);

      const run = await runCypressSpecWithRepair({
        frontendRoot,
        specRelPath,
        runCommand,
        timeoutMs: runTimeoutMs,
        ...resolveE2ERuntime(context),
      });
      lastOutput = run.output;

      if (run.passed) {
        passed = true;
        break;
      }

      if (run.cacheError) {
        lastOutput = `${cypressCacheErrorNotice(resolveE2ERuntime(context).nodePath)}\n\n${run.output}`;
        break;
      }

      if (attempt >= maxIterations) {
        break;
      }

      const currentSpec = await fs.readFile(fullPath, "utf8");
      const fixPrompt = buildE2EGenerationPrompt({
        entry,
        rules: promptData.text,
        frontendContext,
        visitUrl,
        openApiContext,
        promptOverride,
        fix: {
          currentSpec,
          cypressOutput: extractCypressFailureSummary(run.output),
          attempt,
        },
      });

      const fixed = await sample(fixPrompt, 16000);
      if (fixed && fixed.trim().length > 0) {
        await fs.writeFile(fullPath, sanitizeGeneratedSpec(fixed), "utf8");
      }
    }

    iterations.push({
      rf: entry.id,
      file: fullPath,
      passed,
      attempts,
      lastOutput: passed ? undefined : extractCypressFailureSummary(lastOutput, 2000),
    });
  }

  return { files, rfCount: entries.length, iterations };
}

export interface E2EFallbackSpec {
  rf: string;
  name: string;
  /** Ruta absoluta donde el agente debe escribir el `.cy.js`. */
  filePath: string;
  /** Ruta relativa al frontend para usar con `--spec`. */
  specRelPath: string;
  /** Prompt de generación (mismas reglas que el modo sampling). */
  prompt: string;
}

export interface E2EFallbackResult {
  specs: E2EFallbackSpec[];
  /** Comando base para ejecutar Cypress (con `--spec`). */
  runCommand: string;
  /** Raíz del frontend desde donde ejecutar el comando. */
  frontendRoot: string;
  /** Nº de RF (en el ámbito) que aún NO están en verde. */
  pendingCount: number;
  /** Nº total de RF en el ámbito (tras aplicar rfFilter). */
  totalCount: number;
  /** Nº de RF (en el ámbito) ya en verde (según estado en disco). */
  greenCount: number;
  /** true si TODOS los specs del ámbito ya existen en disco. */
  allGenerated: boolean;
  /**
   * Siguiente acción del bucle RF-a-RF (modo `untilGreen`):
   * - `generate`: el RF actual no tiene spec; el agente debe generarlo (ver `specs[0]`).
   * - `run`: el RF actual ya tiene spec pero no está verde; ejecútalo con `runE2ETests`.
   * - `done`: todos los RF del ámbito están en verde.
   */
  nextAction: "generate" | "run" | "done";
  /** RF en curso (el primero no verde), para los mensajes de los modos `run`/`generate`. */
  current?: { rf: string; name: string; filePath: string; specRelPath: string };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Ruta del fichero de estado (qué RF están en verde) dentro del dir de specs. */
function e2eStatusPath(outputRoot: string): string {
  return path.join(outputRoot, ".qa-mcp-e2e-status.json");
}

interface E2EStatusEntry {
  green: boolean;
  at: string;
}

/**
 * Lee el estado persistido de los RF (verde/no verde). El estado vive en disco
 * (no en la conversación del cliente) para que el flujo RF-a-RF sea reanudable
 * desde una tarea NUEVA con contexto limpio: el servidor sabe por qué RF seguir.
 */
async function readE2EStatus(outputRoot: string): Promise<Record<string, E2EStatusEntry>> {
  const raw = await readTextIfExists(e2eStatusPath(outputRoot));
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as Record<string, E2EStatusEntry>;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function isRfGreen(status: Record<string, E2EStatusEntry>, rfId: string): boolean {
  return Boolean(status[rfId.toLowerCase()]?.green);
}

async function setRfGreen(outputRoot: string, rfId: string, green: boolean): Promise<void> {
  const status = await readE2EStatus(outputRoot);
  status[rfId.toLowerCase()] = { green, at: new Date().toISOString() };
  await fs.writeFile(e2eStatusPath(outputRoot), `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

/**
 * Modo ASISTIDO (sin MCP sampling): prepara el entorno Cypress (helpers,
 * config y baseline) y devuelve el prompt de generación + la ruta de salida
 * para que el agente del propio cliente (Roo/Cline/opencode) genere el spec,
 * lo escriba y lo ejecute. No requiere `createMessage`.
 *
 * Por defecto emite UN solo RF por llamada (el primero cuyo spec aún no existe)
 * para acotar el tamaño del resultado: cada prompt incluye un bundle de código
 * frontend grande y devolver todos a la vez desborda el contexto del cliente.
 * Llamadas sucesivas van avanzando por los RF pendientes.
 */
export async function prepareE2EFallback(
  context: LoadedContext,
  options: GenerateE2EOptions & {
    oneAtATime?: boolean;
    bundleMaxChars?: number;
    leanFrontend?: boolean;
    untilGreen?: boolean;
  } = {}
): Promise<E2EFallbackResult> {
  const {
    promptOverride,
    rfFilter,
    oneAtATime = false,
    bundleMaxChars,
    leanFrontend = false,
    untilGreen = false,
  } = options;
  const runCommand = options.runCommand ?? context.config.e2eRunCommand ?? "npx cypress run";

  await ensureFrontendCypressSetup(context);
  await writeBaselineAssets(context);

  const outputRoot = path.resolve(path.dirname(context.configPath), context.config.e2eTests);
  await fs.mkdir(outputRoot, { recursive: true });

  let entries: RfEntry[] = extractOrBuildRfEntries(context);
  if (rfFilter && rfFilter.length > 0) {
    const wanted = new Set(rfFilter.map((id) => id.trim().toLowerCase()));
    entries = entries.filter((e) => wanted.has(e.id.toLowerCase()));
    if (entries.length === 0) {
      throw new Error(
        `Ningún RF coincide con rfFilter=[${rfFilter.join(", ")}]. ` +
          "Revisa los ids de RF disponibles en rf-cu.md/openapi."
      );
    }
  }

  const visitUrl = context.config.e2eBaseUrl ?? "/";
  const frontendRoot = requireFrontendRoot(context);
  const openApiContext = openApiSnippet(context.openApiContent);
  const totalCount = entries.length;
  const status = await readE2EStatus(outputRoot);

  const targets = await Promise.all(
    entries.map(async (entry) => {
      const fileName = `${slug(entry.id)}-${slug(entry.name)}.cy.js`;
      const fullPath = path.join(outputRoot, fileName);
      const specRelPath = path.relative(frontendRoot, fullPath).split(path.sep).join("/");
      return {
        entry,
        fullPath,
        specRelPath,
        exists: await fileExists(fullPath),
        green: isRfGreen(status, entry.id),
      };
    })
  );

  const greenCount = targets.filter((t) => t.green).length;

  // Modo RF-a-RF-hasta-verde: el "RF en curso" es el primero que NO está verde.
  // Si su spec no existe → hay que generarlo; si existe → hay que ejecutarlo.
  if (untilGreen) {
    const notGreen = targets.filter((t) => !t.green);
    const pendingCount = notGreen.length;
    const current = notGreen[0];

    if (!current) {
      return {
        specs: [],
        runCommand,
        frontendRoot,
        pendingCount: 0,
        totalCount,
        greenCount,
        allGenerated: true,
        nextAction: "done",
      };
    }

    const currentInfo = {
      rf: current.entry.id,
      name: current.entry.name,
      filePath: current.fullPath,
      specRelPath: current.specRelPath,
    };

    if (current.exists) {
      // Ya generado pero no verde: no regenerar; el siguiente paso es ejecutarlo.
      return {
        specs: [],
        runCommand,
        frontendRoot,
        pendingCount,
        totalCount,
        greenCount,
        allGenerated: targets.every((t) => t.exists),
        nextAction: "run",
        current: currentInfo,
      };
    }

    const sources = await readFrontendSources(frontendRoot);
    const promptData = await loadE2EPrompt(context, current.entry, undefined, promptOverride);
    const frontendContext = leanFrontend
      ? buildRfFocusedFileList(sources, current.entry)
      : buildRfFocusedBundle(sources, current.entry, bundleMaxChars);
    const generationPrompt = buildE2EGenerationPrompt({
      entry: current.entry,
      rules: promptData.text,
      frontendContext,
      visitUrl,
      openApiContext,
      promptOverride,
      frontendIsFileList: leanFrontend,
    });

    return {
      specs: [
        {
          rf: current.entry.id,
          name: current.entry.name,
          filePath: current.fullPath,
          specRelPath: current.specRelPath,
          prompt: generationPrompt,
        },
      ],
      runCommand,
      frontendRoot,
      pendingCount,
      totalCount,
      greenCount,
      allGenerated: targets.every((t) => t.exists),
      nextAction: "generate",
      current: currentInfo,
    };
  }

  const pending = targets.filter((t) => !t.exists);
  const pendingCount = pending.length;
  const allGenerated = pendingCount === 0;

  const toEmit = oneAtATime ? pending.slice(0, 1) : targets;
  const sources = toEmit.length > 0 ? await readFrontendSources(frontendRoot) : [];

  const specs: E2EFallbackSpec[] = [];
  for (const target of toEmit) {
    const promptData = await loadE2EPrompt(context, target.entry, undefined, promptOverride);
    const frontendContext = leanFrontend
      ? buildRfFocusedFileList(sources, target.entry)
      : buildRfFocusedBundle(sources, target.entry, bundleMaxChars);

    const generationPrompt = buildE2EGenerationPrompt({
      entry: target.entry,
      rules: promptData.text,
      frontendContext,
      visitUrl,
      openApiContext,
      promptOverride,
      frontendIsFileList: leanFrontend,
    });

    specs.push({
      rf: target.entry.id,
      name: target.entry.name,
      filePath: target.fullPath,
      specRelPath: target.specRelPath,
      prompt: generationPrompt,
    });
  }

  return {
    specs,
    runCommand,
    frontendRoot,
    pendingCount,
    totalCount,
    greenCount,
    allGenerated,
    nextAction: allGenerated ? "done" : "generate",
  };
}

export interface E2ERunFixResult {
  rf: string;
  name: string;
  filePath: string;
  specRelPath: string;
  /** true si el spec pasó todos los `it()`. */
  passed: boolean;
  /** true si el fichero del spec no existe todavía (hay que generarlo antes). */
  missing: boolean;
  /** Extracto de la salida de Cypress (si falló). */
  output?: string;
  /** Prompt de corrección listo para el agente (si falló). */
  fixPrompt?: string;
  /** true si el fallo es por caché V8 corrupta de Cypress (error de ENTORNO). */
  cacheError?: boolean;
}

export interface E2ERunFallbackResult {
  results: E2ERunFixResult[];
  runCommand: string;
  frontendRoot: string;
  /** Ruta del mcp.config.json que el servidor cargó (para diagnóstico). */
  configPath?: string;
  /** true si Cypress se ejecutará con navegador visible (`--headed`). */
  headed?: boolean;
  /** Navegador configurado para la ejecución (`--browser`). */
  browser?: string;
  /** Nº total de RF en el ámbito (tras aplicar rfFilter). */
  totalCount?: number;
  /** Nº de RF en verde (según estado en disco) tras esta ejecución. */
  greenCount?: number;
  /** true si todos los RF del ámbito están en verde. */
  allGreen?: boolean;
  /**
   * Siguiente acción del bucle RF-a-RF (modo `untilGreen`):
   * - `fix`: el RF en curso ha fallado; reescríbelo y vuelve a llamar a `runE2ETests`.
   * - `next`: el RF en curso ha pasado; inicia tarea NUEVA y llama a `generateE2ETests`.
   * - `generate`: el RF en curso no tiene spec; genéralo con `generateE2ETests`.
   * - `done`: todos los RF del ámbito están en verde.
   */
  nextAction?: "fix" | "next" | "generate" | "done";
}

/**
 * Modo ASISTIDO (sin MCP sampling): EJECUTA Cypress sobre los specs ya escritos
 * y, para los que fallan, devuelve la salida real de Cypress + un prompt de
 * corrección (fix) listo para que el agente reescriba el spec e itere. El
 * servidor aporta la ejecución determinista (comando/rutas/limpieza de
 * baseline); el agente aporta la generación/corrección con su propio modelo.
 *
 * Por defecto solo construye el PROMPT DE CORRECCIÓN para el PRIMER RF que
 * falla (`oneFixAtATime`), para no desbordar el contexto del cliente: cada
 * prompt incluye un bundle grande de código frontend. El estado (pasa/falla)
 * se reporta para todos.
 */
export async function runE2EFallback(
  context: LoadedContext,
  options: GenerateE2EOptions & {
    oneFixAtATime?: boolean;
    bundleMaxChars?: number;
    leanFrontend?: boolean;
    untilGreen?: boolean;
  } = {}
): Promise<E2ERunFallbackResult> {
  const {
    promptOverride,
    rfFilter,
    runTimeoutMs,
    oneFixAtATime = true,
    bundleMaxChars,
    leanFrontend = false,
    untilGreen = false,
  } = options;
  const runCommand = options.runCommand ?? context.config.e2eRunCommand ?? "npx cypress run";

  const outputRoot = path.resolve(path.dirname(context.configPath), context.config.e2eTests);
  let entries: RfEntry[] = extractOrBuildRfEntries(context);
  if (rfFilter && rfFilter.length > 0) {
    const wanted = new Set(rfFilter.map((id) => id.trim().toLowerCase()));
    entries = entries.filter((e) => wanted.has(e.id.toLowerCase()));
    if (entries.length === 0) {
      throw new Error(
        `Ningún RF coincide con rfFilter=[${rfFilter.join(", ")}]. ` +
          "Revisa los ids de RF disponibles en rf-cu.md/openapi."
      );
    }
  }

  const visitUrl = context.config.e2eBaseUrl ?? "/";
  const frontendRoot = requireFrontendRoot(context);
  const openApiContext = openApiSnippet(context.openApiContent);

  const scopeCount = entries.length;
  const status = await readE2EStatus(outputRoot);
  const priorGreen = entries.filter((e) => isRfGreen(status, e.id)).length;
  const rt = resolveE2ERuntime(context);
  const diag = {
    configPath: context.configPath,
    headed: rt.headed,
    browser: rt.browser,
  };

  // Modo RF-a-RF-hasta-verde: ejecuta SOLO el RF en curso (el primero no verde,
  // o el indicado por rfFilter), para acotar la salida y el contexto del cliente.
  if (untilGreen) {
    const target = entries.find((e) => !isRfGreen(status, e.id));
    if (!target) {
      return {
        results: [],
        runCommand,
        frontendRoot,
        ...diag,
        totalCount: scopeCount,
        greenCount: priorGreen,
        allGreen: true,
        nextAction: "done",
      };
    }
    entries = [target];
  }

  interface Failure {
    result: E2ERunFixResult;
    entry: RfEntry;
    currentSpec: string;
    rawOutput: string;
  }

  const results: E2ERunFixResult[] = [];
  const failures: Failure[] = [];

  for (const entry of entries) {
    const fileName = `${slug(entry.id)}-${slug(entry.name)}.cy.js`;
    const fullPath = path.join(outputRoot, fileName);
    const specRelPath = path.relative(frontendRoot, fullPath).split(path.sep).join("/");

    let currentSpec: string;
    try {
      currentSpec = await fs.readFile(fullPath, "utf8");
    } catch {
      results.push({
        rf: entry.id,
        name: entry.name,
        filePath: fullPath,
        specRelPath,
        passed: false,
        missing: true,
      });
      continue;
    }

    await clearBaselineForRf(frontendRoot, entry.id);
    const run = await runCypressSpecWithRepair({
      frontendRoot,
      specRelPath,
      runCommand,
      timeoutMs: runTimeoutMs,
      ...resolveE2ERuntime(context),
    });

    if (run.passed) {
      await setRfGreen(outputRoot, entry.id, true);
      results.push({
        rf: entry.id,
        name: entry.name,
        filePath: fullPath,
        specRelPath,
        passed: true,
        missing: false,
      });
      continue;
    }

    await setRfGreen(outputRoot, entry.id, false);

    if (run.cacheError) {
      results.push({
        rf: entry.id,
        name: entry.name,
        filePath: fullPath,
        specRelPath,
        passed: false,
        missing: false,
        cacheError: true,
        output: `${cypressCacheErrorNotice(resolveE2ERuntime(context).nodePath)}\n\n${extractCypressFailureSummary(run.output, 2000)}`,
      });
      continue;
    }

    const result: E2ERunFixResult = {
      rf: entry.id,
      name: entry.name,
      filePath: fullPath,
      specRelPath,
      passed: false,
      missing: false,
      output: extractCypressFailureSummary(run.output, 2000),
    };
    results.push(result);
    failures.push({ result, entry, currentSpec, rawOutput: run.output });
  }

  const failuresToFix = oneFixAtATime ? failures.slice(0, 1) : failures;
  if (failuresToFix.length > 0) {
    const sources = await readFrontendSources(frontendRoot);
    for (const failure of failuresToFix) {
      const promptData = await loadE2EPrompt(context, failure.entry, undefined, promptOverride);
      const frontendContext = leanFrontend
        ? buildRfFocusedFileList(sources, failure.entry)
        : buildRfFocusedBundle(sources, failure.entry, bundleMaxChars);
      failure.result.fixPrompt = buildE2EGenerationPrompt({
        entry: failure.entry,
        rules: promptData.text,
        frontendContext,
        visitUrl,
        openApiContext,
        promptOverride,
        frontendIsFileList: leanFrontend,
        fix: {
          currentSpec: failure.currentSpec,
          cypressOutput: extractCypressFailureSummary(failure.rawOutput, 4000),
          attempt: 1,
        },
      });
    }
  }

  if (untilGreen) {
    const status2 = await readE2EStatus(outputRoot);
    const allEntries = extractOrBuildRfEntries(context);
    const scopeEntries =
      rfFilter && rfFilter.length > 0
        ? allEntries.filter((e) => rfFilter.map((id) => id.toLowerCase()).includes(e.id.toLowerCase()))
        : allEntries;
    const greenCount = scopeEntries.filter((e) => isRfGreen(status2, e.id)).length;
    const single = results[0];
    let nextAction: E2ERunFallbackResult["nextAction"];
    if (single?.missing) {
      nextAction = "generate";
    } else if (single?.passed) {
      nextAction = greenCount >= scopeCount ? "done" : "next";
    } else {
      nextAction = "fix";
    }
    return {
      results,
      runCommand,
      frontendRoot,
      ...diag,
      totalCount: scopeCount,
      greenCount,
      allGreen: greenCount >= scopeCount,
      nextAction,
    };
  }

  return { results, runCommand, frontendRoot, ...diag };
}

