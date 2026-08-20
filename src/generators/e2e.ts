import { promises as fs } from "node:fs";
import path from "node:path";
import { LoadedContext, RfEntry, CuCase } from "../types";
import { requireFrontendRoot } from "../config";
import { extractOrBuildRfEntries, inputActionContractErrors } from "../rfcu";
import { loadE2EPrompt } from "../prompts/loader";
import { E2E_CONTRACT_VERSION } from "../e2e-contract";
import {
  actionScreenshots,
  clearScreenshotEvidence,
  hasAllScreenshotEvidence,
  missingScreenshotCalls,
  persistScreenshotEvidence,
} from "../evidence-screenshots";
import { runCypressSpec, extractCypressFailureSummary, isCypressCacheError, repairCypressCache, CypressRunResult } from "./cypress-runner";

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Unidad de trabajo del bucle E2E: UN Caso de Uso (CU) que se genera, ejecuta y
 * corrige en su PROPIO fichero `.cy.js`. Aislar cada CU en su spec permite iterar
 * más rápido (cada ejecución de Cypress corre solo ese CU) y avanzar CU-a-CU.
 */
interface CuUnit {
  /** RF padre completo (para contexto/nombre). */
  rf: RfEntry;
  /** El CU concreto. */
  cu: CuCase;
  /** RfEntry con un ÚNICO caso (el CU): se pasa a los builders de prompt. */
  entry: RfEntry;
  /** Clave estable de estado/baseline: `${rf.id}.${cu.id}` (p. ej. "RF-1.CU-1"). */
  unitId: string;
  /** Base del nombre de fichero: `${slug(rf.id)}-${slug(cu.id)}-${slug(cu.name)}`. */
  fileBase: string;
}

/** Expande una lista de RF en unidades de CU (una por caso de uso). */
function expandToCuUnits(entries: RfEntry[]): CuUnit[] {
  const units: CuUnit[] = [];
  for (const rf of entries) {
    const cases = rf.cases.length > 0 ? rf.cases : [{ id: "CU-1", name: rf.name, steps: [] }];
    for (const cu of cases) {
      units.push({
        rf,
        cu,
        entry: { ...rf, cases: [cu] },
        unitId: `${rf.id}.${cu.id}`,
        fileBase: `${slug(rf.id)}-${slug(cu.id)}-${slug(cu.name)}`,
      });
    }
  }
  return units;
}

function requireRfCuInputActionContract(entries: RfEntry[]): void {
  const errors = entries.flatMap((rf) =>
    rf.cases.flatMap((cu) => inputActionContractErrors(rf.id, cu))
  );
  if (errors.length === 0) return;
  throw new Error(
    "rf-cu.md no permite generar evidencias independientes para todos los controles con datos de prueba:\n- " +
      errors.join("\n- ") +
      "\nEjecuta autoCompleteRfCu para declarar input/select/checkbox, separar cada interacción y añadir `acción NN` a cada control."
  );
}

/** Valor por defecto del NO_PROXY para entornos internos de AENA. */
const DEFAULT_E2E_NO_PROXY = "localhost,127.0.0.1,.aena.es";
/** Directorio de node por defecto (instalación nvm de AENA). */
const DEFAULT_E2E_NODE_PATH = "C:\\Users\\aena\\AppData\\Roaming\\nvm\\v24.16.0";
/** Electron no acepta sus switches desde launchOptions.args; Cypress exige esta variable. */
const ELECTRON_SCALE_ARGUMENT = "--force-device-scale-factor=1";

