import { spawn } from "node:child_process";

export interface CypressRunResult {
  passed: boolean;
  exitCode: number | null;
  output: string;
}

/**
 * Elimina secuencias ANSI de color para que la salida sea legible por el LLM.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Ejecuta Cypress (`cypress run`) para un único spec dentro del proyecto
 * frontend y devuelve el resultado (passed según exit code) junto con la
 * salida combinada stdout+stderr, ya sin códigos ANSI.
 *
 * Nunca rechaza la promesa: ante un error de arranque devuelve passed=false
 * con el detalle en `output`, para que el flujo de iteración pueda continuar.
 */
export async function runCypressSpec(params: {
  frontendRoot: string;
  specRelPath: string;
  runCommand?: string;
  timeoutMs?: number;
  /** Directorio que contiene node.exe/npx; se antepone al PATH del proceso. */
  nodePath?: string;
  /** Variables de entorno adicionales (p. ej. NO_PROXY) para la ejecución. */
  env?: Record<string, string>;
}): Promise<CypressRunResult> {
  const { frontendRoot, specRelPath, nodePath } = params;
  const runCommand = params.runCommand ?? "npx cypress run";
  const timeoutMs = params.timeoutMs ?? 300000;
  const fullCommand = `${runCommand} --spec "${specRelPath}" --reporter spec`;

  const extraEnv = params.env ?? {};
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const basePath = process.env.PATH ?? process.env.Path ?? "";
  const mergedPath = nodePath ? `${nodePath}${pathSeparator}${basePath}` : basePath;

  return new Promise<CypressRunResult>((resolve) => {
    let output = "";
    let settled = false;

    const finish = (result: CypressRunResult) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, output: stripAnsi(result.output) });
    };

    const child = spawn(fullCommand, {
      cwd: frontendRoot,
      shell: true,
      env: {
        ...process.env,
        PATH: mergedPath,
        Path: mergedPath,
        NO_COLOR: "1",
        CYPRESS_NO_COLOR: "1",
        FORCE_COLOR: "0",
        ...extraEnv,
      },
    });

    const onData = (buf: Buffer) => {
      output += buf.toString();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const timer = setTimeout(() => {
      output += `\n[qa-mcp] Timeout (${timeoutMs} ms) ejecutando Cypress; proceso terminado.\n`;
      try {
        child.kill("SIGKILL");
      } catch {
        /* noop */
      }
      finish({ passed: false, exitCode: null, output });
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ passed: code === 0, exitCode: code, output });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      output += `\n[qa-mcp] Error lanzando Cypress: ${err.message}\n`;
      finish({ passed: false, exitCode: null, output });
    });
  });
}

/**
 * Detecta el error de caché V8 corrupta/incompatible del binario de Cypress
 * (`cachedDataRejected`), que se produce típicamente al cambiar la versión de
 * Node/Electron respecto a la que verificó Cypress. Es un problema de ENTORNO,
 * no del spec: reescribir el test no lo soluciona.
 */
export function isCypressCacheError(output: string): boolean {
  const clean = stripAnsi(output);
  return (
    /cachedDataRejected/i.test(clean) ||
    /Invalid or incompatible cached data/i.test(clean)
  );
}

/**
 * Intenta reparar la caché del binario de Cypress ejecutando
 * `cypress cache clear` + `cypress install` + `cypress verify` bajo el mismo
 * Node/entorno configurado. Devuelve la salida combinada. Puede tardar (llega a
 * descargar el binario), así que se usa con un timeout amplio.
 */
export async function repairCypressCache(params: {
  frontendRoot: string;
  nodePath?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<CypressRunResult> {
  const { frontendRoot, nodePath } = params;
  const timeoutMs = params.timeoutMs ?? 900000;
  const extraEnv = params.env ?? {};
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const basePath = process.env.PATH ?? process.env.Path ?? "";
  const mergedPath = nodePath ? `${nodePath}${pathSeparator}${basePath}` : basePath;
  const command =
    "npx cypress cache clear && npx cypress install && npx cypress verify";

  return new Promise<CypressRunResult>((resolve) => {
    let output = "";
    let settled = false;
    const finish = (result: CypressRunResult) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, output: stripAnsi(result.output) });
    };
    const child = spawn(command, {
      cwd: frontendRoot,
      shell: true,
      env: {
        ...process.env,
        PATH: mergedPath,
        Path: mergedPath,
        NO_COLOR: "1",
        CYPRESS_NO_COLOR: "1",
        FORCE_COLOR: "0",
        ...extraEnv,
      },
    });
    const onData = (buf: Buffer) => {
      output += buf.toString();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => {
      output += `\n[qa-mcp] Timeout (${timeoutMs} ms) reparando la caché de Cypress; proceso terminado.\n`;
      try {
        child.kill("SIGKILL");
      } catch {
        /* noop */
      }
      finish({ passed: false, exitCode: null, output });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ passed: code === 0, exitCode: code, output });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      output += `\n[qa-mcp] Error reparando la caché de Cypress: ${err.message}\n`;
      finish({ passed: false, exitCode: null, output });
    });
  });
}

/**
 * Recorta la salida de Cypress para inyectarla en el prompt de corrección.
 * Conserva la cola (que contiene los errores por test y el resumen final),
 * limitando el tamaño para no desbordar el contexto del modelo.
 */
export function extractCypressFailureSummary(output: string, maxChars = 12000): string {
  const clean = stripAnsi(output).trim();
  if (clean.length <= maxChars) {
    return clean;
  }
  const head = clean.slice(0, 1000);
  const tail = clean.slice(clean.length - (maxChars - 1000));
  return `${head}\n...\n[qa-mcp] (salida recortada)\n...\n${tail}`;
}
