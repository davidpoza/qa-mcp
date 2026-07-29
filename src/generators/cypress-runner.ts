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
}): Promise<CypressRunResult> {
  const { frontendRoot, specRelPath } = params;
  const runCommand = params.runCommand ?? "npx cypress run";
  const timeoutMs = params.timeoutMs ?? 300000;
  const fullCommand = `${runCommand} --spec "${specRelPath}" --reporter spec`;

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
        NO_COLOR: "1",
        CYPRESS_NO_COLOR: "1",
        FORCE_COLOR: "0",
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
