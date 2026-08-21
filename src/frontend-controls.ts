import { promises as fs } from "node:fs";
import path from "node:path";
import { CuAutomationOperation, RfEntry } from "./types";

export interface FrontendUiControl {
  source: string;
  component?: string;
  tag: string;
  kind: "input" | "select" | "checkbox";
  id?: string;
  formControlName?: string;
  name?: string;
  label?: string;
  required: boolean;
}

function stripMarkup(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\{\{\s*([^}|]+).*?\}\}/g, "$1")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /(?:^|\s)(\[?[A-Za-z_:][\w:.-]*\]?)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const key = match[1].replace(/^\[|\]$/g, "").toLowerCase();
    attributes.set(key, (match[2] ?? match[3] ?? match[4] ?? "").trim());
  }
  return attributes;
}

function literalAttribute(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value
    .replace(/\s*\|\s*(?:translate|i18n).*$/i, "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();
  if (!cleaned || /[{}$]/.test(cleaned)) return undefined;
  return cleaned;
}

function controlKind(tag: string, attributes: Map<string, string>): FrontendUiControl["kind"] {
  const type = attributes.get("type")?.toLowerCase();
  if (type === "checkbox" || /checkbox/.test(tag)) return "checkbox";
  if (tag === "select" || /(?:select|dropdown)/.test(tag)) return "select";
  return "input";
}

function isControlTag(tag: string): boolean {
  return ["input", "textarea", "select"].includes(tag) ||
    /(?:^|-)(?:input|textarea|select|dropdown|checkbox|datepicker|date-picker|timepicker|time-picker)(?:-|$)/.test(tag);
}

function labelsByForAttribute(html: string): Map<string, string> {
  const labels = new Map<string, string>();
  const pattern = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const attributes = parseAttributes(match[1]);
    const target = literalAttribute(attributes.get("for"));
    const label = stripMarkup(match[2]);
    if (target && label) labels.set(target, label);
  }
  return labels;
}

export function extractFrontendControlsFromHtml(
  source: string,
  html: string,
  component?: string
): FrontendUiControl[] {
  const activeHtml = html.replace(/<!--[\s\S]*?-->/g, "");
  const labels = labelsByForAttribute(activeHtml);
  const controls: FrontendUiControl[] = [];
  const seen = new Set<string>();
  const tagPattern = /<([A-Za-z][\w-]*)\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(activeHtml)) !== null) {
    const tag = match[1].toLowerCase();
    if (!isControlTag(tag)) continue;
    const attributes = parseAttributes(match[2]);
    const type = attributes.get("type")?.toLowerCase();
    if (["hidden", "button", "submit", "reset"].includes(type ?? "")) continue;

    const id = literalAttribute(attributes.get("id"));
    const formControlName = literalAttribute(attributes.get("formcontrolname"));
    const name = literalAttribute(attributes.get("name"));
    const label = literalAttribute(attributes.get("label")) ??
      literalAttribute(attributes.get("aria-label")) ??
      literalAttribute(attributes.get("placeholder")) ??
      (id ? labels.get(id) : undefined);
    const identity = [source, id, formControlName, name, label, tag].filter(Boolean).join("|").toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    controls.push({
      source,
      component,
      tag,
      kind: controlKind(tag, attributes),
      id,
      formControlName,
      name,
      label,
      required: attributes.has("required") ||
        /^(?:true|required)$/i.test(attributes.get("aria-required") ?? "") ||
        /^(?:true|required)$/i.test(attributes.get("required") ?? ""),
    });
  }
  return controls;
}

async function componentSelectorForTemplate(htmlPath: string): Promise<string | undefined> {
  if (!/\.component\.html$/i.test(htmlPath)) return undefined;
  const tsPath = htmlPath.replace(/\.html$/i, ".ts");
  try {
    const source = await fs.readFile(tsPath, "utf8");
    return source.match(/\bselector\s*:\s*['"`]([^'"`]+)['"`]/)?.[1]?.trim();
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function buildFrontendControlInventory(frontendRoot: string): Promise<FrontendUiControl[]> {
  const srcRoot = path.join(frontendRoot, "src");
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", "dist", ".git", ".angular", "coverage"].includes(entry.name)) {
          await walk(fullPath);
        }
      } else if (/\.html$/i.test(entry.name)) {
        files.push(fullPath);
      }
    }
  };
  await walk(srcRoot);

  const groups = await Promise.all(files.map(async (filePath) => {
    const [html, component] = await Promise.all([
      fs.readFile(filePath, "utf8"),
      componentSelectorForTemplate(filePath),
    ]);
    const source = path.relative(frontendRoot, filePath).replace(/\\/g, "/");
    return extractFrontendControlsFromHtml(source, html, component);
  }));
  return groups.flat();
}

export function formatFrontendControlInventory(controls: FrontendUiControl[]): string {
  if (controls.length === 0) return "(no se detectaron controles editables en las plantillas frontend)";
  const groups = new Map<string, FrontendUiControl[]>();
  for (const control of controls) {
    const key = `${control.source}|${control.component ?? ""}`;
    const group = groups.get(key) ?? [];
    group.push(control);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    const header = `- ${first.source}${first.component ? ` | componente \`${first.component}\`` : ""}`;
    const items = group.map((control) => {
      const identity = [
        control.label ? `etiqueta \`${control.label}\`` : "",
        control.id ? `id \`${control.id}\`` : "",
        control.formControlName ? `formControlName \`${control.formControlName}\`` : "",
        control.name ? `name \`${control.name}\`` : "",
        `elemento \`${control.tag}\``,
        `tipo contrato \`${control.kind}\``,
        control.required ? "requerido" : "",
      ].filter(Boolean).join(" | ");
      return `  - ${identity}`;
    });
    return [header, ...items].join("\n");
  }).join("\n");
}