function requiredElectronLaunchArguments(configured: string | undefined): string {
  const current = configured?.trim() ?? "";
  const withoutConflictingScale = current
    .replace(/(?:^|\s)--force-device-scale-factor(?:=\S+)?(?=\s|$)/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return [withoutConflictingScale, ELECTRON_SCALE_ARGUMENT].filter(Boolean).join(" ");
}

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
  const configuredEnv = context.config.e2eEnv ?? {};
  const env: Record<string, string> = {
    NO_PROXY: DEFAULT_E2E_NO_PROXY,
    no_proxy: DEFAULT_E2E_NO_PROXY,
    ...configuredEnv,
    ELECTRON_EXTRA_LAUNCH_ARGS: requiredElectronLaunchArguments(
      configuredEnv.ELECTRON_EXTRA_LAUNCH_ARGS
    ),
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

function splitMethodPaths(methodPath: string): string[] {
  return methodPath.split(/\s*;\s*/).map((value) => value.trim()).filter(Boolean);
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
    "- `persistOrAssertBaseline(key, currentSnapshot, options?)`: autocaptura/compara el snapshot y rechaza cualquier valor Event/`[object Event]`.",
    "- `normalizeAmount(text)`: convierte importes/textos numéricos (con € y separadores) a número.",
    "- `findMatchingOption($options, textoOValor)`: localiza una <option> por texto o value.",
    "- `resolveNativeSelect(rootSelector)`: resuelve el `<select>` nativo aunque `rootSelector` apunte a un componente contenedor (custom control que envuelve un `<select>`, p. ej. un web component). Devuelve el `<select>` real (vía cy.then).",
    "- `getSelectOptions(rootSelector)`: devuelve (vía cy.then) `[{value,text,disabled}]` SIN esperar a que existan opciones. ÚSALO para aserciones de estado vacío/negativas (no cuelga).",
    "- `waitForSelectableOptions(rootSelector, minCount=1)`: espera (reintentable) a que el desplegable tenga opciones SELECCIONABLES (las options se rellenan de forma asíncrona tras la respuesta del backend) y devuelve entonces su snapshot. ÚSALO en escenarios NOMINALES antes de leer/validar opciones. NO uses `getSelectOptions` para afirmar que HAY opciones: leería demasiado pronto (0).",
    "- `selectRequiredOptionByTextOrValue(rootSelector, textoOValor)`: valida que existe y selecciona (resuelve el select nativo internamente).",
    "- `selectOptionByTextOrValueIfPresent(rootSelector, textoOValor)`: selecciona si existe.",
    "- `selectFirstSelectableOption(rootSelector)`: selecciona la primera opción válida.",
    "- `setInputValue(inputSelector, value)`: escribe mediante el setter nativo del input y emite `input`/`change` creados por la ventana de la aplicación (AUT), evitando eventos cross-realm. Además registra el valor para incluirlo automáticamente en el baseline.",
    "- `setNumericFieldValue(fieldSelector, value)`: igual para campos numéricos (usa `input:not([type=hidden])`).",
    "- `setValueByFormControl(componentSelector, formControlName, value)`: rellena `[formcontrolname=...] input`.",
    "- `setDocumentedInput(...)`: implementación especializada de input usada internamente por `setDocumentedControl`; no la llames directamente con el contrato actual.",
    "- `setDocumentedControl(evidenceKey, controlType, selector, value, screenshotBaseName)`: helper canónico para TODO control declarado en `Valores de controles`. Delega de forma segura en input/select/checkbox, valida el valor/estado visible tras cualquier re-render y genera la captura integrada.",
    "- `scrollIntoViewForEvidence(rootSelector)`: lleva un elemento al centro útil del viewport y comprueba que queda visible antes de interactuar con él.",
    "- `assertControlEnabled(rootSelector)`: afirma que un control (nativo O custom `empresas-ui-*`) está HABILITADO. Resuelve el `<input>/<select>/<button>` nativo interno; si es un web component sin nativo interno, comprueba ausencia de `disabled`/`aria-disabled`/clase `disabled`. RECIBE UN SELECTOR STRING (nunca un subject/chainable). ÚSALO SIEMPRE en lugar de `.should('be.enabled')` sobre un wrapper custom (el pseudo `:enabled` NO matchea web components y CUELGA).",
    "- `assertControlDisabled(rootSelector)`: idéntico pero afirma DESHABILITADO. RECIBE UN SELECTOR STRING. ÚSALO en vez de `.should('be.disabled')` sobre wrappers custom.",
    "- `getNativeControl(rootSelector)`: devuelve (vía cy.then) el elemento nativo (`input/select/textarea/button`) interno de un control custom, o el propio elemento si ya es nativo. Úsalo para aserciones `have.value`/`have.attr('placeholder')`/`be.enabled` sobre controles `empresas-ui-*`.",
    "- `assertUiButtonDisabled(labelOrText)` / `assertUiButtonEnabled(labelOrText)`: localizan un `empresas-ui-button`/`button` por su `label` (ATRIBUTO **o** PROPIEDAD Angular `[label]`), `aria-label` o TEXTO visible, y afirman deshabilitado/habilitado ELLOS MISMOS. RECIBEN UNA CADENA (label/texto), NO un subject. ÚSALOS DIRECTAMENTE para el estado de un botón: `assertUiButtonDisabled('simulador.btn_descarga_sim')`. **PROHIBIDO** envolver: nunca hagas `assertControlDisabled(findUiButtonByLabel(...))` (assertControlDisabled espera un SELECTOR STRING, no un chainable). `cy.get('empresas-ui-button[label=\"x\"]')` NO funciona si `label` es un binding `[label]=\"...\"` (propiedad, no atributo reflejado) → 'never found it'.",
    "- `findUiButtonByLabel(labelOrText)`: como los anteriores pero devuelve el subject del botón SOLO para CLICAR (`findUiButtonByLabel('x').click()`). Para AFIRMAR estado usa `assertUiButtonDisabled`/`assertUiButtonEnabled`, no lo pases a otro helper.",
    "- `dismissKnownOverlays(extraSelectors?)`: cierra mediante su UI banners de consentimiento reconocidos; los selectores extra registrados se reutilizan en las interacciones posteriores.",
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
    "  setDocumentedControl,",
    "  scrollIntoViewForEvidence,",
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
  for (const methodPath of splitMethodPaths(entry.methodPath)) {
    const endpointPath = endpointPathFromMethodPath(methodPath);
    for (const seg of endpointPath.split("/")) {
      const s = seg.replace(/[{}]/g, "").toLowerCase();
      if (s.length >= 4 && !/^\d+$/.test(s)) tokens.add(s);
    }
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
      const inputs = cu.inputValues === undefined
        ? "   Valores de controles: no declarados (documento legacy; conserva los valores literales que aparezcan en los pasos)."
        : cu.inputValues.length === 0
          ? "   Valores de controles: ninguno."
          : [
              "   Valores de controles (contrato exacto rf-cu.md ↔ spec ↔ baseline ↔ captura):",
              ...cu.inputValues.map(
                (input) =>
                  `   - clave baseline \`${input.key}\` | tipo \`${input.kind ?? "sin-tipo"}\` | selector \`${input.selector}\` | valor \`${input.value}\` | acción \`${String(input.actionNumber ?? 0).padStart(2, "0")}\``
              ),
            ].join("\n");
      return `- ${cu.id}: ${cu.name}\n   Clave baseline: "${entry.id}.${cu.id}"\n${inputs}\n   Pasos:\n${steps}`;
    })
    .join("\n");
}

function formatScreenshotContract(entry: RfEntry): string {
  return entry.cases
    .flatMap((cu) =>
      actionScreenshots(entry, cu).map((screenshot) => {
        const input = cu.inputValues?.find(
          (candidate) => candidate.actionNumber === screenshot.actionIndex + 1
        );
        return input
          ? `- Acción ${screenshot.actionIndex + 1} (${screenshot.action}): ` +
              `\`setDocumentedControl(${JSON.stringify(input.key)}, ${JSON.stringify(input.kind)}, ${JSON.stringify(input.selector)}, ${JSON.stringify(input.value)}, ${JSON.stringify(screenshot.baseName)});\` ` +
              "(la captura está integrada en el helper; NO añadas otro cy.screenshot para esta acción)"
          : `- Acción ${screenshot.actionIndex + 1} (${screenshot.action}): ` +
              `\`cy.screenshot("${screenshot.baseName}", { capture: "viewport", overwrite: true });\``;
      })
    )
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
  const methodPaths = splitMethodPaths(entry.methodPath);
  const operationIds = entry.operationId.split(/\s*;\s*/);
  const isUiOnly =
    /acción de UI|sin endpoint directo/i.test(entry.methodPath) ||
    /^ui-/i.test(entry.operationId);
  const endpointLine = isUiOnly
    ? `- Acción de UI SIN endpoint directo (${entry.operationId}). NO asumas una petición de API concreta: verifica el efecto OBSERVABLE en la UI (descarga/exportación, cálculo o validación en cliente, navegación, cambios de estado). Usa \`cy.intercept\` SOLO si al inspeccionar el código descubres una llamada real involucrada.`
    : methodPaths
        .map((methodPath, index) => {
          const method = methodPath.split(/\s+/)[0] ?? "GET";
          const glob = interceptGlobFromPath(endpointPathFromMethodPath(methodPath));
          return `- Endpoint asociado: \`${methodPath}\` (operationId: \`${operationIds[index] ?? "sin-operation-id"}\`).\n  Patrón de intercept sugerido: \`cy.intercept("${method}", "${glob}")\` (agnóstico al host).`;
        })
        .join("\n");

  return [
    fix
      ? "Eres un ingeniero de QA experto en Cypress. El spec E2E de más abajo FALLÓ al ejecutarse en Cypress. CORRÍGELO para que el `it()` de este CU pase sin errores, aplicando las reglas y usando la salida de Cypress para diagnosticar. Mantén la cobertura del Caso de Uso (NO lo elimines ni lo conviertas en `it.skip`)."
      : "Eres un ingeniero de QA experto en Cypress. Genera un fichero de test E2E COMPLETO y EJECUTABLE en JavaScript PLANO (`.cy.js`) para el siguiente Requisito Funcional y UN ÚNICO Caso de Uso (un `describe` con un solo `it`).",
    "",
    `## Requisito funcional: ${entry.id} — ${entry.name}`,
    endpointLine,
    `- URL de arranque para \`cy.visit\`: ${visitUrl}`,
    "",
    "## Casos de uso a implementar (este fichero cubre UN ÚNICO CU; genera un solo `it()` con su clave de baseline exacta):",
    formatCasesForPrompt(entry),
    "",
    "## Cómo implementar (OBLIGATORIO):",
    "- **JAVASCRIPT PLANO (CRÍTICO)**: el fichero es `.cy.js`, NO TypeScript. PROHIBIDO usar sintaxis TS: sin anotaciones de tipo (`: string`, `: number`, `param: Tipo`), sin aserciones `as` (`response.body as Array<...>`), sin `interface`/`type`, sin genéricos `<T>`, sin `!` de non-null. Escribe JavaScript ES2018 válido que un navegador ejecute sin transpilar tipos. (Cypress NO hace type-check; cualquier sintaxis TS rompe la ejecución del spec.)",
    "- Reutiliza los helpers compartidos importándolos de `../support/e2e-helpers` (NO reimplementes utilidades):",
    helperApiSummary(),
    "- Estructura: un `describe` para el RF, un `beforeEach` que haga `cy.visit(APP_URL)` + `dismissKnownOverlays()`, y un ÚNICO `it` para el CU de ESTE fichero (cada CU vive en su propio spec; NO añadas otros CU ni `it` adicionales). Nombre del `it`: `\"<CU-id> <nombre>\"`, en español.",
    "- **EVIDENCIAS DOCUMENTALES POR ACCIÓN (OBLIGATORIO)**: debe existir UNA captura por cada acción numerada, en el mismo orden, y la imagen debe demostrar visualmente la acción descrita. Toda acción asociada a `Valores de controles` usa la llamada exacta `setDocumentedControl(clave, tipo, selector, valor, screenshotBaseName)`: para input, select/dropdown y checkbox el helper espera cualquier re-render, vuelve a llevar el control al viewport, comprueba el valor/estado DOM, lo resalta y captura el dato visible. NO añadas un segundo screenshot. Para acciones sin control documentado, llama a `cy.screenshot` inmediatamente después de completar/verificar la acción. No agrupes interacciones ni capturas al final. No añadas extensión: Cypress genera el `.png` nativo.",
    "- **RESOLUCIÓN DE EVIDENCIAS**: el proyecto queda configurado a 1920x1080 con escala/DPR 1 (100 %). NO uses nunca `cy.viewport()` ni cambies el zoom: cy.viewport sólo cambia píxeles CSS y NO corrige el DPR físico. Electron recibe el switch mediante ELECTRON_EXTRA_LAUNCH_ARGS; el servidor rechazará cualquier PNG cuyo tamaño físico no sea exactamente 1920x1080.",
    "- **VIEWPORT ANTES DE TODA INTERACCIÓN (OBLIGATORIO)**: antes de click/select/escritura/check sobre CUALQUIER elemento de UI, ese elemento debe entrar completo en el viewport y no quedar tapado por ningún elemento fijo, sticky u overlay. Los helpers compartidos ya lo centran, cierran mediante su UI los banners de consentimiento reconocidos y reintentan de forma acotada si aparecen durante el repintado. PROHIBIDO borrar u ocultar arbitrariamente el elemento que ocluye; ante un bloqueador desconocido, conserva el DOM y usa el diagnóstico del helper. Si el proyecto tiene un banner propio, registra su control de cierre literal una vez con `dismissKnownOverlays(['selector'])`. Para cualquier interacción Cypress directa, llama inmediatamente antes a `scrollIntoViewForEvidence('<selector>')`; NO uses `.scrollIntoView()` directamente porque `be.visible` no detecta oclusiones. Esto es especialmente obligatorio antes de expandir un acordeón. La captura de la acción se toma DESPUÉS, mientras el control accionado sigue expuesto.",
    "- Nombres exactos de las capturas requeridas para este CU:",
    formatScreenshotContract(entry),
    "- **REGLA CRÍTICA DE SELECTORES**: usa ÚNICAMENTE selectores que aparezcan LITERALMENTE en el código frontend proporcionado (busca `id=\"...\"`, `formcontrolname=\"...\"`, tags de componentes `app-*`/`empresas-ui-*`, clases CSS, `data-*`, y textos exactos de botones). PROHIBIDO inventar selectores a partir del `operationId` o de nombres en inglés del OpenAPI. Si el endpoint es `get-salesOrganizations` pero en el HTML el control es `id=\"sociedad\"`, DEBES usar `#sociedad`, nunca `[formcontrolname='salesOrganization']`.",
    "- Antes de escribir cada selector, localízalo en el bloque de código frontend. Si un campo/desplegable no existe con ese nombre, busca el equivalente real (a menudo en español) en las plantillas.",
    "- **CONTROLES CUSTOM (MUY IMPORTANTE)**: muchos controles son web components que envuelven un elemento nativo (p. ej. `<empresas-ui-dropdown id=\"sociedad\">` contiene un `<select>` nativo, `<empresas-ui-input>` contiene un `<input>`). NUNCA llames `.select()` ni `.find('option')` directamente sobre el wrapper custom: fallará (`cy.select() can only be called on a <select>`). En su lugar:",
    "   - Para desplegables con dato declarado usa SIEMPRE `setDocumentedControl(clave, 'select', selector, textoVisibleExacto, captura)`. Sólo para documentos legacy se permiten `selectFirstSelectableOption('#sociedad')` y `selectRequiredOptionByTextOrValue('#sociedad', 'texto')`.",
    "   - Para LEER opciones en escenarios NOMINALES (afirmar que HAY opciones) usa `waitForSelectableOptions('#sociedad').then((opts) => { ... })`, que ESPERA a que se rellenen (son asíncronas). NO uses `getSelectOptions` para eso: leería 0 antes de que Angular renderice las `<option>`.",
    "   - Para LEER opciones en escenarios VACÍOS/negativos usa `getSelectOptions('#sociedad').then((opts) => { ... })`. NUNCA uses `cy.get('#sociedad').find('option')` porque `.find` reintenta hasta que exista una opción y COLGARÁ el test en escenarios vacíos.",
    "   - Para CUALQUIER control declarado usa exclusivamente `setDocumentedControl`; sólo para documentos legacy sin bloque canónico se permiten `setDocumentedInput`, `setInputValue`/`setNumericFieldValue`/`setValueByFormControl` y los helpers legacy de selects. La rama input resuelve el `<input>` interno, usa su setter nativo y crea `input`/`change` con `input.ownerDocument.defaultView.Event` (la misma ventana que la aplicación).",
    "   - Si rf-cu.md declara `Valores de controles`, usa EXCLUSIVAMENTE la llamada literal de CINCO argumentos indicada en el contrato de capturas: `setDocumentedControl('<clave-baseline>', '<input|select|checkbox>', '<selector>', '<valor>', '<rfx_cuy_NN>')`. Todo coincide CARÁCTER A CARÁCTER con rf-cu.md. En selects, el valor es el TEXTO VISIBLE exacto; en checkbox, `true`/`false`. No uses constantes, valores calculados ni helpers alternativos. El servidor comprueba spec, baseline y evidencia.",
    "- **UNA INTERACCIÓN POR ACCIÓN/CAPTURA**: está prohibido ejecutar dos escrituras, selecciones, clicks o aperturas de acordeón antes de la misma evidencia. Cada interacción indicada en rf-cu.md se implementa y captura por separado; en particular, cada input o dropdown usa su propia llamada setDocumentedControl y su propia acción.",
    "   - **PROHIBIDO reimplementar helpers locales de escritura o usar `clear()`/`type()`/`invoke('val')`/`trigger('input'/'change')` directamente (CORRUPCIÓN `[object Event]`)**: Cypress puede crear esos eventos en una ventana distinta de la aplicación; entonces una comprobación Angular `value instanceof Event` falla y el componente guarda el objeto Event como valor. Importa y usa exclusivamente los helpers compartidos.",
    "   - **ASERCIONES enabled/disabled SOBRE CONTROLES CUSTOM (CAUSA FRECUENTE DE FALLO)**: NUNCA hagas `.should('be.enabled')`/`.should('be.disabled')` directamente sobre un wrapper `empresas-ui-*` (`#pesoAeronave`, `empresas-ui-button`, ...). El pseudo-selector jQuery `:enabled`/`:disabled` SOLO matchea controles nativos (`input/select/textarea/button`), así que sobre un web component NUNCA matchea y el test AGOTA el timeout (`expected '<empresas-ui-input#pesoAeronave...>' to be 'enabled'`). Usa SIEMPRE `assertControlEnabled('#pesoAeronave')` / `assertControlDisabled('#selector')` (resuelven el nativo interno o comprueban `disabled`/`aria-disabled`/clase). Para `have.value`/`have.attr('placeholder')` sobre un control custom, usa `getNativeControl('#id').should('have.attr','placeholder', ...)`, no el wrapper.",
    "   - **NO ASUMAS QUE UN BOTÓN DE ACCIÓN SE DESHABILITA POR UNA VALIDACIÓN/SELECCIÓN INCOMPLETA (CAUSA FRECUENTE DE FALLO)**: en un CU de validación negativa NO stubeado (p. ej. \"seleccionar sociedad pero NO aeropuerto → el botón Descargar está deshabilitado\"), NO des por hecho que el botón queda `disabled`. Muchos botones permanecen HABILITADOS y la validación se manifiesta de OTRA forma (mensaje de error, atributo `viewValidation`/`ng-invalid`/clase de error en el campo, o error al pulsar). Antes de afirmar `assertUiButtonDisabled(...)`: (1) LOCALIZA en la plantilla el binding `[disabled]=\"...\"` (o `[isDisabled]`) del botón y comprueba de qué depende REALMENTE; si NO depende del control que dejaste incompleto (o no existe tal binding), NO afirmes `disabled` (fallarías con `expected false to equal true`). (2) En su lugar, afirma el INDICADOR DE ERROR real que el código renderiza para ese campo (p. ej. `cy.get('#selectAirport').should('have.attr','viewValidation')` / clase de error / mensaje literal presente en el HTML). (3) Mantén la INTENCIÓN del CU (verificar el escenario inválido) pero adáptala al comportamiento REAL observable del código, sin inventar `disabled` ni mensajes que no existan. Regla equivalente para HABILITAR: no asumas que un botón se habilita solo por rellenar un campo si el `[disabled]` depende de más condiciones.",
    "   - **SELECTOR DE UN SOLO ELEMENTO ANTES DE `have.attr`/`be.disabled` (CAUSA FRECUENTE DE FALLO)**: si un tag de componente se repite (p. ej. hay 7 `empresas-ui-button`), `cy.get('empresas-ui-button').should('have.attr','label', X)` FALLA (`expected '[ <empresas-ui-button.filtro>, 6 more... ]' to have attribute 'label'`) porque asevera sobre el conjunto. ACOTA a un único elemento: para botones usa `assertUiButtonDisabled('<label>')`/`assertUiButtonEnabled('<label>')`/`findUiButtonByLabel('<label>')` (matchean por atributo O propiedad O texto); para otros, un `id`/`class`/`data-*` literal o `.contains(...)`. NUNCA aseveres un atributo sobre un match múltiple.",
    "   - **BINDINGS DE PROPIEDAD ANGULAR NO SON ATRIBUTOS (CAUSA FRECUENTE DE FALLO)**: en las plantillas, `[label]=\"...\"`, `[placeholder]=\"...\"`, `[title]=\"...\"` fijan una PROPIEDAD JS del elemento, que a menudo NO se refleja como atributo HTML. Por eso `cy.get('empresas-ui-button[label=\"...\"]')` puede NUNCA encontrar el botón (`Expected to find element ... but never found it`), aunque en el HTML veas `[label]=\"'...'\"`. Para localizar botones usa `assertUiButtonDisabled('<labelKey o texto>')` / `assertUiButtonEnabled(...)` / `findUiButtonByLabel(...)` (matchean por atributo O propiedad O texto). Para otros controles, filtra por propiedad: `cy.get('tag').filter((i,el)=> el.<prop> === '<valor>').first()`, o usa un `id`/`class`/`data-*`/atributo SIN corchetes presente literal en la plantilla.",
    "   - **TEXTOS i18n: LA PLANTILLA TIENE CLAVES, EL RUNTIME MUESTRA TRADUCCIONES (CAUSA FRECUENTE DE FALLO)**: en el HTML, `placeholder`, `label`, textos de botón, etc. suelen ser CLAVES i18n (p. ej. `simulador.filtros.peso.placeholder`) que en EJECUCIÓN se renderizan TRADUCIDAS (p. ej. `'Por favor indique el peso de la aeronave'`). NUNCA afirmes que un `placeholder`/`label`/texto es IGUAL a la clave que leíste en la plantilla (`expected -'Por favor...' +'simulador.filtros.peso.placeholder'`). En su lugar: (1) para el campo, comprueba EXISTENCIA/estado (`assertControlEnabled('#id')`, `getNativeControl('#id').should('have.attr','placeholder')` SIN valor exacto, o `.should('not.have.value','')`); (2) si quieres registrar el texto, MÉTELO EN EL SNAPSHOT del baseline (valor real leído del DOM), no lo hardcodees; (3) si debes comparar contra un literal, usa el TEXTO TRADUCIDO real o una coincidencia parcial insensible a mayúsculas, nunca la clave.",
    "   - **NO METAS CHAINABLES `cy.*` EN EL SNAPSHOT, Y NUNCA USES `Promise.all`/`async`/`await` SOBRE COMANDOS CYPRESS (CAUSA FRECUENTE DE FALLO)**: los comandos `cy.*` NO son promesas reales; envolverlos en `Promise.all([...])` o `await` lanza `CypressError: returned a promise from a command while also invoking cy commands`. Para leer varios valores del DOM y meterlos en el baseline, ACUMULA en un objeto plano a través de `.then` SECUENCIALES y construye el snapshot en un `cy.then` FINAL. Ejemplo CORRECTO:",
    "         `const snap = { api: response.body, ui: {} };`",
    "         `getNativeControl('#sociedad').then(($s) => { snap.ui.sociedad = $s.find('option:selected').text(); });`",
    "         `getNativeControl('#selectAirport').then(($a) => { snap.ui.aeropuerto = $a.find('option:selected').text(); });`",
    "         `cy.then(() => persistOrAssertBaseline('<RF>.<CU>', snap));`",
    "       PROHIBIDO: `Promise.all([getNativeControl(...).then(...), ...]).then(([a,b]) => persistOrAssertBaseline(...))` y cualquier `async (…) => { const x = await cy.get(...) }`.",
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
          "- Conserva exactamente las llamadas `setDocumentedControl` de cinco argumentos exigidas por rf-cu.md (clave, tipo, selector, valor, captura y orden); cada una genera la evidencia de SU control después de verificar el dato visible.",
          "- Antes de toda interacción de UI conserva o añade el scroll al viewport; `openAccordionByComponent` ya desplaza el encabezado del acordeón antes de abrirlo.",
          "- Conserva o restaura TODAS las llamadas `cy.screenshot` obligatorias, cada una inmediatamente después de su acción correspondiente.",
        ].join("\n")
      : "",
    "",
    "## Salida:",
    "Devuelve ÚNICAMENTE el contenido del fichero `.cy.js`, sin explicaciones y sin vallas de código (` ``` `). Debe empezar por el `require` de `../support/e2e-helpers` y contener el `describe` con el ÚNICO `it` de este CU, implementado de forma ejecutable.",
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

export function buildE2EHelpersFile(): string {
  return [
    "const {",
    "  DEFAULT_NUMERIC_TOLERANCE,",
    "  compareBaselineRecord",
    "} = require('./e2e-baseline');",
    "",
    "const DEFAULT_BASELINE_FIXTURE = 'cypress/fixtures/e2e-baseline.json';",
    "const DEFAULT_OVERLAY_DISMISS_SELECTORS = [",
    "  '#onetrust-reject-all-handler',",
    "  '#onetrust-accept-btn-handler',",
    "  '#CybotCookiebotDialogBodyButtonDecline',",
    "  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',",
    "  '#didomi-notice-disagree-button',",
    "  '#didomi-notice-agree-button',",
    "  '[data-testid=\"uc-deny-all-button\"]',",
    "  '[data-testid=\"uc-accept-all-button\"]'",
    "];",
    "const overlayDismissSelectors = new Set(DEFAULT_OVERLAY_DISMISS_SELECTORS);",
    "const attemptedOverlayControls = new WeakSet();",
    "const attemptedOverlayContainers = new WeakSet();",
    "const MAX_KNOWN_OVERLAY_RETRIES = 4;",
    "const MAX_OVERLAY_CLOSE_POLLS = 20;",
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
    "  scrollIntoViewForEvidence(rootSelector).then(() => resolveNativeSelect(rootSelector)).then(($select) => {",
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
    "  scrollIntoViewForEvidence(rootSelector).then(() => resolveNativeSelect(rootSelector)).then(($select) => {",
    "    const match = findMatchingOption($select.find('option'), expectedTextOrValue);",
    "    if (!match) return;",
    "    cy.wrap($select).select(match.value || (match.textContent || '').trim(), { force: true });",
    "  });",
    "}",
    "",
    "function selectFirstSelectableOption(rootSelector) {",
    "  scrollIntoViewForEvidence(rootSelector).then(() => resolveNativeSelect(rootSelector)).then(($select) => {",
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
    "const trackedInputValues = {};",
    "",
    "if (typeof Cypress !== 'undefined' && typeof Cypress.on === 'function') {",
    "  Cypress.on('test:before:run', () => {",
    "    Object.keys(trackedInputValues).forEach((key) => delete trackedInputValues[key]);",
    "  });",
    "}",
    "",
    "function normalizeOverlayText(value) {",
    "  return String(value || '').replace(/\\s+/g, ' ').trim();",
    "}",
    "",
    "function overlayControlLabels(element) {",
    "  if (!element) return [];",
    "  return [",
    "    element.getAttribute && element.getAttribute('aria-label'),",
    "    element.getAttribute && element.getAttribute('title'),",
    "    element.value,",
    "    element.label,",
    "    element.textContent",
    "  ].map(normalizeOverlayText).filter(Boolean);",
    "}",
    "",
    "function isConsentActionControl(element) {",
    "  const consentAction = /^(?:accept(?: all)?|allow(?: all)?|agree|reject(?: all)?|decline(?: all)?|deny(?: all)?|aceptar(?: todas?)?|rechazar(?: todas?)?|permitir(?: todas?)?|continuar sin aceptar|tout accepter|tout refuser|alle akzeptieren|alle ablehnen|accetta tutto|rifiuta tutto|aceitar todos?|rejeitar todos?)$/i;",
    "  return overlayControlLabels(element).some((label) => consentAction.test(label));",
    "}",
    "",
    "function isRenderedOverlayControl(element, appWindow) {",
    "  if (!element || !element.isConnected) return false;",
    "  const rect = element.getBoundingClientRect();",
    "  if (rect.width <= 0 || rect.height <= 0) return false;",
    "  const style = appWindow.getComputedStyle(element);",
    "  return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0';",
    "}",
    "",
    "function overlayIdentity(element) {",
    "  if (!element) return '';",
    "  const className = typeof element.className === 'string' ? element.className : '';",
    "  return normalizeOverlayText([",
    "    element.id,",
    "    className,",
    "    element.getAttribute && element.getAttribute('data-testid'),",
    "    element.getAttribute && element.getAttribute('aria-label')",
    "  ].filter(Boolean).join(' '));",
    "}",
    "",
    "function findRecognizedConsentContainer(element, appWindow) {",
    "  const documentBody = element && element.ownerDocument && element.ownerDocument.body;",
    "  let current = element;",
    "  while (current && current !== documentBody) {",
    "    const identity = overlayIdentity(current);",
    "    const role = normalizeOverlayText(current.getAttribute && current.getAttribute('role')).toLowerCase();",
    "    const ariaModal = normalizeOverlayText(current.getAttribute && current.getAttribute('aria-modal')).toLowerCase();",
    "    const text = normalizeOverlayText(current.textContent).slice(0, 2000);",
    "    const hasConsentMarker = /(?:^|[\\s_-])(?:cookie|cookies|consent|privacy|privacidad|gdpr|cmp|onetrust|cookiebot|didomi|usercentrics)(?:$|[\\s_-])/i.test(`${identity} ${text}`);",
    "    const hasVendorMarker = /(?:onetrust|cookiebot|didomi|usercentrics|cookie[-_ ]?(?:banner|consent)|consent[-_ ]?(?:banner|notice|dialog|sdk))/i.test(identity);",
    "    const style = appWindow.getComputedStyle(current);",
    "    const hasOverlaySemantics = role === 'dialog' || role === 'alertdialog' || ariaModal === 'true' || style.position === 'fixed' || style.position === 'sticky';",
    "    if (hasVendorMarker || (hasConsentMarker && hasOverlaySemantics)) return current;",
    "    current = current.parentElement;",
    "  }",
    "  return null;",
    "}",
    "",
    "function registerOverlayDismissSelectors(extraSelectors) {",
    "  const selectors = Array.isArray(extraSelectors)",
    "    ? extraSelectors",
    "    : (typeof extraSelectors === 'string' ? [extraSelectors] : []);",
    "  selectors.forEach((selector) => {",
    "    if (typeof selector !== 'string' || !selector.trim()) {",
    "      throw new Error('Los selectores extra de overlay deben ser strings no vacíos.');",
    "    }",
    "    overlayDismissSelectors.add(selector.trim());",
    "  });",
    "}",
    "",
    "function queryRenderedOverlayControl(body, selector, appWindow) {",
    "  let matches;",
    "  try {",
    "    matches = body.querySelectorAll(selector);",
    "  } catch (error) {",
    "    throw new Error(`Selector de cierre de overlay inválido \"${selector}\": ${error.message}`);",
    "  }",
    "  return Array.from(matches).find((element) => {",
    "    const container = findRecognizedConsentContainer(element, appWindow);",
    "    return !attemptedOverlayControls.has(element) &&",
    "      !(container && attemptedOverlayContainers.has(container)) &&",
    "      isRenderedOverlayControl(element, appWindow);",
    "  }) || null;",
    "}",
    "",
    "function findConsentDismissControl(body, appWindow) {",
    "  for (const selector of overlayDismissSelectors) {",
    "    const explicitControl = queryRenderedOverlayControl(body, selector, appWindow);",
    "    if (explicitControl) return explicitControl;",
    "  }",
    "  const controls = body.querySelectorAll('button, [role=\"button\"], input[type=\"button\"], input[type=\"submit\"], empresas-ui-button');",
    "  return Array.from(controls).find((element) => {",
    "    const container = findRecognizedConsentContainer(element, appWindow);",
    "    return !attemptedOverlayControls.has(element) &&",
    "      Boolean(container) &&",
    "      !attemptedOverlayContainers.has(container) &&",
    "      isRenderedOverlayControl(element, appWindow) &&",
    "      isConsentActionControl(element);",
    "  }) || null;",
    "}",
    "",
    "function evidenceSamplePoints(rect) {",
    "  const insetX = Math.min(Math.max(rect.width * 0.15, 1), rect.width / 2);",
    "  const insetY = Math.min(Math.max(rect.height * 0.15, 1), rect.height / 2);",
    "  return [",
    "    { name: 'centro', x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },",
    "    { name: 'superior izquierdo', x: rect.left + insetX, y: rect.top + insetY },",
    "    { name: 'superior derecho', x: rect.right - insetX, y: rect.top + insetY },",
    "    { name: 'inferior izquierdo', x: rect.left + insetX, y: rect.bottom - insetY },",
    "    { name: 'inferior derecho', x: rect.right - insetX, y: rect.bottom - insetY }",
    "  ];",
    "}",
    "",
    "function isElementHitRelatedToTarget(element, hit) {",
    "  return Boolean(hit && (hit === element || element.contains(hit) || hit.contains(element)));",
    "}",
    "",
    "function evidenceOcclusions(element) {",
    "  const rect = element.getBoundingClientRect();",
    "  return evidenceSamplePoints(rect)",
    "    .map((point) => ({ ...point, element: element.ownerDocument.elementFromPoint(point.x, point.y) }))",
    "    .filter((hit) => !isElementHitRelatedToTarget(element, hit.element));",
    "}",
    "",
    "function describeDomElement(element) {",
    "  if (!element) return '<ningún elemento>';",
    "  const tag = String(element.tagName || 'element').toLowerCase();",
    "  const id = element.id ? `#${element.id}` : '';",
    "  const className = typeof element.className === 'string'",
    "    ? element.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3).map((name) => `.${name}`).join('')",
    "    : '';",
    "  const role = element.getAttribute && element.getAttribute('role');",
    "  const ariaLabel = element.getAttribute && element.getAttribute('aria-label');",
    "  return `<${tag}${id}${className}${role ? ` role=\"${role}\"` : ''}${ariaLabel ? ` aria-label=\"${ariaLabel}\"` : ''}>`;",
    "}",
    "",
    "function waitForDismissedOverlay(container, appWindow, poll = 0) {",
    "  if (!container || !container.isConnected || !isRenderedOverlayControl(container, appWindow)) {",
    "    return waitForApplicationPaint();",
    "  }",
    "  if (poll >= MAX_OVERLAY_CLOSE_POLLS) {",
    "    throw new Error(`${describeDomElement(container)} no se cerró tras accionar su control de consentimiento.`);",
    "  }",
    "  return cy.wait(100, { log: false }).then(() =>",
    "    waitForDismissedOverlay(container, appWindow, poll + 1)",
    "  );",
    "}",
    "",
    "function centerElementForEvidence($element, description, retry = 0) {",
    "  const element = $element && $element[0];",
    "  expect(element, `elemento de evidencia ${description}`).to.exist;",
    "  element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });",
    "  return dismissKnownOverlays()",
    "    .then(() => waitForApplicationPaint())",
    "    .then(() => {",
    "      expect(element.isConnected, `${description} se desmontó del DOM`).to.eq(true);",
    "      element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });",
    "      return waitForApplicationPaint();",
    "    })",
    "    .then(() => {",
    "      const rect = element.getBoundingClientRect();",
    "      const appWindow = element.ownerDocument && element.ownerDocument.defaultView;",
    "      expect(appWindow, `ventana de ${description}`).to.exist;",
    "      expect(rect.width, `${description} sin anchura renderizada`).to.be.greaterThan(0);",
    "      expect(rect.height, `${description} sin altura renderizada`).to.be.greaterThan(0);",
    "      expect(rect.top, `${description} fuera del borde superior`).to.be.at.least(0);",
    "      expect(rect.bottom, `${description} fuera del borde inferior`).to.be.at.most(appWindow.innerHeight);",
    "      expect(rect.left, `${description} fuera del borde izquierdo`).to.be.at.least(0);",
    "      expect(rect.right, `${description} fuera del borde derecho`).to.be.at.most(appWindow.innerWidth);",
    "      const occlusions = evidenceOcclusions(element);",
    "      if (occlusions.length === 0) {",
    "        return cy.wrap($element, { log: false }).should('be.visible');",
    "      }",
    "      const allKnownConsent = occlusions.every((hit) =>",
    "        Boolean(findRecognizedConsentContainer(hit.element, appWindow))",
    "      );",
    "      if (allKnownConsent && retry < MAX_KNOWN_OVERLAY_RETRIES) {",
    "        return cy.wait(75, { log: false }).then(() =>",
    "          centerElementForEvidence($element, description, retry + 1)",
    "        );",
    "      }",
    "      const blockers = occlusions",
    "        .map((hit) => `${hit.name}: ${describeDomElement(hit.element)}`)",
    "        .filter((value, index, values) => values.indexOf(value) === index)",
    "        .join(', ');",
    "      throw new Error(",
    "        `${description} está tapado (${blockers}). ` +",
    "        'El helper no elimina elementos desconocidos. Cierra el overlay mediante la UI o registra su control con dismissKnownOverlays([selector]).'",
    "      );",
    "    });",
    "}",
    "",
    "function scrollIntoViewForEvidence(rootSelector) {",
    "  return cy.get(rootSelector, { timeout: 10000 }).first().then(($root) =>",
    "    centerElementForEvidence($root, rootSelector)",
    "  );",
    "}",
    "",
    "function inputEvidenceKey(inputSelector, nativeInput, explicitKey) {",
    "  if (explicitKey) return explicitKey;",
    "  const formControlName = nativeInput.getAttribute('formcontrolname');",
    "  if (formControlName) return formControlName;",
    "  if (nativeInput.id) return nativeInput.id;",
    "  const ownerWithId = nativeInput.parentElement && nativeInput.parentElement.closest('[id]');",
    "  if (ownerWithId && ownerWithId.id) return ownerWithId.id;",
    "  return inputSelector;",
    "}",
    "",
    "function setNativeInputValue(nativeInput, valueAsText) {",
    "  const appWindow = nativeInput.ownerDocument && nativeInput.ownerDocument.defaultView;",
    "  if (!appWindow) throw new Error('No se pudo resolver la ventana de la aplicación para el input.');",
    "  const prototype = nativeInput.tagName === 'TEXTAREA'",
    "    ? appWindow.HTMLTextAreaElement.prototype",
    "    : appWindow.HTMLInputElement.prototype;",
    "  const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;",
    "  if (!valueSetter) throw new Error('No se pudo resolver el setter nativo value del input.');",
    "",
    "  nativeInput.focus();",
    "  valueSetter.call(nativeInput, valueAsText);",
    "  nativeInput.dispatchEvent(new appWindow.Event('input', { bubbles: true, composed: true }));",
    "  nativeInput.dispatchEvent(new appWindow.Event('change', { bubbles: true, composed: true }));",
    "  nativeInput.blur();",
    "}",
    "",
    "function setInputValue(inputSelector, value, evidenceKey) {",
    "  const valueAsText = String(value);",
    "  return scrollIntoViewForEvidence(inputSelector)",
    "    .then(($input) => {",
    "      const nativeInput = $input[0];",
    "      if (!nativeInput || !/^(INPUT|TEXTAREA)$/.test(nativeInput.tagName)) {",
    "        throw new Error(`El selector \"${inputSelector}\" no resolvió un input/textarea nativo.`);",
    "      }",
    "      setNativeInputValue(nativeInput, valueAsText);",
    "      return cy.get(inputSelector, { timeout: 10000 })",
    "        .first()",
    "        .should('have.value', valueAsText)",
    "        .then(($verifiedInput) => {",
    "          const verifiedInput = $verifiedInput[0];",
    "          const key = inputEvidenceKey(inputSelector, verifiedInput, evidenceKey);",
    "          trackedInputValues[key] = String(verifiedInput.value);",
    "        });",
    "    });",
    "}",
    "",
    "function resolveDocumentedNativeInput($root, inputSelector) {",
    "  const $visibleNative = $root",
    "    .find('input:not([type=hidden]), textarea')",
    "    .filter(':visible')",
    "    .first();",
    "  const $native = $root.is('input:not([type=hidden]), textarea')",
    "    ? $root",
    "    : ($visibleNative.length ? $visibleNative : $root.find('input:not([type=hidden]), textarea').first());",
    "  const nativeInput = $native[0];",
    "  if (!nativeInput || !/^(INPUT|TEXTAREA)$/.test(nativeInput.tagName)) {",
    "    throw new Error(`El selector documentado \"${inputSelector}\" no contiene un input/textarea nativo.`);",
    "  }",
    "  return $native;",
    "}",
    "",
    "function waitForApplicationPaint() {",
    "  return cy.window({ log: false }).then((appWindow) =>",
    "    new Cypress.Promise((resolve) => {",
    "      appWindow.requestAnimationFrame(() => appWindow.requestAnimationFrame(resolve));",
    "    })",
    "  );",
    "}",
    "",
    "function highlightInputForEvidence(rootElement) {",
    "  const previousOutline = rootElement.style.getPropertyValue('outline');",
    "  const previousOutlinePriority = rootElement.style.getPropertyPriority('outline');",
    "  const previousOffset = rootElement.style.getPropertyValue('outline-offset');",
    "  const previousOffsetPriority = rootElement.style.getPropertyPriority('outline-offset');",
    "  rootElement.style.setProperty('outline', '3px solid #7ab800', 'important');",
    "  rootElement.style.setProperty('outline-offset', '4px', 'important');",
    "  return () => {",
    "    if (previousOutline) rootElement.style.setProperty('outline', previousOutline, previousOutlinePriority);",
    "    else rootElement.style.removeProperty('outline');",
    "    if (previousOffset) rootElement.style.setProperty('outline-offset', previousOffset, previousOffsetPriority);",
    "    else rootElement.style.removeProperty('outline-offset');",
    "  };",
    "}",
    "",
    "function setDocumentedInput(evidenceKey, inputSelector, value, screenshotBaseName) {",
    "  if (!evidenceKey || !inputSelector || !screenshotBaseName) {",
    "    throw new Error('setDocumentedInput requiere clave, selector y nombre de captura no vacíos.');",
    "  }",
    "  const valueAsText = String(value);",
    "  return scrollIntoViewForEvidence(inputSelector).then(($root) => {",
    "    const $native = resolveDocumentedNativeInput($root, inputSelector);",
    "    const nativeInput = $native[0];",
    "    setNativeInputValue(nativeInput, valueAsText);",
    "  })",
    "    // El blur puede provocar un re-render de Angular y cambiar el scroll. Esperamos",
    "    // al repintado y resolvemos el control DE NUEVO; no reutilizamos el nodo anterior.",
    "    .then(() => waitForApplicationPaint())",
    "    .then(() => dismissKnownOverlays())",
    "    .then(() => cy.get(inputSelector, { timeout: 10000 }).first())",
    "    .then(($freshRoot) => {",
    "      const $freshNative = resolveDocumentedNativeInput($freshRoot, inputSelector);",
    "      return centerElementForEvidence($freshNative, inputSelector)",
    "        .should('be.visible')",
    "        .and('have.value', valueAsText)",
    "        .then(($verifiedInput) => {",
    "          trackedInputValues[evidenceKey] = String($verifiedInput[0].value);",
    "          return waitForApplicationPaint()",
    "            .then(() => cy.get(inputSelector, { timeout: 10000 }).first())",
    "            .then(($evidenceRoot) => {",
    "              const $evidenceInput = resolveDocumentedNativeInput($evidenceRoot, inputSelector);",
    "              return centerElementForEvidence($evidenceInput, inputSelector)",
    "                .should('be.visible')",
    "                .and('have.value', valueAsText)",
    "                .then(($evidenceInput) => {",
    "                  const cleanupHighlight = highlightInputForEvidence($evidenceInput[0]);",
    "                  return waitForApplicationPaint()",
    "                    .then(() => cy.screenshot(screenshotBaseName, { capture: 'viewport', overwrite: true }))",
    "                    .then(() => cleanupHighlight());",
    "                });",
    "            });",
    "        });",
    "    });",
    "}",
    "",
    "function setDocumentedSelect(evidenceKey, rootSelector, expectedText, screenshotBaseName) {",
    "  const expected = String(expectedText).trim();",
    "  return scrollIntoViewForEvidence(rootSelector)",
    "    .then(() => resolveNativeSelect(rootSelector))",
    "    .then(($select) => {",
    "      return cy.wrap($select)",
    "        .find('option', { timeout: 10000 })",
    "        .should(($options) => {",
    "          expect(findMatchingOption($options, expected), `opción visible exacta \"${expected}\"`).to.exist;",
    "        })",
    "        .then(($options) => {",
    "          const match = findMatchingOption($options, expected);",
    "          return cy.wrap($select).select(match.value || (match.textContent || '').trim(), { force: true });",
    "        });",
    "    })",
    "    .then(() => waitForApplicationPaint())",
    "    .then(() => dismissKnownOverlays())",
    "    .then(() => scrollIntoViewForEvidence(rootSelector))",
    "    .then(($evidenceRoot) => {",
    "      return resolveNativeSelect(rootSelector).then(($select) => {",
    "        const selectedText = ($select.find('option:selected').text() || '').replace(/\\s+/g, ' ').trim();",
    "        expect(selectedText, `texto seleccionado visible en ${rootSelector}`).to.eq(expected);",
    "        trackedInputValues[evidenceKey] = selectedText;",
    "        const cleanupHighlight = highlightInputForEvidence($evidenceRoot[0]);",
    "        return waitForApplicationPaint()",
    "          .then(() => scrollIntoViewForEvidence(rootSelector))",
    "          .then(() => cy.screenshot(screenshotBaseName, { capture: 'viewport', overwrite: true }))",
    "          .then(() => cleanupHighlight());",
    "      });",
    "    });",
    "}",
    "",
    "function resolveDocumentedCheckbox($root, rootSelector) {",
    "  const $checkbox = $root.is('input[type=checkbox], input[type=radio]')",
    "    ? $root",
    "    : $root.find('input[type=checkbox], input[type=radio]').first();",
    "  if ($checkbox.length === 0) {",
    "    throw new Error(`El selector documentado \"${rootSelector}\" no contiene checkbox/radio nativo.`);",
    "  }",
    "  return $checkbox;",
    "}",
    "",
    "function setDocumentedCheckbox(evidenceKey, rootSelector, expectedValue, screenshotBaseName) {",
    "  const normalized = String(expectedValue).trim().toLowerCase();",
    "  if (normalized !== 'true' && normalized !== 'false') {",
    "    throw new Error('El valor documentado de checkbox debe ser true o false.');",
    "  }",
    "  const shouldBeChecked = normalized === 'true';",
    "  return scrollIntoViewForEvidence(rootSelector)",
    "    .then(($root) => {",
    "      const $checkbox = resolveDocumentedCheckbox($root, rootSelector);",
    "      return shouldBeChecked",
    "        ? cy.wrap($checkbox).check({ force: true })",
    "        : cy.wrap($checkbox).uncheck({ force: true });",
    "    })",
    "    .then(() => waitForApplicationPaint())",
    "    .then(() => dismissKnownOverlays())",
    "    .then(() => scrollIntoViewForEvidence(rootSelector))",
    "    .then(($evidenceRoot) => {",
    "      const $checkbox = resolveDocumentedCheckbox($evidenceRoot, rootSelector);",
    "      return cy.wrap($checkbox)",
    "        .should(shouldBeChecked ? 'be.checked' : 'not.be.checked')",
    "        .then(($verifiedCheckbox) => {",
    "          trackedInputValues[evidenceKey] = String(Boolean($verifiedCheckbox[0].checked));",
    "          const cleanupHighlight = highlightInputForEvidence($evidenceRoot[0]);",
    "          return waitForApplicationPaint()",
    "            .then(() => scrollIntoViewForEvidence(rootSelector))",
    "            .then(() => cy.screenshot(screenshotBaseName, { capture: 'viewport', overwrite: true }))",
    "            .then(() => cleanupHighlight());",
    "        });",
    "    });",
    "}",
    "",
    "function setDocumentedControl(evidenceKey, controlType, selector, value, screenshotBaseName) {",
    "  if (!evidenceKey || !controlType || !selector || !screenshotBaseName) {",
    "    throw new Error('setDocumentedControl requiere clave, tipo, selector y captura no vacíos.');",
    "  }",
    "  if (controlType === 'input') return setDocumentedInput(evidenceKey, selector, value, screenshotBaseName);",
    "  if (controlType === 'select') return setDocumentedSelect(evidenceKey, selector, value, screenshotBaseName);",
    "  if (controlType === 'checkbox') return setDocumentedCheckbox(evidenceKey, selector, value, screenshotBaseName);",
    "  throw new Error(`Tipo de control documentado no soportado: ${controlType}`);",
    "}",
    "",
    "function setNumericFieldValue(fieldSelector, value) {",
    "  const idMatch = /^#([A-Za-z_][\\w-]*)$/.exec(fieldSelector.trim());",
    "  return setInputValue(",
    "    `${fieldSelector} input:not([type='hidden'])`,",
    "    value,",
    "    idMatch ? idMatch[1] : fieldSelector",
    "  );",
    "}",
    "",
    "function setValueByFormControl(componentSelector, formControlName, value) {",
    "  return setInputValue(",
    "    `${componentSelector} [formcontrolname='${formControlName}'] input`,",
    "    value,",
    "    formControlName",
    "  );",
    "}",
    "",
    "function getNativeControl(rootSelector) {",
    "  return cy.get(rootSelector, { timeout: 10000 }).first().then(($root) => {",
    "    const native = $root.is('input, select, textarea, button')",
    "      ? $root",
    "      : $root.find('input, select, textarea, button').first();",
    "    return cy.wrap(native && native.length ? native : $root);",
    "  });",
    "}",
    "",
    "function isElementDisabled($el) {",
    "  const el = $el[0];",
        "  if (!el) return false;",
        "  // Si es un wrapper custom (p. ej. <empresas-ui-button>), el atributo `disabled`",
        "  // AUTORITATIVO vive en el <button>/<input> nativo interno, NO en el wrapper",
        "  // (que solo lleva `ng-reflect-disabled` en dev). Resolvemos el nativo interno.",
        "  const nativeEl = $el.is('input, select, textarea, button')",
        "    ? el",
        "    : ($el.find('input, select, textarea, button')[0] || el);",
        "  const $native = Cypress.$(nativeEl);",
        "  return (",
        "    nativeEl.hasAttribute('disabled') ||",
        "    nativeEl.disabled === true ||",
        "    $native.hasClass('disabled') ||",
        "    $el.hasClass('disabled') ||",
        "    String($native.attr('aria-disabled')).toLowerCase() === 'true' ||",
        "    String($el.attr('aria-disabled')).toLowerCase() === 'true' ||",
        "    String($el.attr('ng-reflect-disabled')).toLowerCase() === 'true'",
        "  );",
        "}",
    "",
    "function assertControlDisabled(rootSelector) {",
    "  cy.get(rootSelector, { timeout: 10000 }).first().then(($root) => {",
    "    const native = $root.is('input, select, textarea, button')",
    "      ? $root",
    "      : $root.find('input, select, textarea, button').first();",
    "    if (native && native.length && native.is('input, select, textarea, button')) {",
    "      cy.wrap(native).should('be.disabled');",
    "    } else {",
    "      cy.wrap($root).should(($el) => {",
    "        expect(isElementDisabled($el), 'el control debe estar deshabilitado').to.eq(true);",
    "      });",
    "    }",
    "  });",
    "}",
    "",
    "function assertControlEnabled(rootSelector) {",
    "  cy.get(rootSelector, { timeout: 10000 }).first().then(($root) => {",
    "    const native = $root.is('input, select, textarea, button')",
    "      ? $root",
    "      : $root.find('input, select, textarea, button').first();",
    "    if (native && native.length && native.is('input, select, textarea, button')) {",
    "      cy.wrap(native).should('be.enabled');",
    "    } else {",
    "      cy.wrap($root).should(($el) => {",
    "        expect(isElementDisabled($el), 'el control debe estar habilitado').to.eq(false);",
    "      });",
    "    }",
    "  });",
    "}",
    "",
    "function matchesButtonLabel(el, labelOrText) {",
    "  const attr = el.getAttribute ? el.getAttribute('label') : null;",
        "  const ngReflectLabel = el.getAttribute ? el.getAttribute('ng-reflect-label') : null;",
        "  const prop = el.label;",
        "  const aria = el.getAttribute ? el.getAttribute('aria-label') : null;",
        "  const text = (el.textContent || '').trim();",
        "  return (",
        "    attr === labelOrText ||",
        "    ngReflectLabel === labelOrText ||",
        "    prop === labelOrText ||",
        "    aria === labelOrText ||",
        "    text === labelOrText ||",
        "    (labelOrText && text.indexOf(labelOrText) >= 0)",
        "  );",
        "}",
    "",
    "// NOTA: la Cypress `.filter()` SOLO acepta un selector string (no un predicado",
    "// como la de jQuery). Por eso filtramos con jQuery dentro de `.then`/`.should`.",
    "function findUiButtonByLabel(labelOrText) {",
    "  return cy",
    "    .get('empresas-ui-button, button, [role=\"button\"]', { timeout: 10000 })",
    "    .then(($els) => $els.filter((i, el) => matchesButtonLabel(el, labelOrText)).first())",
    "    .then(($match) => centerElementForEvidence($match, `botón ${labelOrText}`));",
    "}",
    "",
    "function assertUiButtonDisabled(labelOrText) {",
    "  cy.get('empresas-ui-button, button, [role=\"button\"]', { timeout: 10000 }).should(($els) => {",
    "    const match = $els.toArray().find((el) => matchesButtonLabel(el, labelOrText));",
    "    expect(Boolean(match), `no se encontró botón con label/texto \"${labelOrText}\"`).to.eq(true);",
    "    expect(isElementDisabled(Cypress.$(match)), `el botón \"${labelOrText}\" debe estar deshabilitado`).to.eq(true);",
    "  });",
    "}",
    "",
    "function assertUiButtonEnabled(labelOrText) {",
    "  cy.get('empresas-ui-button, button, [role=\"button\"]', { timeout: 10000 }).should(($els) => {",
    "    const match = $els.toArray().find((el) => matchesButtonLabel(el, labelOrText));",
    "    expect(Boolean(match), `no se encontró botón con label/texto \"${labelOrText}\"`).to.eq(true);",
    "    expect(isElementDisabled(Cypress.$(match)), `el botón \"${labelOrText}\" debe estar habilitado`).to.eq(false);",
    "  });",
    "}",
    "",
    "function dismissKnownOverlays(extraSelectors = []) {",
    "  registerOverlayDismissSelectors(extraSelectors);",
    "  return cy.get('body', { log: false }).then(($body) => {",
    "    const body = $body[0];",
    "    const appWindow = body && body.ownerDocument && body.ownerDocument.defaultView;",
    "    if (!body || !appWindow) return false;",
    "    const control = findConsentDismissControl(body, appWindow);",
    "    if (!control) return false;",
    "    const container = findRecognizedConsentContainer(control, appWindow);",
    "    attemptedOverlayControls.add(control);",
    "    if (container) attemptedOverlayContainers.add(container);",
    "    // El control se ha identificado como cierre de consentimiento. No exigimos",
    "    // que él mismo esté expuesto: un backdrop puede taparlo parcialmente y la",
    "    // finalidad de esta interacción es precisamente retirar esa capa.",
    "    return cy.wrap(control, { log: false })",
    "      .click({ force: true, log: false })",
    "      .then(() => waitForApplicationPaint())",
    "      .then(() => waitForDismissedOverlay(container, appWindow))",
    "      .then(() => true);",
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
    "        centerElementForEvidence(header, `acordeón ${componentSelector}`)",
    "          .click({ force: true });",
    "      }",
    "    });",
    "}",
    "",
    "function findSerializedEventPaths(value, currentPath = '$', seen = new WeakSet()) {",
    "  if (typeof value === 'string') {",
    "    return /^\\[object [^\\]]*Event\\]$/i.test(value.trim()) ? [currentPath] : [];",
    "  }",
    "  if (!value || typeof value !== 'object') return [];",
    "  const tag = Object.prototype.toString.call(value);",
    "  if (/^\\[object [^\\]]*Event\\]$/i.test(tag)) return [currentPath];",
    "  if (seen.has(value)) return [];",
    "  seen.add(value);",
    "  const paths = [];",
    "  Object.entries(value).forEach(([key, child]) => {",
    "    paths.push(...findSerializedEventPaths(child, `${currentPath}.${key}`, seen));",
    "  });",
    "  return paths;",
    "}",
    "",
    "function snapshotWithTrackedInputs(currentSnapshot) {",
    "  const snapshot = currentSnapshot && typeof currentSnapshot === 'object' && !Array.isArray(currentSnapshot)",
    "    ? { ...currentSnapshot }",
    "    : { value: currentSnapshot };",
    "  if (Object.keys(trackedInputValues).length === 0) return snapshot;",
    "  const declaredInputs = snapshot.inputs && typeof snapshot.inputs === 'object' && !Array.isArray(snapshot.inputs)",
    "    ? snapshot.inputs",
    "    : {};",
    "  return {",
    "    ...snapshot,",
    "    inputs: { ...declaredInputs, ...trackedInputValues }",
    "  };",
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
    "  return cy.then(() => {",
    "    const completeSnapshot = snapshotWithTrackedInputs(currentSnapshot);",
    "    const eventPaths = findSerializedEventPaths(completeSnapshot);",
    "    if (eventPaths.length > 0) {",
    "      throw new Error(",
    "        `Snapshot inválido para \"${key}\": contiene objetos Event en ${eventPaths.join(', ')}. ` +",
    "        'Corrige la interacción del input; nunca persistas [object Event] como valor.'",
    "      );",
    "    }",
    "    return cy.task('readBaseline', { filePath: baselineFixturePath }).then((baseline) => {",
    "      const nextBaseline = baseline || {};",
    "      const expectedSnapshot = nextBaseline[key];",
    "      const baselineEventPaths = findSerializedEventPaths(expectedSnapshot);",
    "      if (baselineEventPaths.length > 0) {",
    "        throw new Error(",
    "          `Baseline inválido para \"${key}\": contiene objetos Event en ${baselineEventPaths.join(', ')}. ` +",
    "          'Elimina esa entrada y vuelve a ejecutar para autocapturarla.'",
    "        );",
    "      }",
    "      if (!expectedSnapshot && autoCapture) {",
    "        nextBaseline[key] = completeSnapshot;",
    "        cy.task('writeBaseline', { filePath: baselineFixturePath, data: nextBaseline }).then(() => {",
    "          cy.log(`Baseline autocapturado para \"${key}\". En la siguiente ejecución se validará.`);",
    "        });",
    "        return;",
    "      }",
    "      expect(expectedSnapshot, `No existe baseline para \"${key}\".`).to.exist;",
    "      const comparison = compareBaselineRecord(completeSnapshot, expectedSnapshot, {",
    "        numericTolerance: DEFAULT_NUMERIC_TOLERANCE,",
    "        ...(options.compareOptions || {})",
    "      });",
    "      expect(",
    "        comparison.isMatch,",
    "        `Diferencias baseline en \"${key}\": ${JSON.stringify(comparison.mismatches, null, 2)}`",
    "      ).to.eq(true);",
    "    });",
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
    "  setDocumentedInput,",
    "  setDocumentedControl,",
    "  scrollIntoViewForEvidence,",
    "  getNativeControl,",
    "  assertControlEnabled,",
    "  assertControlDisabled,",
    "  findUiButtonByLabel,",
    "  assertUiButtonDisabled,",
    "  assertUiButtonEnabled,",
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
    "    viewportWidth: 1920,",
    "    viewportHeight: 1080,",
    ...(baseUrl ? [`    baseUrl: \"${baseUrl.replace(/"/g, '\\"')}\",`] : []),
    "    setupNodeEvents(on) {",
    "      registerBaselineTasks(on);",
    "      on(\"before:browser:launch\", (browser, launchOptions) => {",
    "        if (browser.family === \"chromium\" && browser.name !== \"electron\") {",
    "          launchOptions.args = launchOptions.args || [];",
    "          if (!launchOptions.args.includes(\"--force-device-scale-factor=1\")) {",
    "            launchOptions.args.push(\"--force-device-scale-factor=1\");",
    "          }",
    "        }",
    "        if (browser.family === \"firefox\") {",
    "          launchOptions.preferences = launchOptions.preferences || {};",
    "          launchOptions.preferences[\"layout.css.devPixelsPerPx\"] = \"1.0\";",
    "        }",
    "        return launchOptions;",
    "      });",
    "    }",
    "  },",
    "  screenshotsFolder: \"cypress/screenshots\",",
    "  screenshotOnRunFailure: true,",
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

/**
 * Fija el formato documental de las evidencias: viewport Full HD y DPR 1.
 * Se aplica también a configuraciones existentes para que el escalado DPI del
 * sistema operativo no produzca PNG con dimensiones distintas de 1920x1080.
 */
function injectEvidenceDisplayIntoConfig(configContent: string): string {
  let updated = configContent;
  const e2eStart = /\be2e\s*:\s*\{/;

  // Cypress ignora launchOptions.args para su Electron empaquetado. Migra el
  // hook que generaban versiones anteriores para reservarlo a Chrome/Edge;
  // Electron recibe el mismo switch mediante ELECTRON_EXTRA_LAUNCH_ARGS.
  updated = updated.replace(
    /browser\.family\s*===\s*(["'])chromium\1\s*\)/g,
    (_match, quote: string) =>
      `browser.family === ${quote}chromium${quote} && browser.name !== ${quote}electron${quote})`
  );

  if (/\bviewportWidth\s*:\s*\d+/.test(updated)) {
    updated = updated.replace(/\bviewportWidth\s*:\s*\d+/, "viewportWidth: 1920");
  } else {
    updated = updated.replace(e2eStart, (match) => `${match}\n    viewportWidth: 1920,`);
  }
  if (/\bviewportHeight\s*:\s*\d+/.test(updated)) {
    updated = updated.replace(/\bviewportHeight\s*:\s*\d+/, "viewportHeight: 1080");
  } else {
    updated = updated.replace(e2eStart, (match) => `${match}\n    viewportHeight: 1080,`);
  }

  if (updated.includes("--force-device-scale-factor=1")) return updated;
  const setupNodeEventsRegex = /setupNodeEvents\s*\(\s*on(?:\s*,[^)]*)?\s*\)\s*\{/;
  const launchHook = [
    '      on("before:browser:launch", (browser, launchOptions) => {',
    '        if (browser.family === "chromium" && browser.name !== "electron") {',
    "          launchOptions.args = launchOptions.args || [];",
    '          if (!launchOptions.args.includes("--force-device-scale-factor=1")) {',
    '            launchOptions.args.push("--force-device-scale-factor=1");',
    "          }",
    "        }",
    '        if (browser.family === "firefox") {',
    "          launchOptions.preferences = launchOptions.preferences || {};",
    '          launchOptions.preferences["layout.css.devPixelsPerPx"] = "1.0";',
    "        }",
    "        return launchOptions;",
    "      });",
  ].join("\n");
  return updated.replace(setupNodeEventsRegex, (match) => `${match}\n${launchHook}`);
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

  const updatedConfig = injectEvidenceDisplayIntoConfig(
    injectBaselineTasksIntoConfig(existingConfig)
  );
  if (updatedConfig !== existingConfig) {
    await fs.writeFile(cypressConfigPath, updatedConfig, "utf8");
  }
}

/**
 * Elimina del fixture de baseline las claves pertenecientes a un RF concreto
 * (p. ej. `rf-01.cu-1`), para que cada re-ejecución dentro del bucle de
 * corrección vuelva a autocapturar y no falle por deriva del baseline previo.
 */
/**
 * Borra del baseline SOLO la clave exacta de un CU (`RF-1.CU-1`) y sus posibles
 * subclaves (`RF-1.CU-1.*`), sin tocar las de otros CU del mismo RF (p. ej. NO
 * borra `RF-1.CU-10`). Necesario ahora que cada CU vive en su propio spec.
 */
async function clearBaselineForCu(frontendRoot: string, unitId: string): Promise<void> {
  const key = unitId.toLowerCase();
  await clearBaselineMatching(frontendRoot, (k) => k === key || k.startsWith(`${key}.`));
}

async function clearBaselineMatching(
  frontendRoot: string,
  match: (lowerKey: string) => boolean
): Promise<void> {
  const fixturesPath = path.resolve(frontendRoot, baselineFixtureRelativePath);
  const raw = await readTextIfExists(fixturesPath);
  if (!raw) return;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  let changed = false;
  for (const key of Object.keys(data)) {
    if (match(key.toLowerCase())) {
      delete data[key];
      changed = true;
    }
  }
  if (changed) {
    await fs.writeFile(fixturesPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

function containsSerializedEvent(value: unknown): boolean {
  if (typeof value === "string") {
    return /^\[object [^\]]*Event\]$/i.test(value.trim());
  }
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSerializedEvent);
  return Object.values(value as Record<string, unknown>).some(containsSerializedEvent);
}

/**
 * Elimina snapshots contaminados por eventos DOM serializados y revoca el
 * estado verde de sus CU. La siguiente ejecución los autocapturará de nuevo
 * usando el helper de escritura nativa con eventos de la ventana AUT.
 */
async function purgeSerializedEventBaselines(
  context: LoadedContext,
  rfFilter?: string[]
): Promise<string[]> {
  const frontendRoot = requireFrontendRoot(context);
  const fixturePath = path.resolve(frontendRoot, baselineFixtureRelativePath);
  const raw = await readTextIfExists(fixturePath);
  if (!raw) return [];

  let baseline: Record<string, unknown>;
  try {
    baseline = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return [];
  }

  const allowedRfIds = rfFilter && rfFilter.length > 0
    ? new Set(rfFilter.map((id) => id.trim().toLowerCase()))
    : undefined;
  const invalidKeys = Object.entries(baseline)
    .filter(([key, snapshot]) => {
      const rfId = key.split(".")[0]?.toLowerCase();
      return (!allowedRfIds || allowedRfIds.has(rfId)) && containsSerializedEvent(snapshot);
    })
    .map(([key]) => key);
  if (invalidKeys.length === 0) return [];

  invalidKeys.forEach((key) => delete baseline[key]);
  await fs.writeFile(fixturePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

  const outputRoot = path.resolve(path.dirname(context.configPath), context.config.e2eTests);
  await fs.mkdir(outputRoot, { recursive: true });
  const status = await readE2EStatus(outputRoot);
  const knownUnitIds = new Map(
    expandToCuUnits(extractOrBuildRfEntries(context)).map((unit) => [
      unit.unitId.toLowerCase(),
      unit.unitId,
    ])
  );
  const unitIds = [
    ...new Set(
      invalidKeys
        .map((key) => knownUnitIds.get(key.split(".").slice(0, 2).join(".").toLowerCase()))
        .filter((unitId): unitId is string => Boolean(unitId))
    ),
  ];
  const at = new Date().toISOString();
  unitIds.forEach((unitId) => {
    status[unitId.toLowerCase()] = { green: false, at, contractVersion: E2E_CONTRACT_VERSION };
  });
  await fs.writeFile(e2eStatusPath(outputRoot), `${JSON.stringify(status, null, 2)}\n`, "utf8");
  return unitIds;
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

interface CuArtifactState {
  spec?: string;
  missingCalls: ReturnType<typeof missingScreenshotCalls>;
  contractError?: string;
  evidenceReady: boolean;
  complete: boolean;
}

async function inspectCuArtifacts(
  context: LoadedContext,
  unit: CuUnit,
  status: Record<string, E2EStatusEntry>,
  fullPath: string
): Promise<CuArtifactState> {
  const spec = await readTextIfExists(fullPath);
  const missingCalls = spec ? missingScreenshotCalls(spec, unit.rf, unit.cu) : actionScreenshots(unit.rf, unit.cu);
  const specError = spec ? specContractError(unit, spec) : undefined;
  const baselineError = spec && isRfGreen(status, unit.unitId)
    ? await documentedInputBaselineError(context, unit)
    : undefined;
  const contractError = [specError, baselineError]
    .filter((error): error is string => Boolean(error))
    .join("\n") || undefined;
  const evidenceReady = spec
    ? await hasAllScreenshotEvidence(context, unit.rf, unit.cu)
    : false;
  return {
    spec,
    missingCalls,
    contractError,
    evidenceReady,
    complete:
      Boolean(spec) &&
      isRfGreen(status, unit.unitId) &&
      !contractError &&
      evidenceReady,
  };
}

function screenshotContractError(unit: CuUnit, spec: string): string | undefined {
  const missing = missingScreenshotCalls(spec, unit.rf, unit.cu);
  if (missing.length === 0) return undefined;
  return (
    `CONTRATO DE EVIDENCIAS INCUMPLIDO para ${unit.unitId}: faltan las evidencias ` +
    missing.map((item) => item.baseName).join(", ") +
    ". Las acciones con datos de control las captura setDocumentedControl con su quinto argumento; " +
    "las demás usan cy.screenshot inmediatamente después de la acción."
  );
}

function executableSpecContent(spec: string): string {
  return spec
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function inputInteractionContractError(unit: CuUnit, spec: string): string | undefined {
  const executableSpec = executableSpecContent(spec);
  const violations: string[] = [];
  if (/\bfunction\s+(?:fillNumericInput|fillInput|setInputValue|setNumericFieldValue|setValueByFormControl|setDocumentedInput|setDocumentedControl)\s*\(/.test(executableSpec)) {
    violations.push("define un helper local de escritura");
  }
  if (/\.clear\s*\(/.test(executableSpec) || /\.type\s*\(/.test(executableSpec)) {
    violations.push("usa `clear()`/`type()` directamente");
  }
  if (/\.invoke\s*\(\s*["']val["']/.test(executableSpec)) {
    violations.push("usa `invoke('val', ...)`");
  }
  if (/\.trigger\s*\(\s*["'](?:input|change)["']/.test(executableSpec)) {
    violations.push("emite `input`/`change` mediante `trigger()`");
  }
  if (violations.length === 0) return undefined;
  return (
    `CONTRATO DE INPUTS INCUMPLIDO para ${unit.unitId}: ${violations.join(", ")}. ` +
    "El spec debe importar y usar exclusivamente setDocumentedControl o, para documentos legacy, " +
    "setInputValue/setNumericFieldValue/setValueByFormControl; esos helpers emiten eventos desde la ventana AUT " +
    "y registran los inputs del baseline."
  );
}

function viewportInteractionContractError(unit: CuUnit, spec: string): string | undefined {
  const statements = executableSpecContent(spec)
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  const interaction = /\.(?:click|dblclick|rightclick|select|check|uncheck|focus|blur|trigger|submit)\s*\(/;
  const violations: string[] = [];

  statements.forEach((statement, index) => {
    if (!interaction.test(statement)) return;
    const previous = statements[index - 1] ?? "";
    const scrollsCurrentTarget =
      /\bscrollIntoViewForEvidence\s*\(/.test(statement) ||
      /\bfindUiButtonByLabel\s*\(/.test(statement);
    const explicitPreviousScroll = /\bscrollIntoViewForEvidence\s*\(/.test(previous);
    const nonElementInteraction = /\bcy\.(?:window|document)\s*\(/.test(statement);
    if (!scrollsCurrentTarget && !explicitPreviousScroll && !nonElementInteraction) {
      violations.push(statement.replace(/\s+/g, " ").slice(0, 180));
    }
  });

  if (violations.length === 0) return undefined;
  return (
    `CONTRATO DE VIEWPORT INCUMPLIDO para ${unit.unitId}: hay interacciones sin scroll previo: ` +
    violations.map((statement) => `\`${statement}\``).join(", ") +
    ". Usa un helper compartido o scrollIntoViewForEvidence(selector) inmediatamente antes. " +
    "No uses .scrollIntoView() directamente: Cypress puede considerar visible un elemento ocluido por otra capa."
  );
}

function evidenceDisplayContractError(unit: CuUnit, spec: string): string | undefined {
  if (!/\bcy\s*\.\s*viewport\s*\(/.test(executableSpecContent(spec))) return undefined;
  return (
    `CONTRATO DE RESOLUCIÓN INCUMPLIDO para ${unit.unitId}: el spec usa cy.viewport(). ` +
    "El viewport 1920x1080 se fija en cypress.config.js y cy.viewport no corrige el DPR físico. " +
    "Elimina la llamada; Electron recibe --force-device-scale-factor=1 mediante ELECTRON_EXTRA_LAUNCH_ARGS."
  );
}

function evidenceSequenceContractError(unit: CuUnit, spec: string): string | undefined {
  if (unit.cu.inputValues === undefined) return undefined;
  const statements = executableSpecContent(spec).split(";");
  const actual: string[] = [];
  const screenshotPattern = /\bcy\s*\.\s*screenshot\s*\(\s*(["'`])([^"'`]+)\1/g;

  for (const statement of statements) {
    const documentedCalls = extractDocumentedControlCalls(statement);
    documentedCalls.forEach((args) => {
      const screenshotName = args?.[4];
      if (screenshotName) actual.push(screenshotName);
    });
    let match: RegExpExecArray | null;
    while ((match = screenshotPattern.exec(statement)) !== null) actual.push(match[2]);
  }

  const expected = actionScreenshots(unit.rf, unit.cu).map((item) => item.baseName);
  if (JSON.stringify(actual) === JSON.stringify(expected)) return undefined;
  return (
    `CONTRATO DE SECUENCIA DE EVIDENCIAS INCUMPLIDO para ${unit.unitId}: ` +
    `se esperaba exactamente ${JSON.stringify(expected)}, pero el spec genera ${JSON.stringify(actual)}. ` +
    "Debe existir una sola evidencia por acción y en el mismo orden; la evidencia de un control es el quinto argumento de setDocumentedControl."
  );
}

function interactionEvidenceContractError(unit: CuUnit, spec: string): string | undefined {
  if (unit.cu.inputValues === undefined) return undefined;
  const statements = executableSpecContent(spec)
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  const helperInteraction = /\b(?:setInputValue|setNumericFieldValue|setValueByFormControl|selectRequiredOptionByTextOrValue|selectOptionByTextOrValueIfPresent|selectFirstSelectableOption|openAccordionByComponent)\s*\(/;
  const directInteraction = /\.(?:click|dblclick|rightclick|select|check|uncheck|focus|blur|trigger|submit)\s*\(/;
  const screenshot = /\bcy\s*\.\s*screenshot\s*\(/;
  let pendingInteraction: string | undefined;
  const violations: string[] = [];

  for (const statement of statements) {
    // setDocumentedControl genera su captura dentro del propio helper.
    if (/\bsetDocumentedControl\s*\(/.test(statement)) continue;
    const isFindButtonClick = /\bfindUiButtonByLabel\s*\([^;]*\)\s*\.\s*click\s*\(/.test(statement);
    const isDirect = directInteraction.test(statement) && !/\bcy\.(?:window|document)\s*\(/.test(statement);
    const isInteraction = helperInteraction.test(statement) || isFindButtonClick || isDirect;
    if (isInteraction) {
      if (pendingInteraction) {
        violations.push(`${pendingInteraction} → ${statement.replace(/\s+/g, " ").slice(0, 120)}`);
      }
      pendingInteraction = statement.replace(/\s+/g, " ").slice(0, 120);
    }
    if (screenshot.test(statement)) pendingInteraction = undefined;
  }
  if (pendingInteraction) violations.push(`${pendingInteraction} → sin screenshot posterior`);
  if (violations.length === 0) return undefined;
  return (
    `CONTRATO UNA INTERACCIÓN/UNA EVIDENCIA INCUMPLIDO para ${unit.unitId}: ` +
    violations.join(" | ") +
    ". Captura cada interacción antes de iniciar la siguiente."
  );
}

function splitCallArguments(argumentText: string): string[] | undefined {
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;
  let escaped = false;
  let nested = 0;

  for (const char of argumentText) {
    if (quote) {
      current += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") nested += 1;
    if (char === ")" || char === "]" || char === "}") nested -= 1;
    if (char === "," && nested === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (quote || nested !== 0) return undefined;
  args.push(current.trim());
  return args;
}

function decodeDirectJsString(token: string): string | undefined {
  const trimmed = token.trim();
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed.at(-1) !== quote) return undefined;
  const body = trimmed.slice(1, -1);
  let decoded = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      decoded += char;
      continue;
    }
    index += 1;
    if (index >= body.length) return undefined;
    const escaped = body[index];
    const known: Record<string, string> = {
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      v: "\v",
      "0": "\0",
      "\\": "\\",
      '"': '"',
      "'": "'",
    };
    decoded += known[escaped] ?? escaped;
  }
  return decoded;
}

function extractDocumentedControlCalls(spec: string): Array<Array<string | undefined> | undefined> {
  const calls: Array<Array<string | undefined> | undefined> = [];
  const callStart = /\bsetDocumentedControl\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callStart.exec(spec)) !== null) {
    const openParen = callStart.lastIndex - 1;
    let quote: string | undefined;
    let escaped = false;
    let depth = 0;
    let closeParen = -1;
    for (let index = openParen; index < spec.length; index += 1) {
      const char = spec[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = undefined;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          closeParen = index;
          break;
        }
      }
    }
    if (closeParen < 0) {
      calls.push(undefined);
      break;
    }
    const args = splitCallArguments(spec.slice(openParen + 1, closeParen));
    calls.push(args?.map(decodeDirectJsString));
    callStart.lastIndex = closeParen + 1;
  }
  return calls;
}

function documentedInputContractError(unit: CuUnit, spec: string): string | undefined {
  const expected = unit.cu.inputValues;
  if (expected === undefined) return undefined;

  const actionErrors = inputActionContractErrors(unit.rf.id, unit.cu);
  if (actionErrors.length > 0) {
    return (
      `CONTRATO RFCU CONTROL/ACCIÓN INCUMPLIDO para ${unit.unitId}:\n- ` +
      actionErrors.join("\n- ") +
      "\nRegenera/completa rf-cu.md: cada input/select/checkbox debe declarar tipo, valor y una acción independiente."
    );
  }

  const executableSpec = executableSpecContent(spec);
  const calls = extractDocumentedControlCalls(executableSpec);
  const malformed = calls.some(
    (args) => !args || args.length !== 5 || args.some((arg) => arg === undefined)
  );
  if (malformed) {
    return (
      `CONTRATO DE VALORES DE CONTROL INCUMPLIDO para ${unit.unitId}: ` +
      "cada setDocumentedControl debe tener exactamente cinco literales string: clave, tipo, selector, valor y captura."
    );
  }

  const actual = calls as string[][];
  const screenshots = actionScreenshots(unit.rf, unit.cu);
  const expectedCalls = expected.map((input) => [
    input.key,
    input.kind as string,
    input.selector,
    input.value,
    screenshots[(input.actionNumber as number) - 1].baseName,
  ]);
  const same =
    actual.length === expectedCalls.length &&
    actual.every((args, index) =>
      args.every((arg, argIndex) => arg === expectedCalls[index][argIndex])
    );
  const usesLegacyInputHelper = /\b(?:setDocumentedInput|setInputValue|setNumericFieldValue|setValueByFormControl|selectRequiredOptionByTextOrValue|selectOptionByTextOrValueIfPresent|selectFirstSelectableOption)\s*\(/.test(executableSpec);
  const duplicateKeys = new Set(expected.map((input) => input.key)).size !== expected.length;

  if (same && !usesLegacyInputHelper && !duplicateKeys) return undefined;
  return [
    `CONTRATO DE VALORES DE CONTROL INCUMPLIDO para ${unit.unitId}.`,
    `Esperado desde rf-cu.md: ${JSON.stringify(expectedCalls)}.`,
    `Encontrado en setDocumentedControl: ${JSON.stringify(actual)}.`,
    usesLegacyInputHelper
      ? "No uses helpers legacy de input/select cuando el CU tiene valores de controles documentados."
      : "",
    duplicateKeys ? "Las claves de control de rf-cu.md deben ser únicas dentro del CU." : "",
  ].filter(Boolean).join(" ");
}

async function documentedInputBaselineError(
  context: LoadedContext,
  unit: CuUnit
): Promise<string | undefined> {
  const expectedInputs = unit.cu.inputValues;
  if (expectedInputs === undefined) return undefined;

  const frontendRoot = requireFrontendRoot(context);
  const fixturePath = path.resolve(frontendRoot, baselineFixtureRelativePath);
  const raw = await readTextIfExists(fixturePath);
  if (!raw) {
    return `No existe ${baselineFixtureRelativePath} para validar los inputs de ${unit.unitId}.`;
  }

  let baseline: Record<string, unknown>;
  try {
    baseline = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return `${baselineFixtureRelativePath} no contiene JSON válido.`;
  }
  const snapshotKey = Object.keys(baseline).find(
    (key) => key.toLowerCase() === unit.unitId.toLowerCase()
  );
  const snapshot = snapshotKey ? baseline[snapshotKey] : undefined;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return `No existe el snapshot ${unit.unitId} en ${baselineFixtureRelativePath}.`;
  }
  const candidateInputs = (snapshot as Record<string, unknown>).inputs;
  const actualInputs = candidateInputs && typeof candidateInputs === "object" && !Array.isArray(candidateInputs)
    ? candidateInputs as Record<string, unknown>
    : {};
  const expectedRecord = Object.fromEntries(
    expectedInputs.map((input) => [input.key, input.value])
  );
  const expectedKeys = Object.keys(expectedRecord).sort();
  const actualKeys = Object.keys(actualInputs).sort();
  const sameKeys = JSON.stringify(actualKeys) === JSON.stringify(expectedKeys);
  const differing = expectedKeys.filter(
    (key) => String(actualInputs[key]) !== expectedRecord[key]
  );
  if (sameKeys && differing.length === 0) return undefined;
  return (
    `BASELINE DE DATOS DE PRUEBA INCORRECTO para ${unit.unitId}: ` +
    `rf-cu.md exige ${JSON.stringify(expectedRecord)}, pero e2e-baseline.json contiene ` +
    `${JSON.stringify(actualInputs)}. El spec debe usar setDocumentedControl con todos los valores documentados.`
  );
}

function specContractError(unit: CuUnit, spec: string): string | undefined {
  const errors = [
    screenshotContractError(unit, spec),
    inputInteractionContractError(unit, spec),
    evidenceDisplayContractError(unit, spec),
    viewportInteractionContractError(unit, spec),
    documentedInputContractError(unit, spec),
    evidenceSequenceContractError(unit, spec),
    interactionEvidenceContractError(unit, spec),
  ]
    .filter((error): error is string => Boolean(error));
  return errors.length > 0 ? errors.join("\n") : undefined;
}

function requireSpecContract(unit: CuUnit, spec: string): void {
  const error = specContractError(unit, spec);
  if (error) throw new Error(error);
}

export async function generateE2ETests(
  context: LoadedContext,
  sample: E2ESampleFn,
  options: GenerateE2EOptions = {}
): Promise<{
  files: string[];
  rfCount: number;
  iterations: E2EIterationResult[];
  greenCount: number;
  skippedGreenCount: number;
}> {
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
  await purgeSerializedEventBaselines(context, rfFilter);

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
  requireRfCuInputActionContract(entries);

  const files: string[] = [];
  const iterations: E2EIterationResult[] = [];
  const visitUrl = context.config.e2eBaseUrl ?? "/";

  const frontendRoot = requireFrontendRoot(context);
  const openApiContext = openApiSnippet(context.openApiContent);

  const units = expandToCuUnits(entries);
  const initialStatus = await readE2EStatus(outputRoot);
  const targets = await Promise.all(
    units.map(async (unit) => {
      const fullPath = path.join(outputRoot, `${unit.fileBase}.cy.js`);
      const artifacts = await inspectCuArtifacts(context, unit, initialStatus, fullPath);
      return {
        unit,
        fullPath,
        exists: Boolean(artifacts.spec),
        ...artifacts,
      };
    })
  );
  const pendingTargets = targets.filter((target) => !target.complete);
  const skippedGreenCount = targets.length - pendingTargets.length;
  const sources = pendingTargets.length > 0 ? await readFrontendSources(frontendRoot) : [];

  for (const target of pendingTargets) {
    const { unit, fullPath } = target;
    const entry = unit.entry;
    const fileName = `${unit.fileBase}.cy.js`;
    const specRelPath = path.relative(frontendRoot, fullPath).split(path.sep).join("/");

    const promptData = await loadE2EPrompt(context, entry, undefined, promptOverride);
    const frontendContext = buildRfFocusedBundle(sources, entry);

    // Un verde sin spec, sin llamadas o sin PNG persistidos es inconsistente.
    if (initialStatus[unit.unitId.toLowerCase()]?.green === true) {
      await setRfGreen(outputRoot, unit.unitId, false);
    }

    if (!target.exists || target.contractError) {
      const generationPrompt = buildE2EGenerationPrompt({
        entry,
        rules: promptData.text,
        frontendContext,
        visitUrl,
        openApiContext,
        promptOverride,
        fix: target.spec
          ? {
              currentSpec: target.spec,
              cypressOutput:
                target.contractError ?? "El spec debe cumplir los contratos de inputs y evidencias.",
              attempt: 0,
            }
          : undefined,
      });

      const generated = await sample(generationPrompt, 16000);
      if (!generated || generated.trim().length === 0) {
        throw new Error(
          `El modelo no devolvió contenido para el spec E2E de ${unit.unitId}. ` +
            "Verifica que el cliente MCP soporte sampling (createMessage)."
        );
      }

      const sanitized = sanitizeGeneratedSpec(generated);
      requireSpecContract(unit, sanitized);
      await fs.writeFile(fullPath, sanitized, "utf8");
      files.push(fullPath);
    }

    if (!runTests) {
      iterations.push({
        rf: unit.unitId,
        file: fullPath,
        passed: false,
        attempts: target.exists ? 0 : 1,
      });
      continue;
    }

    let passed = false;
    let attempts = 0;
    let lastOutput = "";

    for (let attempt = 1; attempt <= maxIterations; attempt++) {
      attempts = attempt;
      await clearBaselineForCu(frontendRoot, unit.unitId);
      await clearScreenshotEvidence(context, unit.rf, unit.cu);

      const runStartedAt = Date.now();
      const run = await runCypressSpecWithRepair({
        frontendRoot,
        specRelPath,
        runCommand,
        timeoutMs: runTimeoutMs,
        ...resolveE2ERuntime(context),
      });
      lastOutput = run.output;

      if (run.passed) {
        try {
          const baselineError = await documentedInputBaselineError(context, unit);
          if (baselineError) throw new Error(baselineError);
          await persistScreenshotEvidence(context, frontendRoot, unit.rf, unit.cu, runStartedAt);
          passed = true;
          await setRfGreen(outputRoot, unit.unitId, true);
          await writeRfFeedbackLog({
            outputRoot,
            entry,
            cu: unit.cu,
            specFileName: fileName,
            specPath: fullPath,
            runCommand,
            passed: true,
            rawOutput: run.output,
          });
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lastOutput = `${run.output}\n\n[qa-mcp] ${message}`;
          await setRfGreen(outputRoot, unit.unitId, false);
          if (attempt >= maxIterations) {
            await writeRfFeedbackLog({
              outputRoot,
              entry,
              cu: unit.cu,
              specFileName: fileName,
              specPath: fullPath,
              runCommand,
              passed: false,
              rawOutput: lastOutput,
              injectedOutput: message,
            });
          } else {
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
                cypressOutput: message,
                attempt,
              },
            });
            await writeRfFeedbackLog({
              outputRoot,
              entry,
              cu: unit.cu,
              specFileName: fileName,
              specPath: fullPath,
              runCommand,
              passed: false,
              rawOutput: lastOutput,
              injectedOutput: message,
              fixPrompt,
            });
            const fixed = await sample(fixPrompt, 16000);
            if (fixed && fixed.trim().length > 0) {
              const sanitized = sanitizeGeneratedSpec(fixed);
              requireSpecContract(unit, sanitized);
              await fs.writeFile(fullPath, sanitized, "utf8");
              if (!files.includes(fullPath)) files.push(fullPath);
            }
          }
          continue;
        }
      }

      await setRfGreen(outputRoot, unit.unitId, false);

      if (run.cacheError) {
        lastOutput = `${cypressCacheErrorNotice(resolveE2ERuntime(context).nodePath)}\n\n${run.output}`;
        await writeRfFeedbackLog({
          outputRoot,
          entry,
          cu: unit.cu,
          specFileName: fileName,
          specPath: fullPath,
          runCommand,
          passed: false,
          rawOutput: run.output,
          injectedOutput: lastOutput,
        });
        break;
      }

      if (attempt >= maxIterations) {
        await writeRfFeedbackLog({
          outputRoot,
          entry,
          cu: unit.cu,
          specFileName: fileName,
          specPath: fullPath,
          runCommand,
          passed: false,
          rawOutput: run.output,
          injectedOutput: extractCypressFailureSummary(run.output, 2000),
        });
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

      await writeRfFeedbackLog({
        outputRoot,
        entry,
        cu: unit.cu,
        specFileName: fileName,
        specPath: fullPath,
        runCommand,
        passed: false,
        rawOutput: run.output,
        injectedOutput: extractCypressFailureSummary(run.output, 2000),
        fixPrompt,
      });

      const fixed = await sample(fixPrompt, 16000);
      if (fixed && fixed.trim().length > 0) {
        const sanitized = sanitizeGeneratedSpec(fixed);
        requireSpecContract(unit, sanitized);
        await fs.writeFile(fullPath, sanitized, "utf8");
        if (!files.includes(fullPath)) {
          files.push(fullPath);
        }
      }
    }

    iterations.push({
      rf: unit.unitId,
      file: fullPath,
      passed,
      attempts,
      lastOutput: passed ? undefined : extractCypressFailureSummary(lastOutput, 2000),
    });
  }

  const finalStatus = await readE2EStatus(outputRoot);
  const finalArtifacts = await Promise.all(
    units.map(async (unit) => {
      const fullPath = path.join(outputRoot, `${unit.fileBase}.cy.js`);
      return inspectCuArtifacts(context, unit, finalStatus, fullPath);
    })
  );
  const greenCount = finalArtifacts.filter((artifacts) => artifacts.complete).length;
  return {
    files,
    rfCount: units.length,
    iterations,
    greenCount,
    skippedGreenCount,
  };
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

/** Ruta del fichero de estado (qué RF están en verde) dentro del dir de specs. */
function e2eStatusPath(outputRoot: string): string {
  return path.join(outputRoot, ".qa-mcp-e2e-status.json");
}

interface E2EStatusEntry {
  green: boolean;
  at: string;
  contractVersion?: number;
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
  const entry = status[rfId.toLowerCase()];
  return entry?.green === true && entry.contractVersion === E2E_CONTRACT_VERSION;
}

async function setRfGreen(outputRoot: string, rfId: string, green: boolean): Promise<void> {
  const status = await readE2EStatus(outputRoot);
  status[rfId.toLowerCase()] = {
    green,
    at: new Date().toISOString(),
    contractVersion: E2E_CONTRACT_VERSION,
  };
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
  await purgeSerializedEventBaselines(context, rfFilter);

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
  requireRfCuInputActionContract(entries);

  const visitUrl = context.config.e2eBaseUrl ?? "/";
  const frontendRoot = requireFrontendRoot(context);
  const openApiContext = openApiSnippet(context.openApiContent);
  const units = expandToCuUnits(entries);
  const totalCount = units.length;
  const status = await readE2EStatus(outputRoot);

  const targets = await Promise.all(
    units.map(async (unit) => {
      const entry = unit.entry;
      const fileName = `${unit.fileBase}.cy.js`;
      const fullPath = path.join(outputRoot, fileName);
      const specRelPath = path.relative(frontendRoot, fullPath).split(path.sep).join("/");
      const artifacts = await inspectCuArtifacts(context, unit, status, fullPath);
      return {
        unit,
        entry,
        fullPath,
        specRelPath,
        exists: Boolean(artifacts.spec),
        ...artifacts,
        green: artifacts.complete,
      };
    })
  );

  for (const target of targets) {
    if (status[target.unit.unitId.toLowerCase()]?.green === true && !target.complete) {
      await setRfGreen(outputRoot, target.unit.unitId, false);
    }
  }

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
      rf: current.unit.rf.id,
      name: `${current.unit.cu.id} — ${current.unit.cu.name}`,
      filePath: current.fullPath,
      specRelPath: current.specRelPath,
    };

    if (current.exists && !current.contractError) {
      // Spec completo pero no verde/sin PNG persistidos: el siguiente paso es ejecutarlo.
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
      fix: current.spec
        ? {
            currentSpec: current.spec,
            cypressOutput:
              current.contractError ?? "El spec debe cumplir los contratos de inputs y evidencias.",
            attempt: 0,
          }
        : undefined,
    });

    return {
      specs: [
        {
          rf: current.unit.rf.id,
          name: `${current.unit.cu.id} — ${current.unit.cu.name}`,
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

  const pending = targets.filter((t) => !t.exists || Boolean(t.contractError));
  const pendingCount = pending.length;
  const allGenerated = pendingCount === 0;

  const toEmit = oneAtATime ? pending.slice(0, 1) : pending;
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
      fix: target.spec
        ? {
            currentSpec: target.spec,
            cypressOutput:
              target.contractError ?? "El spec debe cumplir los contratos de inputs y evidencias.",
            attempt: 0,
          }
        : undefined,
    });

    specs.push({
      rf: target.unit.rf.id,
      name: `${target.unit.cu.id} — ${target.unit.cu.name}`,
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
  /** Ruta del fichero .log con el feedback completo persistido (raw + prompt). */
  logPath?: string;
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
 * Persiste en disco el feedback COMPLETO que se inyecta al LLM para un RF, en un
 * fichero `.log` por RF (mismo basename que el spec) que se SOBRESCRIBE en cada
 * iteración de `runE2ETests`. Permite inspeccionar si el problema está en la
 * salida de Cypress o en el prompt de corrección que recibe el modelo. Los fallos
 * de escritura no interrumpen el bucle.
 */
async function writeRfFeedbackLog(params: {
  outputRoot: string;
  entry: RfEntry;
  cu?: CuCase;
  specFileName: string;
  specPath: string;
  runCommand?: string;
  passed: boolean;
  rawOutput: string;
  injectedOutput?: string;
  fixPrompt?: string;
}): Promise<string | undefined> {
  const logName = params.specFileName.replace(/\.cy\.js$/i, "") + ".log";
  const logPath = path.join(params.outputRoot, logName);
  const sep = (title: string) => `\n===== ${title} =====\n`;
  const cuLabel = params.cu ? ` · ${params.cu.id} ${params.cu.name}` : "";
  const body = [
    `[qa-mcp] Feedback E2E — ${params.entry.id} — ${params.entry.name}${cuLabel}`,
    `Generado: ${new Date().toISOString()}`,
    `Spec: ${params.specPath}`,
    `Comando Cypress: ${params.runCommand ?? "npx cypress run"}`,
    `Resultado: ${params.passed ? "PASA (verde)" : "FALLA (rojo)"}`,
    sep("SALIDA COMPLETA DE CYPRESS (raw, sin truncar)"),
    params.rawOutput || "(sin salida)",
    sep("RESUMEN INYECTADO AL LLM (output truncado)"),
    params.injectedOutput ?? "(no aplica — el RF pasó o no se inyectó resumen)",
    sep("PROMPT DE CORRECCIÓN INYECTADO AL LLM (fixPrompt)"),
    params.fixPrompt ?? "(no aplica — el RF pasó o no se generó prompt de corrección)",
  ].join("\n");
  try {
    await fs.mkdir(params.outputRoot, { recursive: true });
    await fs.writeFile(logPath, body, "utf8");
    return logPath;
  } catch {
    return undefined;
  }
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

  await ensureFrontendCypressSetup(context);
  await writeBaselineAssets(context);
  await purgeSerializedEventBaselines(context, rfFilter);

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
  requireRfCuInputActionContract(entries);

  const visitUrl = context.config.e2eBaseUrl ?? "/";
  const frontendRoot = requireFrontendRoot(context);
  const openApiContext = openApiSnippet(context.openApiContent);

  const scopeCount = expandToCuUnits(entries).length;
  const status = await readE2EStatus(outputRoot);
  let units = expandToCuUnits(entries);
  const artifactStates = await Promise.all(
    units.map(async (unit) => {
      const fullPath = path.join(outputRoot, `${unit.fileBase}.cy.js`);
      return { unit, artifacts: await inspectCuArtifacts(context, unit, status, fullPath) };
    })
  );
  const priorGreen = artifactStates.filter((state) => state.artifacts.complete).length;
  const rt = resolveE2ERuntime(context);
  const diag = {
    configPath: context.configPath,
    headed: rt.headed,
    browser: rt.browser,
  };

  // Modo CU-a-CU-hasta-verde: ejecuta SOLO el CU en curso (el primero no verde,
  // o el indicado por rfFilter), para acotar la salida y el contexto del cliente.
  if (untilGreen) {
    const target = artifactStates.find((state) => !state.artifacts.complete)?.unit;
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
    units = [target];
  } else {
    units = artifactStates
      .filter((state) => !state.artifacts.complete)
      .map((state) => state.unit);
  }

  interface Failure {
    result: E2ERunFixResult;
    unit: CuUnit;
    entry: RfEntry;
    currentSpec: string;
    rawOutput: string;
    fileName: string;
    fullPath: string;
  }

  const results: E2ERunFixResult[] = [];
  const failures: Failure[] = [];

  for (const unit of units) {
    const entry = unit.entry;
    const cuRf = unit.rf.id;
    const cuName = `${unit.cu.id} — ${unit.cu.name}`;
    const fileName = `${unit.fileBase}.cy.js`;
    const fullPath = path.join(outputRoot, fileName);
    const specRelPath = path.relative(frontendRoot, fullPath).split(path.sep).join("/");

    let currentSpec: string;
    try {
      currentSpec = await fs.readFile(fullPath, "utf8");
    } catch {
      results.push({
        rf: cuRf,
        name: cuName,
        filePath: fullPath,
        specRelPath,
        passed: false,
        missing: true,
      });
      continue;
    }

    const contractError = specContractError(unit, currentSpec);
    if (contractError) {
      await setRfGreen(outputRoot, unit.unitId, false);
      await clearScreenshotEvidence(context, unit.rf, unit.cu);
      const result: E2ERunFixResult = {
        rf: cuRf,
        name: cuName,
        filePath: fullPath,
        specRelPath,
        passed: false,
        missing: false,
        output: contractError,
      };
      results.push(result);
      failures.push({
        result,
        unit,
        entry,
        currentSpec,
        rawOutput: contractError,
        fileName,
        fullPath,
      });
      continue;
    }

    await clearBaselineForCu(frontendRoot, unit.unitId);
    await clearScreenshotEvidence(context, unit.rf, unit.cu);
    const runStartedAt = Date.now();
    const run = await runCypressSpecWithRepair({
      frontendRoot,
      specRelPath,
      runCommand,
      timeoutMs: runTimeoutMs,
      ...resolveE2ERuntime(context),
    });

    if (run.passed) {
      try {
        const baselineError = await documentedInputBaselineError(context, unit);
        if (baselineError) throw new Error(baselineError);
        await persistScreenshotEvidence(context, frontendRoot, unit.rf, unit.cu, runStartedAt);
        await setRfGreen(outputRoot, unit.unitId, true);
        const passResult: E2ERunFixResult = {
          rf: cuRf,
          name: cuName,
          filePath: fullPath,
          specRelPath,
          passed: true,
          missing: false,
        };
        passResult.logPath = await writeRfFeedbackLog({
          outputRoot,
          entry,
          cu: unit.cu,
          specFileName: fileName,
          specPath: fullPath,
          runCommand,
          passed: true,
          rawOutput: run.output,
        });
        results.push(passResult);
        continue;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await setRfGreen(outputRoot, unit.unitId, false);
        const result: E2ERunFixResult = {
          rf: cuRf,
          name: cuName,
          filePath: fullPath,
          specRelPath,
          passed: false,
          missing: false,
          output: message,
        };
        results.push(result);
        failures.push({
          result,
          unit,
          entry,
          currentSpec,
          rawOutput: `${run.output}\n\n[qa-mcp] ${message}`,
          fileName,
          fullPath,
        });
        continue;
      }
    }

    await setRfGreen(outputRoot, unit.unitId, false);

    if (run.cacheError) {
      const cacheResult: E2ERunFixResult = {
        rf: cuRf,
        name: cuName,
        filePath: fullPath,
        specRelPath,
        passed: false,
        missing: false,
        cacheError: true,
        output: `${cypressCacheErrorNotice(resolveE2ERuntime(context).nodePath)}\n\n${extractCypressFailureSummary(run.output, 2000)}`,
      };
      cacheResult.logPath = await writeRfFeedbackLog({
        outputRoot,
        entry,
        cu: unit.cu,
        specFileName: fileName,
        specPath: fullPath,
        runCommand,
        passed: false,
        rawOutput: run.output,
        injectedOutput: cacheResult.output,
      });
      results.push(cacheResult);
      continue;
    }

    const result: E2ERunFixResult = {
      rf: cuRf,
      name: cuName,
      filePath: fullPath,
      specRelPath,
      passed: false,
      missing: false,
      output: extractCypressFailureSummary(run.output, 2000),
    };
    results.push(result);
    failures.push({ result, unit, entry, currentSpec, rawOutput: run.output, fileName, fullPath });
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
      failure.result.logPath = await writeRfFeedbackLog({
        outputRoot,
        entry: failure.entry,
        cu: failure.unit.cu,
        specFileName: failure.fileName,
        specPath: failure.fullPath,
        runCommand,
        passed: false,
        rawOutput: failure.rawOutput,
        injectedOutput: failure.result.output,
        fixPrompt: failure.result.fixPrompt,
      });
    }
  }

  // Fallos que NO entran en failuresToFix (multi-CU con oneFixAtATime): persiste
  // igualmente su log con la salida real, aunque sin prompt de corrección.
  for (const failure of failures) {
    if (failure.result.logPath) continue;
    failure.result.logPath = await writeRfFeedbackLog({
      outputRoot,
      entry: failure.entry,
      cu: failure.unit.cu,
      specFileName: failure.fileName,
      specPath: failure.fullPath,
      runCommand,
      passed: false,
      rawOutput: failure.rawOutput,
      injectedOutput: failure.result.output,
    });
  }

  if (untilGreen) {
    const status2 = await readE2EStatus(outputRoot);
    const allUnits = expandToCuUnits(extractOrBuildRfEntries(context));
    const scopeUnits =
      rfFilter && rfFilter.length > 0
        ? allUnits.filter((u) => rfFilter.map((id) => id.toLowerCase()).includes(u.rf.id.toLowerCase()))
        : allUnits;
    const completedStates = await Promise.all(
      scopeUnits.map(async (unit) => {
        const fullPath = path.join(outputRoot, `${unit.fileBase}.cy.js`);
        return inspectCuArtifacts(context, unit, status2, fullPath);
      })
    );
    const greenCount = completedStates.filter((state) => state.complete).length;
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

