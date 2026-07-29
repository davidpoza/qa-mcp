# QA MCP

Servidor MCP para automatizar generación de artefactos de QA:
- tests API con Rest Assured (`generateRestTests`)
- tests E2E con Cypress (`generateE2ETests`) y ejecución/feedback (`runE2ETests`)
- documentación ETP en Excel (`exportETPAsExcel`) y Word (`exportETPAsWord`)
- autocompletado de `rf-cu.md` (`autoCompleteRfCu`)

Usa `mcp.config.json` en la raíz del proyecto para localizar OpenAPI, frontend, rutas de salida y plantillas.

Para `generateE2ETests`, la generación es **genérica y guiada por LLM** (MCP sampling): para cada RF/CU, el modelo del cliente genera un spec Cypress **real** (con `cy.intercept`, interacción con selectores derivados del código frontend y aserciones), no un esqueleto de `cy.log`.
- Puedes definir las reglas de estilo/interacción con `prompts.e2e` en `mcp.config.json` (opcional). Si no se indica, usa `prompts/e2e.md` del servidor MCP.
- También puedes pasar `promptOverride` en la invocación de la tool para ajustar una ejecución puntual.
- Requiere un cliente MCP que soporte sampling (p. ej. VS Code Copilot 1.102+). Si el cliente **no** soporta sampling (Roo Code, Cline, opencode…), la tool pasa a **modo asistido** (ver más abajo).

**Modo asistido (sin MCP sampling):** si el cliente conectado no declara la capacidad `sampling`, `generateE2ETests` y `autoCompleteRfCu` **no pueden pedir la generación al modelo por sí mismas**. En su lugar:
- `generateE2ETests` prepara el entorno Cypress (helpers, config y baseline) y **devuelve el prompt de generación + la ruta de salida exacta de UN RF por llamada** (el primero cuyo spec aún no existe). En vez de embeber el código frontend (que desborda el contexto del cliente), el prompt **lista las rutas de los ficheros relevantes** para que el agente los abra con sus propias herramientas de fichero. El agente genera el spec, lo escribe y **vuelve a llamar** para el siguiente RF pendiente, hasta completarlos todos.
- `autoCompleteRfCu` **devuelve el prompt** y la ruta de salida para que el agente genere y escriba `rf-cu.md`.
- El modo asistido se activa **automáticamente** al detectar la falta de sampling. También puedes forzarlo con el parámetro `assisted: true` en la invocación.

**Bucle de auto-corrección en modo asistido (`runE2ETests`):** aunque el cliente no tenga sampling, el servidor **sí puede ejecutar Cypress** y devolver el resultado como feedback. Flujo:
1. `generateE2ETests` (modo asistido) → el agente genera y escribe cada `.cy.js` (uno por llamada) hasta que no queden pendientes.
2. `runE2ETests` (params: `rfFilter?`, `promptOverride?`) → el servidor **ejecuta Cypress** (limpiando el baseline entre intentos), reporta el estado de todos los RF y devuelve, para **UN** RF que falla, la **salida real de Cypress** + un **PROMPT DE CORRECCIÓN** ya construido.
3. El agente aplica ese prompt reescribiendo el fichero y **vuelve a llamar** a `runE2ETests`; recibirá el siguiente RF que falle.
4. Repetir hasta que `runE2ETests` reporte todos los RF en verde.

Así el servidor aporta la ejecución determinista y el feedback; el agente aporta la generación/corrección con su propio modelo. En clientes CON sampling no hace falta: `generateE2ETests` ya ejecuta e itera solo.

**Ejecución iterativa (auto-fix):** por defecto, tras generar la primera versión de cada spec, `generateE2ETests` **ejecuta Cypress** sobre ese fichero y, si algún `it()` falla, vuelve a pedir al modelo que **corrija el spec usando la salida de error real de Cypress**, repitiendo hasta que todos los tests pasen o se agoten los intentos. Parámetros de la tool:
- `runTests` (bool, por defecto `true`): ejecuta Cypress e itera. Ponlo a `false` para solo generar.
- `maxIterations` (número, por defecto `3`): intentos máximos por RF (1 generación + N-1 correcciones).
- `rfFilter` (array de ids, opcional): limita a ciertos RF, p. ej. `["RF-01","RF-03"]`.
- `promptOverride` (string, opcional).
Entre cada intento se limpian las claves de baseline del RF en curso para que la re-ejecución vuelva a autocapturar (evita falsos fallos por deriva del baseline). El comando de Cypress se puede personalizar con `e2eRunCommand` en `mcp.config.json` (por defecto `npx cypress run`). La tool devuelve un informe con qué RF pasan/fallan y, para los que fallan, un extracto de la salida de Cypress.