function normalized(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const scopeStopWords = new Set([
  "calculo", "calcular", "tasa", "tasas", "tarifa", "tarifas", "importe", "importes",
  "servicio", "servicios", "componente", "component", "html", "app", "src", "factura", "facturas",
  "simulador", "datos", "nominal", "valido", "validos", "recálculo", "recalculo",
]);

function scopeTokens(value: string): Set<string> {
  return new Set(normalized(value).split(/\s+/).filter((token) => {
    if (token.length < 4 || scopeStopWords.has(token)) return false;
    return true;
  }).map((token) => token.length > 5 && token.endsWith("s") ? token.slice(0, -1) : token));
}

function relevantControlGroups(rf: RfEntry, controls: FrontendUiControl[]): FrontendUiControl[][] {
  const rfTokens = scopeTokens(`${rf.name} ${rf.methodPath} ${rf.operationId}`);
  const groups = new Map<string, FrontendUiControl[]>();
  for (const control of controls) {
    const key = `${control.source}|${control.component ?? ""}`;
    const group = groups.get(key) ?? [];
    group.push(control);
    groups.set(key, group);
  }
  const ranked = [...groups.values()].map((group) => {
    const first = group[0];
    const candidateTokens = scopeTokens(`${first.source} ${first.component ?? ""}`);
    const score = [...rfTokens].filter((token) => candidateTokens.has(token)).length;
    return { group, score };
  });
  const maxScore = Math.max(0, ...ranked.map((candidate) => candidate.score));
  return maxScore === 0
    ? []
    : ranked.filter((candidate) => candidate.score === maxScore).map((candidate) => candidate.group);
}

function isExecutionTrigger(operation: CuAutomationOperation): boolean {
  return operation.kind === "click" &&
    /\b(?:calcular|consultar|buscar|simular|guardar|enviar|aceptar|continuar)\b/i.test(operation.label);
}

function operationCoversControl(operation: CuAutomationOperation, control: FrontendUiControl): boolean {
  if (operation.kind !== "set-control") return false;
  const selector = normalized(operation.selector ?? "");
  const key = normalized(operation.key ?? "");
  const label = normalized(operation.label ?? "");
  const strongIdentities = [control.id, control.formControlName, control.name]
    .filter((value): value is string => Boolean(value))
    .map(normalized);
  if (strongIdentities.some((identity) => selector.includes(identity) || key === identity)) return true;
  const visibleLabel = normalized(control.label ?? "");
  if (visibleLabel && (label.includes(visibleLabel) || visibleLabel.includes(label))) return true;
  return strongIdentities.length === 0 && selector.includes(normalized(control.tag));
}

/**
 * Tercera pata del contrato: frontend real → operaciones técnicas → texto humano.
 * Sólo se activa cuando el RF puede asociarse de forma inequívoca a uno o más
 * componentes por su nombre/ruta y el CU ejecuta una acción de envío/cálculo.
 */
export function frontendControlCoverageErrors(
  entries: RfEntry[],
  controls: FrontendUiControl[]
): string[] {
  const errors: string[] = [];
  for (const rf of entries) {
    const relevantGroups = relevantControlGroups(rf, controls);
    if (relevantGroups.length === 0) continue;
    for (const cu of rf.cases) {
      const operations = cu.actions?.flatMap((action) => action.automation) ?? [];
      if (!operations.some(isExecutionTrigger)) continue;
      for (const control of relevantGroups.flat()) {
        if (operations.some((operation) => operationCoversControl(operation, control))) continue;
        const identity = control.label ?? control.id ?? control.formControlName ?? control.name ?? control.tag;
        errors.push(
          `${rf.id}.${cu.id}: al ejecutar el cálculo/consulta se omite el control UI \`${identity}\` ` +
            `de ${control.source}; añade set-control con valor literal y menciónalo en la acción humana`
        );
      }
    }
  }
  return errors;
}
