export interface BackendConfig {
  root: string;
  language: string;
  build: string;
}

export interface FrontendConfig {
  root?: string;
  framework: string;
  e2e: string;
}

export interface EvidenceConfig {
  excelTemplate: string;
  wordTemplate?: string;
  output: string;
}

export interface PromptsConfig {
  e2e?: string;
  rfcu?: string;
}

export interface McpQaConfig {
  version: number;
  backend: BackendConfig;
  frontend: FrontendConfig;
  e2eBaseUrl?: string;
  e2eRunCommand?: string;
  e2eNodePath?: string;
  e2eEnv?: Record<string, string>;
  /** Si es true, ejecuta Cypress con navegador visible (`--headed`). */
  e2eHeaded?: boolean;
  /** Navegador para `--browser` (chrome, edge, electron, firefox). */
  e2eBrowser?: string;
  openApi: string;
  appRouting?: string;
  requirements?: string;
  restTests: string;
  e2eTests: string;
  evidence: EvidenceConfig;
  prompts?: PromptsConfig;
}

export interface CuCase {
  id: string;
  name: string;
  /**
   * Contrato v2: una acción funcional escrita para una persona y las
   * operaciones técnicas que materializan exactamente esa misma finalidad.
   */
  actions?: CuAction[];
  /** Líneas del contrato v2 que parecían operaciones pero no se pudieron interpretar. */
  automationParseErrors?: string[];
  /** Proyección manual/compatibilidad con rf-cu.md v1. */
  steps: string[];
  /**
   * Valores literales de los controles con datos de prueba que utiliza el CU.
   * En contrato v2 es una vista derivada de actions[].automation; se conserva
   * para baseline y compatibilidad. `undefined` identifica documentos legacy
   * sin declaración canónica.
   */
  inputValues?: CuInputValue[];
}

export type CuAutomationOperationKind =
  | "visit"
  | "set-control"
  | "click"
  | "open"
  | "verify"
  | "wait";

export interface CuAutomationOperation {
  /** Identificador estable dentro del CU, p. ej. A02.1. */
  id: string;
  /** Acción manual (base 1) cuya finalidad implementa. */
  actionNumber: number;
  kind: CuAutomationOperationKind;
  /** Nombre comprensible del control, botón, vista o resultado. */
  label: string;
  /** Selector CSS literal cuando la operación actúa sobre el DOM. */
  selector?: string;
  /** Ruta, URL, alias o destino cuando no corresponde un selector DOM. */
  target?: string;
  /** Clave estable de baseline para operaciones set-control. */
  key?: string;
  controlType?: "input" | "select" | "checkbox";
  /** Valor canónico exacto que utilizará Cypress. */
  value?: string;
  /** Resultado observable esperado para verify/wait. */
  expected?: string;
}

export interface CuAction {
  /** A01, A02...; coincide con la numeración manual. */
  id: string;
  /** Instrucción sin selectores ni detalles internos de Cypress. */
  manual: string;
  /** Una o varias operaciones técnicas derivadas de la misma acción. */
  automation: CuAutomationOperation[];
}

export interface CuInputValue {
  /** Clave exacta que debe aparecer bajo `inputs` en e2e-baseline.json. */
  key: string;
  /** Tipo de control que recibe el dato de prueba. Obligatorio en el contrato actual. */
  kind?: "input" | "select" | "checkbox";
  /** Selector CSS literal del control o de su componente contenedor. */
  selector: string;
  /** Valor exacto que el test establece y el baseline almacena. */
  value: string;
  /** Acción numerada (base 1) que establece el control y genera su evidencia. */
  actionNumber?: number;
}

export interface RfEntry {
  id: string;
  name: string;
  methodPath: string;
  operationId: string;
  cases: CuCase[];
}

export interface LoadedContext {
  config: McpQaConfig;
  configPath: string;
  openApiPath: string;
  openApiContent: string;
  requirementsPath?: string;
  requirementsContent?: string;
}
