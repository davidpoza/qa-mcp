import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CuAction,
  CuAutomationOperation,
  CuAutomationOperationKind,
  CuCase,
  LoadedContext,
  RfEntry,
} from "./types";

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
  return /^\s*-\s+\*\*(CU-\d+):\s+(.+)\.\*\*/;
}

function stepRegex(): RegExp {
  return /^\d+\.\s+(.+)/;
}

function inputValuesHeaderRegex(): RegExp {
  return /^\s*-\s+\*\*Valores de (?:controles|inputs):\*\*\s*$/i;
}

function automationHeaderRegex(): RegExp {
  return /^\s*-\s+\*\*Contrato de automatización:\*\*\s*$/i;
}

function manualActionsHeaderRegex(): RegExp {
  return /^\s*-\s+\*\*Acciones para ejecución manual:\*\*\s*$/i;
}

function automationOperationRegex(): RegExp {
  return /^\s+-\s+`([^`]+)`\s+\|\s+(.+)\s*$/;
}

function parseAutomationOperation(line: string): CuAutomationOperation | undefined {
  const match = line.match(automationOperationRegex());
  if (!match) return undefined;
  const [, id, fieldsText] = match;
  const fields = new Map<string, string>();
  for (const token of fieldsText.split(/\s+\|\s+/)) {
    const field = token.match(/^([^`]+?)\s+`([^`]*)`\s*\.?$/);
    if (!field) return undefined;
    fields.set(field[1].trim().toLowerCase(), field[2]);
  }
  const actionNumber = Number(fields.get("acción"));
  const kind = fields.get("operación") as CuAutomationOperationKind | undefined;
  const label = fields.get("etiqueta");
  if (!Number.isInteger(actionNumber) || !kind || !label) return undefined;
  return {
    id: id.trim(),
    actionNumber,
    kind,
    label,
    selector: fields.get("selector"),
    target: fields.get("destino"),
    key: fields.get("clave"),
    controlType: fields.get("tipo") as "input" | "select" | "checkbox" | undefined,
    value: fields.get("valor"),
    expected: fields.get("resultado"),
  };
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
  let inAutomationContract = false;

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
      inAutomationContract = false;
      continue;
    }

    const cuMatch = line.match(cuRegex());
    if (cuMatch && currentRf) {
      const [, id, name] = cuMatch;
      currentRf.cases.push({ id, name, steps: [] });
      currentCuIndex = currentRf.cases.length - 1;
      inAutomationContract = false;
      continue;
    }

    if (inputValuesHeaderRegex().test(line) && currentRf && currentCuIndex >= 0) {
      currentRf.cases[currentCuIndex].inputValues = [];
      inAutomationContract = false;
      continue;
    }

    if (automationHeaderRegex().test(line) && currentRf && currentCuIndex >= 0) {
      currentRf.cases[currentCuIndex].actions = [];
      inAutomationContract = true;
      continue;
    }

    if (manualActionsHeaderRegex().test(line) && currentRf && currentCuIndex >= 0) {
      inAutomationContract = false;
      continue;
    }

    if (inAutomationContract && currentRf && currentCuIndex >= 0) {
      const operation = parseAutomationOperation(line);
      if (operation) {
        const cu = currentRf.cases[currentCuIndex];
        const actionId = `A${String(operation.actionNumber).padStart(2, "0")}`;
        let action = cu.actions?.find((candidate) => candidate.id === actionId);
        if (!action) {
          action = { id: actionId, manual: "", automation: [] };
          cu.actions?.push(action);
        }
        action.automation.push(operation);
        continue;
      }
      if (/^\s+-\s+/.test(line)) {
        const cu = currentRf.cases[currentCuIndex];
        (cu.automationParseErrors ??= []).push(line.trim());
        continue;
      }
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

  for (const rf of rfEntries) {
    for (const cu of rf.cases) {
      if (!cu.actions) continue;
      const parsedActions = cu.actions;
      cu.actions = cu.steps.map((manual, index): CuAction => {
        const id = `A${String(index + 1).padStart(2, "0")}`;
        return {
          id,
          manual,
          automation: parsedActions.find((action) => action.id === id)?.automation ?? [],
        };
      });
      // Conserva también referencias a acciones inexistentes para que la
      // validación las rechace explícitamente; nunca descartes silenciosamente
      // una operación técnica huérfana.
      const validActionIds = new Set(cu.actions.map((action) => action.id));
      cu.actions.push(
        ...parsedActions.filter((action) => !validActionIds.has(action.id))
      );
      // inputValues queda como vista derivada para baseline y compatibilidad,
      // pero ya no es una segunda fuente de verdad en documentos v2.
      cu.inputValues = cu.actions.flatMap((action) =>
        action.automation
          .filter((operation) => operation.kind === "set-control")
          .map((operation) => ({
            key: operation.key ?? "",
            kind: operation.controlType,
            selector: operation.selector ?? "",
            value: operation.value ?? "",
            actionNumber: operation.actionNumber,
          }))
      );
    }
  }

  return rfEntries;
}

function normalizedInstruction(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[`“”"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function technicalReference(value: string): string | undefined {
  const patterns: Array<[RegExp, string]> = [
    [/(^|\s)[#.][a-z_][\w-]*/i, "selector CSS"],
    [/\b[a-z][\w-]*:(?:nth|first|last|has|not|checked|disabled|visible)[\w(.-]*/i, "selector CSS"],
    [/\[[^\]]*(?:=|formcontrol|data-|aria-)[^\]]*\]/i, "atributo técnico"],
    [/<\/?[a-z][\w-]*[^>]*>/i, "tag HTML"],
    [/\b(?:app|empresas-ui)-[a-z0-9-]+\b/i, "nombre de componente"],
    [/\b(?:mat|ion|ng|p)-[a-z0-9-]+\b/i, "nombre de componente"],
    [/\b[a-z][\w-]*(?:\.[a-z][\w-]*)+\b/i, "clave interna o i18n"],
    [/\b[a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b|\b[a-z][a-z0-9]*_[a-z0-9_]+\b/, "identificador interno"],
    [/\b(?:input|select|checkbox|textarea|button|option|fieldset|formcontrolname)\b/i, "tipo de control técnico"],
    [/\b(?:cy\.|setDocumented\w*|getNativeControl|scrollIntoViewForEvidence)\b/i, "helper de automatización"],
    [/(^|\s)@[a-z_][\w-]*/i, "alias técnico"],
    [/(^|\s)\/\/[a-z*]|\b(?:xpath|data-cy|data-testid)\b/i, "selector técnico"],
    [/https?:\/\/\S+|(^|\s)\/[a-z0-9][\w./-]*/i, "ruta o URL técnica"],
  ];
  return patterns.find(([pattern]) => pattern.test(value))?.[1];
}

function operationVerbPattern(kind: CuAutomationOperationKind): RegExp {
  switch (kind) {
    case "visit":
      return /\b(?:acceder|abrir|navegar|ir|entrar)\b/i;
    case "set-control":
      return /\b(?:introducir|ingresar|escribir|rellenar|seleccionar|elegir|marcar|desmarcar|establecer|indicar)\b/i;
    case "click":
      return /\b(?:pulsar|presionar|hacer clic|accionar|seleccionar)\b/i;
    case "open":
      return /\b(?:abrir|desplegar|expandir|mostrar)\b/i;
    case "verify":
      return /\b(?:comprobar|verificar|confirmar|validar|observar)\b/i;
    case "wait":
      return /\b(?:esperar|comprobar|verificar|observar)\b/i;
  }
}

function ambiguousControlValue(value: string): boolean {
  const normalized = normalizedInstruction(value);
  return [
    /\b(?:un|una)\s+(?:valor|opcion|fecha|hora)\s+(?:valido|valida|disponible|cualquiera)\b/,
    /\b(?:el|la)\s+(?:primer|primera)\s+(?:valor|opcion)(?:\s+disponible)?\b/,
    /\b(?:fecha|hora)\s+(?:valida|disponible|cualquiera)\b/,
    /\bindicar\s+la\s+fecha\s+y\s+la\s+hora\b/,
    /^(?:tbd|todo|por definir|pendiente|<[^>]+>)$/,
  ].some((pattern) => pattern.test(normalized));
}

function operationFields(operation: CuAutomationOperation): string[] {
  return [
    `acción \`${String(operation.actionNumber).padStart(2, "0")}\``,
    `operación \`${operation.kind}\``,
    ...(operation.key ? [`clave \`${operation.key}\``] : []),
    ...(operation.controlType ? [`tipo \`${operation.controlType}\``] : []),
    `etiqueta \`${operation.label}\``,
    ...(operation.selector ? [`selector \`${operation.selector}\``] : []),
    ...(operation.target ? [`destino \`${operation.target}\``] : []),
    ...(operation.value !== undefined ? [`valor \`${operation.value}\``] : []),
    ...(operation.expected ? [`resultado \`${operation.expected}\``] : []),
  ];
}

/** Render determinista de una operación para el bloque técnico de rf-cu.md. */
export function formatAutomationOperation(operation: CuAutomationOperation): string {
  return `    - \`${operation.id}\` | ${operationFields(operation).join(" | ")}`;
}

/** Descripción técnica derivada; nunca se persiste como una segunda narración libre. */
export function technicalInstruction(operation: CuAutomationOperation): string {
  switch (operation.kind) {
    case "set-control": {
      const verb = operation.controlType === "select"
        ? "Seleccionar"
        : operation.controlType === "checkbox"
          ? "Establecer"
          : "Ingresar";
      const eventHint = operation.controlType === "input"
        ? " disparando los eventos input y change mediante setDocumentedControl"
        : " mediante setDocumentedControl";
      return `${verb} el valor ${JSON.stringify(operation.value ?? "")} en ${operation.selector ?? "(sin selector)"}${eventHint}.`;
    }
    case "visit":
      return `Navegar a ${operation.target ?? operation.selector ?? operation.label}.`;
    case "click":
      return `Pulsar ${operation.label} usando ${operation.selector ?? operation.target ?? "el objetivo documentado"}.`;
    case "open":
      return `Abrir ${operation.label} usando ${operation.selector ?? operation.target ?? "el objetivo documentado"}.`;
    case "verify":
      return `Verificar ${operation.label} en ${operation.selector ?? operation.target ?? "la UI"}: ${operation.expected ?? "resultado observable"}.`;
    case "wait":
      return `Esperar ${operation.label} en ${operation.target ?? operation.selector ?? "el flujo"}: ${operation.expected ?? "respuesta esperada"}.`;
  }
}

/** Plan técnico agrupado por acción humana, derivado de sus operaciones atómicas. */
export function technicalActionInstruction(action: CuAction): string {
  if (
    action.automation.length > 0 &&
    action.automation.every(
      (operation) => operation.kind === "set-control" && operation.controlType === "input"
    )
  ) {
    const clauses = action.automation.map(
      (operation) => `el valor ${JSON.stringify(operation.value ?? "")} en ${operation.selector ?? "(sin selector)"}`
    );
    const joined = clauses.length === 1
      ? clauses[0]
      : `${clauses.slice(0, -1).join(", ")} y ${clauses.at(-1)}`;
    return `Ingresar ${joined} disparando los eventos input y change mediante setDocumentedControl.`;
  }
  return action.automation.map(technicalInstruction).join(" ");
}

/** Única proyección permitida para Excel/Word: nunca contiene campos técnicos. */
export function manualInstructions(cu: CuCase): string[] {
  return cu.actions?.map((action) => action.manual) ?? cu.steps;
}

export function automationContractErrors(rfId: string, cu: CuCase): string[] {
  if (!cu.actions) return inputActionContractErrors(rfId, cu);
  const errors: string[] = (cu.automationParseErrors ?? []).map(
    (line) => `${rfId}.${cu.id}: operación técnica mal formada: ${line}`
  );
  const operationIds = new Set<string>();
  const controlKeys = new Set<string>();
  const allowedKinds = new Set<CuAutomationOperationKind>([
    "visit", "set-control", "click", "open", "verify", "wait",
  ]);

  if (cu.actions.length !== cu.steps.length) {
    errors.push(`${rfId}.${cu.id}: las acciones manuales y el contrato estructurado no tienen la misma longitud`);
  }
  if (cu.actions.length === 0) {
    errors.push(`${rfId}.${cu.id}: no define ninguna acción para ejecución manual`);
  }
  cu.actions.forEach((action, actionIndex) => {
    const expectedActionNumber = actionIndex + 1;
    const label = `${rfId}.${cu.id} acción ${String(expectedActionNumber).padStart(2, "0")}`;
    if (action.id !== `A${String(expectedActionNumber).padStart(2, "0")}`) {
      errors.push(`${label}: id técnico ${action.id} no coincide con su número manual`);
    }
    if (action.automation.length === 0) {
      errors.push(`${label}: no tiene ninguna operación en \`Contrato de automatización\``);
      return;
    }
    const manual = normalizedInstruction(action.manual);
    const exposedTechnicalReference = technicalReference(action.manual);
    if (exposedTechnicalReference) {
      errors.push(`${label}: la instrucción humana expone un ${exposedTechnicalReference}; usa sólo textos o elementos visibles`);
    }
    if (ambiguousControlValue(action.manual)) {
      errors.push(
        `${label}: la instrucción humana usa un valor ambiguo; indica el valor literal de cada input, fecha, hora y opción seleccionada`
      );
    }
    for (const [operationIndex, operation] of action.automation.entries()) {
      const expectedOperationId = `${action.id}.${operationIndex + 1}`;
      if (operation.id !== expectedOperationId) {
        errors.push(`${label}: se esperaba la operación ${expectedOperationId}, pero aparece ${operation.id}`);
      }
      if (operationIds.has(operation.id)) errors.push(`${label}: operación duplicada ${operation.id}`);
      operationIds.add(operation.id);
      if (operation.actionNumber !== expectedActionNumber) {
        errors.push(`${label}: ${operation.id} referencia la acción ${operation.actionNumber}`);
      }
      if (!allowedKinds.has(operation.kind)) {
        errors.push(`${label}: ${operation.id} usa la operación no soportada ${operation.kind}`);
      }
      if (
        allowedKinds.has(operation.kind) &&
        !operationVerbPattern(operation.kind).test(normalizedInstruction(action.manual))
      ) {
        errors.push(`${label}: la finalidad humana no corresponde con la operación técnica ${operation.kind} de ${operation.id}`);
      }
      if (!operation.label || !manual.includes(normalizedInstruction(operation.label))) {
        errors.push(`${label}: debe mencionar literalmente la etiqueta humana \`${operation.label}\` de ${operation.id}`);
      }
      const technicalLabel = technicalReference(operation.label);
      if (technicalLabel) {
        errors.push(`${label}: la etiqueta \`${operation.label}\` de ${operation.id} parece un ${technicalLabel}, no un texto visible`);
      }
      if (operation.selector && manual.includes(normalizedInstruction(operation.selector))) {
        errors.push(`${label}: la instrucción humana no debe exponer el selector técnico \`${operation.selector}\``);
      }
      if (operation.target && manual.includes(normalizedInstruction(operation.target))) {
        errors.push(`${label}: la instrucción humana no debe exponer el destino técnico \`${operation.target}\``);
      }
      if (/\bdispar(?:a|ar|ando).*\beventos?\b|\b(?:input|change)\s+y\s+(?:input|change)\b/i.test(action.manual)) {
        errors.push(`${label}: la instrucción humana no debe describir eventos internos de Cypress`);
      }

      if (operation.kind === "set-control") {
        if (
          !operation.key ||
          !operation.controlType ||
          !operation.selector ||
          operation.value === undefined ||
          operation.value.trim().length === 0
        ) {
          errors.push(`${label}: ${operation.id} set-control requiere clave, tipo, etiqueta, selector y valor`);
        }
        if (
          operation.controlType &&
          !["input", "select", "checkbox"].includes(operation.controlType)
        ) {
          errors.push(`${label}: ${operation.id} usa el tipo de control no soportado ${operation.controlType}`);
        }
        if (operation.key) {
          if (controlKeys.has(operation.key)) errors.push(`${label}: clave de control duplicada ${operation.key}`);
          controlKeys.add(operation.key);
        }
        if (operation.value !== undefined && ambiguousControlValue(operation.value)) {
          errors.push(
            `${label}: ${operation.id} declara el valor ambiguo \`${operation.value}\`; usa el valor literal que ejecutarán la persona y Cypress`
          );
        }
        if (operation.controlType === "checkbox" && operation.value !== undefined) {
          const expectedStateVerb = operation.value === "true"
            ? /\b(?:marcar|activar|seleccionar)\b/i
            : operation.value === "false"
              ? /\b(?:desmarcar|desactivar)\b/i
              : undefined;
          if (!expectedStateVerb) {
            errors.push(`${label}: ${operation.id} checkbox sólo admite valor true o false`);
          } else if (!expectedStateVerb.test(normalizedInstruction(action.manual))) {
            errors.push(
              `${label}: la acción humana debe ${operation.value === "true" ? "marcar/activar" : "desmarcar/desactivar"} ` +
                `la etiqueta visible \`${operation.label}\` sin exponer el booleano técnico`
            );
          }
        } else if (operation.value !== undefined && !manual.includes(normalizedInstruction(operation.value))) {
          errors.push(`${label}: debe mencionar el valor humano \`${operation.value}\` de ${operation.id}`);
        }
      } else if (["click", "open"].includes(operation.kind) && !operation.selector) {
        errors.push(`${label}: ${operation.id} ${operation.kind} requiere selector`);
      } else if (operation.kind === "visit" && !operation.target) {
        errors.push(`${label}: ${operation.id} visit requiere destino`);
      } else if (operation.kind === "verify") {
        if (!operation.selector && !operation.target) {
          errors.push(`${label}: ${operation.id} verify requiere selector o destino`);
        }
        if (!operation.expected) errors.push(`${label}: ${operation.id} ${operation.kind} requiere resultado`);
        else if (!manual.includes(normalizedInstruction(operation.expected))) {
          errors.push(`${label}: debe mencionar el resultado humano \`${operation.expected}\` de ${operation.id}`);
        }
      } else if (operation.kind === "wait") {
        if (!operation.target) errors.push(`${label}: ${operation.id} wait requiere destino`);
        if (!operation.expected) errors.push(`${label}: ${operation.id} ${operation.kind} requiere resultado`);
        else if (!manual.includes(normalizedInstruction(operation.expected))) {
          errors.push(`${label}: debe mencionar el resultado humano \`${operation.expected}\` de ${operation.id}`);
        }
      }
    }
  });
  return errors;
}

/** Valida unicidad documental y el contrato funcional/técnico de cada CU. */
export function rfCuContractErrors(entries: RfEntry[]): string[] {
  const errors: string[] = [];
  const rfIds = new Set<string>();
  for (const rf of entries) {
    const normalizedRfId = rf.id.toLowerCase();
    if (rfIds.has(normalizedRfId)) {
      errors.push(`RF duplicado: ${rf.id}`);
    }
    rfIds.add(normalizedRfId);
    if (rf.cases.length === 0) {
      errors.push(`${rf.id}: no contiene ningún CU reconocible`);
      continue;
    }
    const cuIds = new Set<string>();
    for (const cu of rf.cases) {
      const normalizedCuId = cu.id.toLowerCase();
      if (cuIds.has(normalizedCuId)) {
        errors.push(`${rf.id}: CU duplicado: ${cu.id}`);
      }
      cuIds.add(normalizedCuId);
      errors.push(...automationContractErrors(rf.id, cu));
    }
  }
  if (entries.length === 0) errors.push("No se reconoció ningún RF en el documento");
  return errors;
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
      } else {
        const isSource = /\.(ts|html)$/i.test(entry.name) && !/\.spec\.ts$/i.test(entry.name);
        const isTranslation = /\.json$/i.test(entry.name) &&
          /(?:i18n|locale|locales|translation|translations|assets[\\/](?:lang|i18n))/i.test(fullPath);
        if (isSource || isTranslation) output.push(fullPath);
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
  if (/\.json$/.test(lower) && /i18n|locale|translation|assets[\\/](?:lang|i18n)/.test(lower)) score += 8;
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
    "--- CONTRATO INVARIANTE DE ACCIONES V2 (OBLIGATORIO, incluso si prompts.rfcu es personalizado) ---",
    "Dentro de CADA CU escribe primero `  - **Acciones para ejecución manual:**` con pasos numerados que usen EXCLUSIVAMENTE textos, etiquetas, opciones, botones, secciones y estados que una persona ve en pantalla.",
    "En las acciones humanas están PROHIBIDOS selectores/IDs/clases CSS, atributos, tags o nombres de componentes (app-*, empresas-ui-*), tipos HTML (input/select/checkbox), rutas/URLs, claves i18n, aliases, helpers y eventos internos. Resuelve las claves i18n con los ficheros de traducción incluidos en el contexto.",
    "Para TODO campo editable o seleccionable, la acción humana indica la etiqueta VISIBLE y el valor LITERAL: fecha, hora, número, texto o texto visible exacto de la opción. PROHIBIDO usar `una opción disponible`, `un valor válido`, `la primera opción`, `indicar la fecha y la hora` o equivalentes sin concretar.",
    "Después escribe exactamente `  - **Contrato de automatización:**` y una línea por cada operación técnica vinculada al número de la acción humana.",
    "Formato set-control:     - `A02.1` | acción `02` | operación `set-control` | clave `pesoAeronave` | tipo `input` | etiqueta `Peso de la aeronave` | selector `#pesoAeronave input` | valor `15000`.",
    "Formatos restantes: operación `visit` (etiqueta + destino), `click`/`open` (etiqueta + selector), `verify` (etiqueta + selector o destino + resultado) y `wait` (etiqueta + destino + resultado).",
    "Una acción humana PUEDE agrupar varios controles relacionados; en ese caso crea A02.1, A02.2, A02.3, todos con acción `02`. Cada operación genera su propia evidencia técnica.",
    "Si una acción enlaza N operaciones set-control, debe mencionar las N etiquetas visibles y los N valores literales (salvo true/false de checkbox). La acción humana debe mencionar literalmente las mismas etiquetas VISIBLES, valores y resultados del contrato, pero nunca sus selectores, destinos ni detalles de Cypress. No puede haber acciones humanas sin operaciones ni operaciones huérfanas.",
    "set-control admite EXCLUSIVAMENTE tipo `input`, `select` o `checkbox`. Datepicker, timepicker y textarea usan tipo técnico `input` con el selector de su control/wrapper real; NO uses los tipos datepicker, timepicker, dropdown ni textarea.",
    "En selects usa como valor el TEXTO VISIBLE exacto. En checkbox, `true`/`false` queda sólo en el contrato técnico y la acción humana usa Marcar/Activar o Desmarcar/Desactivar con la etiqueta visible. Los eventos input/change se derivan del tipo y NO se escriben en la instrucción humana.",
    "Este bloque estructurado es la única fuente técnica para generateE2ETests, baseline y capturas; las acciones manuales son su proyección para Excel/Word.",
    "--- FIN CONTRATO INVARIANTE ---",
    "",
  ].join("\n");

  return { outputPath, prompt };
}

