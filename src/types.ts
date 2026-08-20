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
  steps: string[];
  /**
   * Valores literales de los controles con datos de prueba que utiliza el CU.
   * Incluye input/textarea, select/dropdown y checkbox. `undefined`
   * identifica documentos antiguos sin el bloque canónico; `[]` significa que
   * el CU declara explícitamente que no utiliza controles con valor/estado.
   */
  inputValues?: CuInputValue[];
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
