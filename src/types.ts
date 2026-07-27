export interface BackendConfig {
  root: string;
  language: string;
  build: string;
}

export interface FrontendConfig {
  root: string;
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
}

export interface McpQaConfig {
  version: number;
  backend: BackendConfig;
  frontend: FrontendConfig;
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
