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
- crea `cypress/support/e2e-baseline.js`
- crea `cypress/fixtures/e2e-baseline.json`
- crea `cypress/support/baseline-tasks.js` con tareas `readBaseline` y `writeBaseline`

En `cypress.config.js`, registra esas tareas desde `setupNodeEvents(on)`:
`const { registerBaselineTasks } = require('./cypress/support/baseline-tasks'); registerBaselineTasks(on);`

## Configuración en VS Code Copilot (MCP)

En VS Code, abre **MCP: Open User Configuration** y añade:

```json
{
    "servers": {
        "qa-mcp": {
            "type": "stdio",
            "command": "C:\\Program Files\\nodejs\\node.exe",
            "args": ["dist/index.js"],
            "cwd": "C:\\EnvAena\\workspace\\qa-mcp"
        }
    }
}
```
