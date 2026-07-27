# QA MCP

Servidor MCP para automatizar generación de artefactos de QA:
- tests API con Rest Assured (`generateRestTests`)
- tests E2E con Cypress (`generateE2ETests`)
- documentación ETP en Excel (`exportETPAsExcel`) y Word (`exportETPAsWord`)
- autocompletado de `rf-cu.md` (`autoCompleteRfCu`)

Usa `mcp.config.json` en la raíz del proyecto para localizar OpenAPI, frontend, rutas de salida y plantillas.

Para `generateE2ETests`, puedes definir un prompt único en `prompts/e2e.md` (configurable con `prompts.e2e` en `mcp.config.json`).  
También puedes pasar `promptOverride` en la invocación de la tool para ajustar una ejecución puntual.

La generación E2E incluye baseline autocapturable de snapshots genéricos (API/UI):
- asegura Cypress en el frontend (`devDependencies.cypress`) y scripts `e2e` / `e2e:open`
- asegura `cypress.config.js` y registra `registerBaselineTasks(on)` en `setupNodeEvents`
- crea `cypress/support/e2e-baseline.js`
- crea `cypress/fixtures/e2e-baseline.json`
- crea `cypress/support/baseline-tasks.js` con tareas `readBaseline` y `writeBaseline`

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
2. En VS Code Copilot, configura y arranca el servidor MCP `qa-mcp` con `cwd` apuntando a ese proyecto.
3. En Copilot Chat (modo Agent), ejecuta las tools según necesidad:
   - `autoCompleteRfCu`: completa `rf-cu.md` si faltan CU o acciones.
   - `generateRestTests`: genera tests API (Rest Assured).
   - `generateE2ETests`: genera tests E2E (Cypress) y deja Cypress/baseline configurado en frontend.
   - `exportETPAsExcel` / `exportETPAsWord`: exportan el plan de pruebas con evidencias.
4. Revisa los artefactos generados en:
   - tests API: ruta configurada en `restTests`
   - tests E2E: ruta configurada en `e2eTests`
   - evidencias: carpeta configurada en `evidence.output`

Nota: las tools usan siempre `mcp.config.json` desde la raíz del proyecto en el que se ejecuta el MCP (`cwd`).