/**
 * Valida el documento v2 completo. Se expone para que el modo asistido pueda
 * comprobar el fichero escrito por el agente con las mismas reglas que el
 * modo sampling antes de considerarlo terminado.
 */
export function validateRfCuMarkdown(markdown: string): RfEntry[] {
  const parsed = parseRfCu(markdown);
  const legacyValueSections = markdown
    .split(/\r?\n/)
    .filter((line) => inputValuesHeaderRegex().test(line)).length;
  if (legacyValueSections > 0) {
    throw new Error(
      "El rf-cu.md generado mezcla el contrato v1 `Valores de controles` con el contrato v2. " +
        "Elimina el bloque legacy: los set-control del `Contrato de automatización` son la única fuente técnica."
    );
  }
  const expectedManualSections = parsed.reduce((total, rf) => total + rf.cases.length, 0);
  const actualManualSections = markdown
    .split(/\r?\n/)
    .filter((line) => manualActionsHeaderRegex().test(line)).length;
  if (actualManualSections !== expectedManualSections) {
    throw new Error(
      `El rf-cu.md generado debe incluir exactamente un bloque \`Acciones para ejecución manual\` por CU ` +
        `(esperados: ${expectedManualSections}; encontrados: ${actualManualSections}).`
    );
  }
  const actualAutomationSections = markdown
    .split(/\r?\n/)
    .filter((line) => automationHeaderRegex().test(line)).length;
  if (actualAutomationSections !== expectedManualSections) {
    throw new Error(
      `El rf-cu.md generado debe incluir exactamente un bloque \`Contrato de automatización\` por CU ` +
        `(esperados: ${expectedManualSections}; encontrados: ${actualAutomationSections}).`
    );
  }
  const missingActionContracts = parsed.flatMap((rf) =>
    rf.cases
      .filter((cu) => cu.actions === undefined)
      .map((cu) => `${rf.id}.${cu.id}`)
  );
  if (missingActionContracts.length > 0) {
    throw new Error(
      "El rf-cu.md generado no declara el bloque obligatorio `Contrato de automatización` en: " +
        missingActionContracts.join(", ") +
        ". Cada acción manual debe enlazar una o más operaciones técnicas estructuradas."
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
  const contractErrors = rfCuContractErrors(parsed);
  if (contractErrors.length > 0) {
    throw new Error(
      "El rf-cu.md generado permite divergencia entre acciones manuales y automatización:\n- " +
        contractErrors.join("\n- ")
    );
  }
  return parsed;
}

export async function validateRfCuFile(
  context: LoadedContext,
  requirementsPathOverride?: string
): Promise<{ outputPath: string; count: number }> {
  const configRoot = path.dirname(context.configPath);
  const outputPath = requirementsPathOverride
    ? path.resolve(process.cwd(), requirementsPathOverride)
    : context.requirementsPath ?? path.resolve(configRoot, "docs", "rf-cu.md");
  const markdown = await fs.readFile(outputPath, "utf8");
  const parsed = validateRfCuMarkdown(markdown);
  return { outputPath, count: parsed.length };
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
  const parsed = validateRfCuMarkdown(markdown);
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