Para `autoCompleteRfCu`, la generación es **genérica y guiada por LLM** (no usa plantillas ni heurísticas de dominio):
- Los **RF** se infieren de los endpoints de OpenAPI + las rutas de `appRouting`.
- Los **CU** los **estima el modelo del cliente** analizando el código frontend real (componentes, plantillas, servicios), vía **MCP sampling** (`sampling/createMessage`).
- Requiere un cliente MCP que soporte sampling (p. ej. VS Code Copilot 1.102+). Sin sampling, la tool devuelve el prompt para que el agente del cliente genere y escriba `rf-cu.md` (modo asistido; ver arriba).
- El prompt de instrucciones está externalizado en `prompts/rfcu.md` (configurable con `prompts.rfcu` en `mcp.config.json`, opcional). Si no se indica, usa el `prompts/rfcu.md` del servidor MCP. (configurable con `prompts.rfcu` en `mcp.config.json`, opcional). Si no se indica, usa el `prompts/rfcu.md` del servidor MCP.
- Si ya existe un `rf-cu.md` parcial, se completa respetando lo ya definido.

La generación E2E incluye baseline autocapturable de snapshots genéricos (API/UI):
- asegura Cypress en el frontend (`devDependencies.cypress`) y scripts `e2e` / `e2e:open`
- asegura `cypress.config.js` y registra `registerBaselineTasks(on)` en `setupNodeEvents` (omite la inyección si tu config ya define las tareas `readBaseline`/`writeBaseline`, para no duplicarlas)
- usa `e2eBaseUrl` de `mcp.config.json` para `cy.visit(...)` en los specs generados
- crea `cypress/support/e2e-baseline.js`
- crea `cypress/fixtures/e2e-baseline.json`
- crea `cypress/support/baseline-tasks.js` con tareas `readBaseline` y `writeBaseline`
- crea `cypress/support/e2e-helpers.js`: librería compartida y agnóstica de dominio que todos los specs importan (`../support/e2e-helpers`). Incluye `normalizeAmount`, selectores de opciones robustos a controles custom (`resolveNativeSelect`/`getSelectOptions`/`selectFirstSelectableOption`/`selectRequiredOptionByTextOrValue`, que resuelven el `<select>` nativo aunque esté envuelto en un web component como `empresas-ui-dropdown`), `setInputValue`/`setNumericFieldValue`/`setValueByFormControl`, `dismissKnownOverlays`, `openAccordionByComponent` y `persistOrAssertBaseline`, para no reimplementar utilidades en cada test.

Antes de lanzar Cypress, es necesario ejecutar:

`set NO_PROXY=localhost,127.0.0.1,.aena.es`

Además, en la configuración de proxy del sistema, la IP/host del proxy debe ser:

`proxym.aena.es`

sin incluir `http://`.

En `cypress.config.js`, registra esas tareas desde `setupNodeEvents(on)`:
`const { registerBaselineTasks } = require('./cypress/support/baseline-tasks'); registerBaselineTasks(on);`

## Configuración en VS Code Copilot (MCP)

Configuración recomendada: por proyecto, en `.vscode/mcp.json` (no en configuración global de usuario).

En la raíz del proyecto que quieres documentar, crea `.vscode/mcp.json` con:

```json
{
    "servers": {
        "qa-mcp": {
            "type": "stdio",
            "command": "C:\\Program Files\\nodejs\\node.exe",
            "args": ["C:\\EnvAena\\workspace\\qa-mcp\\dist\\index.js"],
            "cwd": "${workspaceFolder}"
        }
    }
}
```

Y elimina `qa-mcp` de la configuración global (**MCP: Open User Configuration**) para evitar conflictos entre proyectos.

## Uso en un proyecto (guía rápida)

1. En el proyecto a documentar, crea/ajusta `mcp.config.json` en su raíz con rutas de backend, frontend, OpenAPI y salidas de tests/evidencias.
   - Si quieres controlar explícitamente de dónde derivar CU, añade `appRouting` con la ruta del `app-routing.module.ts`.
   - Para fijar la URL de ejecución E2E, añade `e2eBaseUrl` (ej. `https://mi-entorno.aena.es`).
2. En VS Code Copilot, configura y arranca el servidor MCP `qa-mcp` con `cwd` apuntando a ese proyecto.
3. En Copilot Chat (modo Agent), ejecuta las tools según necesidad:
   - `autoCompleteRfCu`: completa `rf-cu.md`. Infiere RF desde OpenAPI + `appRouting` y estima los CU con el LLM del cliente (MCP sampling) analizando el frontend.
   - `generateRestTests`: genera tests API (Rest Assured).
   - `generateE2ETests`: genera tests E2E (Cypress) y deja Cypress/baseline configurado en frontend.
   - `exportETPAsExcel` / `exportETPAsWord`: exportan el plan de pruebas con evidencias.
4. Revisa los artefactos generados en:
   - tests API: ruta configurada en `restTests`
   - tests E2E: ruta configurada en `e2eTests`
   - evidencias: carpeta configurada en `evidence.output`

Nota: las tools usan siempre `mcp.config.json` desde la raíz del proyecto en el que se ejecuta el MCP (`cwd`).
