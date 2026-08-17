# QA MCP

Servidor MCP para automatizar generación de artefactos de QA:
- tests API con Rest Assured (`generateRestTests`)
- tests E2E con Cypress (`generateE2ETests`) y ejecución/feedback (`runE2ETests`)
- documentación ETP en Excel (`exportETPAsExcel`) y Word (`exportETPAsWord`)
- autocompletado de `rf-cu.md` (`autoCompleteRfCu`)

Usa `mcp.config.json` en la raíz del proyecto para localizar OpenAPI, frontend, rutas de salida y plantillas.

Para `generateE2ETests`, la generación es **genérica y guiada por LLM** (MCP sampling): para cada CU, el modelo del cliente genera un spec Cypress **real** (con `cy.intercept`, interacción con selectores derivados del código frontend y aserciones), no un esqueleto de `cy.log`. **Cada CU se genera en su propio fichero `.cy.js`** (un `describe` del RF con un único `it` del CU), de modo que cada ejecución de Cypress corre solo ese CU y el bucle itera más rápido y de forma aislada. Antes de empezar, la tool consulta `.qa-mcp-e2e-status.json`: conserva y omite los CU cuyo spec existe y tiene `green: true`, genera los specs que faltan y ejecuta/repara los existentes que aún no están en verde.
- Puedes definir las reglas de estilo/interacción con `prompts.e2e` en `mcp.config.json` (opcional). Si no se indica, usa `prompts/e2e.md` del servidor MCP.
- También puedes pasar `promptOverride` en la invocación de la tool para ajustar una ejecución puntual.
- Requiere un cliente MCP que soporte sampling (p. ej. VS Code Copilot 1.102+). Si el cliente **no** soporta sampling (Roo Code, Cline, opencode…), la tool pasa a **modo asistido** (ver más abajo).

**Modo asistido (sin MCP sampling):** si el cliente conectado no declara la capacidad `sampling`, `generateE2ETests` y `autoCompleteRfCu` **no pueden pedir la generación al modelo por sí mismas**. En su lugar:
- `generateE2ETests` prepara el entorno Cypress (helpers, config y baseline) y trabaja con **UN CU no verde por llamada**. Si su spec no existe, devuelve el prompt de generación y la ruta de salida exacta; si ya existe, indica que debe ejecutarse con `runE2ETests` para validarlo o repararlo. En vez de embeber el código frontend (que desborda el contexto del cliente), el prompt **lista las rutas de los ficheros relevantes** para que el agente los abra con sus propias herramientas de fichero.
- `autoCompleteRfCu` **devuelve el prompt** y la ruta de salida para que el agente genere y escriba `rf-cu.md`.
- El modo asistido se activa **automáticamente** al detectar la falta de sampling. También puedes forzarlo con el parámetro `assisted: true` en la invocación.

> **Decenas de CU sin llamadas manuales:** sin MCP sampling, el servidor no puede generar por sí solo el contenido de los specs, por lo que técnicamente el flujo necesita varias llamadas MCP (`generateE2ETests` → escribir spec → `runE2ETests` → corregir/volver a ejecutar → siguiente CU). Esto **no significa que el usuario tenga que invocar manualmente la tool por cada CU**: si el cliente es un agente capaz de encadenar tools y editar ficheros, basta con darle **una única instrucción** para que complete el bucle entero. El agente hará internamente todas las llamadas necesarias y `.qa-mcp-e2e-status.json` conservará el progreso. Solo los clientes que tampoco puedan encadenar tools autónomamente requerirán llamadas manuales o un orquestador.

Prompt listo para dar al agente en un cliente sin sampling:

```text
Ejecuta el ciclo E2E completo hasta dejar todos los CU en verde. Llama a
generateE2ETests, escribe cada spec en la ruta exacta indicada y llama a
runE2ETests. Si falla, aplica el prompt de corrección y vuelve a ejecutar el
mismo CU hasta que pase. Continúa automáticamente con los siguientes CU hasta
que la tool indique que todos están en verde. No me pidas confirmación entre CU.
```

**Bucle de auto-corrección en modo asistido (`runE2ETests`), CU a CU hasta verde:** aunque el cliente no tenga sampling, el servidor **sí puede ejecutar Cypress** y devolver el resultado como feedback. El flujo trabaja **un CU en curso cada vez** (el primero que no está en verde) y **no avanza al siguiente hasta que el actual pasa**:
1. `generateE2ETests` (modo asistido) → devuelve el prompt de generación del **CU en curso** (si su `.cy.js` no existe). El agente lo escribe.
2. `runE2ETests` → el servidor **ejecuta SOLO ese CU** (limpiando el baseline entre intentos). Si pasa, lo **marca en verde** (estado persistido en disco) y te indica avanzar; si falla, devuelve la **salida real de Cypress** + un **PROMPT DE CORRECCIÓN**.
3. El agente aplica el prompt reescribiendo el fichero y **vuelve a llamar** a `runE2ETests` (mismo CU) hasta que pase.
4. Con el CU en verde, se llama de nuevo a `generateE2ETests` para el **siguiente** CU. Repetir hasta que todos estén en verde.

**Contexto limpio por CU:** todo el estado vive en **disco** (los `.cy.js` + `.qa-mcp-e2e-status.json` con los CU en verde), no en la conversación del cliente. Por eso el bucle es **reanudable desde una tarea nueva**: cuando el contexto del cliente empiece a llenarse, **inicia una tarea nueva** y vuelve a llamar a `generateE2ETests`; el servidor detecta el siguiente CU pendiente automáticamente y continúa desde ahí con contexto limpio. Cada llamada emite solo el CU en curso (frontend como lista de rutas, no código embebido) para minimizar el footprint.

**Automatizar el contexto limpio con subtasks (Roo Code / Orchestrator):** en clientes con orquestación de subtasks (Boomerang / Orchestrator, p. ej. **Roo Code**), no hace falta iniciar la tarea nueva a mano. Cada respuesta de `generateE2ETests` / `runE2ETests` incluye una **`SEÑAL DE SUBTASK`** con un campo `QUEDA_TRABAJO` (sí/no) y la instrucción de si seguir en el mismo subtask o delegar el siguiente paso en un `new_task` con contexto limpio. Como todo el estado está en disco, cada subtask arranca limpio y el servidor resuelve solo el CU pendiente.

> **Higiene de contexto en el bucle de corrección:** el contexto se llena sobre todo al **iterar correcciones dentro de un mismo CU** (cada vuelta reinyecta spec + salida de Cypress + reglas, y el agente reescribe el fichero entero). Por eso se delega **un subtask por CU** (contexto limpio para cada CU), y **dentro** de ese subtask el agente itera corrección→`runE2ETests` hasta que ESE CU pase. Si aun así el contexto de un CU muy largo se llena, hay un **offload OPCIONAL**: cierra la tarea y deja que una tarea/subtask NUEVA reanude EL MISMO CU (el `.cy.js` y el estado quedan en disco; el servidor reengancha el primer CU no verde). El offload es un alivio puntual, **no** un fin del bucle: nunca cierres un CU en rojo dándolo por terminado.

> **IMPORTANTE — modos de Roo y acceso MCP:** el modo **Orchestrator NO tiene acceso directo a tools MCP** (solo delega vía `new_task`); si le pides que llame a `autoCompleteRfCu`/`generateE2ETests` directamente, responderá que *"no es una tool reconocida"*. La llamada a la tool debe ocurrir **dentro del subtask**, en un modo con el grupo `mcp` **y** `edit`. Usa **modo Code** (`mode: "code"`) para los subtasks: como Roo no soporta sampling, las tools corren en modo asistido y el agente debe **escribir** los ficheros (`rf-cu.md`, `.cy.js`), así que hace falta editar. (Architect solo edita markdown; Ask no edita.)

Prompt listo para pegar en la **tarea padre** (Roo en modo Orchestrator):

```
Eres el orquestador del bucle E2E de qa-mcp. Objetivo: dejar TODOS los CU en verde.
Delega UN subtask por CU (contexto limpio por CU); el estado vive en disco y el
servidor reengancha el CU pendiente en cada subtask.

Repite este ciclo:
1. Crea un new_task EN MODO CODE (mode: "code") con contexto limpio y este objetivo
   (el modo Code es obligatorio: tiene acceso a las tools MCP y puede escribir ficheros;
   tú, como Orchestrator, NO puedes llamar a las tools qa-mcp directamente):
   "Deja EN VERDE el CU pendiente de qa-mcp (se resuelve solo desde disco):
    - Si no tiene spec: llama a generateE2ETests, escribe el .cy.js en la ruta EXACTA
      indicada y llama a runE2ETests.
    - Si ya tiene spec: llama a runE2ETests.
    Si FALLA, aplica el PROMPT DE CORRECCIÓN (reescribe el .cy.js completo) y VUELVE A
    LLAMAR a runE2ETests. Repite corrección→runE2ETests hasta que ESTE CU pase. NO cierres
    la tarea con el CU en rojo. (Solo si el contexto se te llena, puedes cerrar y dejar
    que otra tarea reanude ESTE MISMO CU desde disco.) Cuando pase, termina con
    attempt_completion indicando 'CU en verde' y copia la línea QUEDA_TRABAJO de la
    SEÑAL DE SUBTASK."
2. Cuando el subtask termine, lee su resultado (la línea QUEDA_TRABAJO).
3. Si QUEDA_TRABAJO: sí (siguiente CU), vuelve al paso 1.
4. Si QUEDA_TRABAJO: no (TODOS los CU en verde), termina.

No generes ni ejecutes tests tú mismo: delega SIEMPRE cada CU en un subtask en modo
Code con contexto limpio.
```

En clientes CON sampling no hace falta ni el bucle manual ni los subtasks: `generateE2ETests` reanuda el estado de `.qa-mcp-e2e-status.json`, genera lo que falta y ejecuta/repara los CU no verdes por sí misma.

**Ejecución iterativa (auto-fix):** por defecto, `generateE2ETests` **ejecuta Cypress** sobre cada CU pendiente. Si el spec no existe, primero lo genera; si ya existe pero no está verde, lo conserva y lo ejecuta directamente. Cuando falla, pide al modelo que **corrija el spec usando la salida de error real de Cypress**, repitiendo hasta que pase o se agoten los intentos. Cada resultado se persiste como `green: true/false` en `.qa-mcp-e2e-status.json`. Parámetros de la tool:
- `runTests` (bool, por defecto `true`): ejecuta Cypress e itera. Ponlo a `false` para solo generar.
- `maxIterations` (número, por defecto `3`): intentos máximos por CU (1 generación + N-1 correcciones).
- `rfFilter` (array de ids, opcional): limita a ciertos RF, p. ej. `["RF-01","RF-03"]`.
- `promptOverride` (string, opcional).
Entre cada intento se limpian las claves de baseline del CU en curso para que la re-ejecución vuelva a autocapturar (evita falsos fallos por deriva del baseline). El comando de Cypress se puede personalizar con `e2eRunCommand` en `mcp.config.json` (por defecto `npx cypress run`). La tool devuelve un informe acumulado y un extracto de la salida de Cypress para los CU que siguen fallando.

Para `autoCompleteRfCu`, la generación es **genérica y guiada por LLM** (no usa plantillas ni heurísticas de dominio) y es **UI-first**: los RF/CU describen **lo que el usuario puede reproducir DESDE LA UI**, no la API completa.
- **Con `frontend.root` configurado (modo UI-first):** los **RF** se derivan de lo que la UI expone (rutas de `appRouting`, componentes/pantallas y acciones que el usuario puede disparar) y los **CU** son los flujos concretos ejercitables desde la interfaz. OpenAPI se usa **solo como referencia** para entender el comportamiento, **no** como checklist de cobertura: no se crea un RF por endpoint ni se prueban casos que la UI no permite. La cobertura exhaustiva de la API es tarea de `generateRestTests`.
- **Sin `frontend.root` (modo fallback OpenAPI-first):** `frontend.root` es **opcional**; si no se define, no hay UI que analizar y los **RF se infieren directamente de los endpoints de OpenAPI** (un RF por operación/funcionalidad relevante), con CU a nivel de comportamiento esperado del endpoint.
- Los **CU** los **estima el modelo del cliente** analizando el código frontend real (componentes, plantillas, servicios), vía **MCP sampling** (`sampling/createMessage`).
- Requiere un cliente MCP que soporte sampling (p. ej. VS Code Copilot 1.102+). Sin sampling, la tool devuelve el prompt para que el agente del cliente genere y escriba `rf-cu.md` (modo asistido; ver arriba).
- El prompt de instrucciones está externalizado en `prompts/rfcu.md` (configurable con `prompts.rfcu` en `mcp.config.json`, opcional). Si no se indica, usa el `prompts/rfcu.md` del servidor MCP.
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
   - Para ejecutar Cypress con un Node concreto (p. ej. instalación nvm), añade `e2eNodePath` con el directorio que contiene `node.exe`/`npx` (por defecto `C:\Users\aena\AppData\Roaming\nvm\v24.16.0`); se antepone al `PATH` de la ejecución de Cypress.
   - Para pasar variables de entorno a la ejecución de Cypress (proxy, etc.), añade `e2eEnv` como objeto clave/valor. Por defecto se establece `NO_PROXY=localhost,127.0.0.1,.aena.es`; puedes sobreescribirlo o añadir más variables. Ej.: `"e2eEnv": { "NO_PROXY": "localhost,127.0.0.1,.aena.es", "HTTP_PROXY": "" }`.
   - Para **ver el navegador mientras Cypress ejecuta** (modo headed), añade `"e2eHeaded": true`: el runner del MCP añade `--headed`, así que ves cada spec en un navegador visible (se cierra al terminar; NO se usa `--no-exit` para no colgar la llamada MCP). Opcionalmente `"e2eBrowser": "chrome"` (o `edge`/`firefox`/`electron`) para elegir navegador — debe estar instalado; por defecto Electron.

   > **⚠️ Timeout MCP en Roo/Cline (`MCP error -32001: Request timed out`):** una corrida real de Cypress (arranque + navegador + tests) supera con facilidad el **timeout por defecto de 60 s** de las llamadas MCP. Sube el `timeout` del servidor `qa-mcp` en la config MCP del cliente (Roo permite hasta 3600 s; recomendado **600**). Es imprescindible además si la tool tiene que **reparar la caché de Cypress** (descarga del binario, ver abajo).

   > **⚠️ `Invalid or incompatible cached data (cachedDataRejected)` al lanzar Cypress:** es un **error de ENTORNO** (caché V8 del binario de Cypress corrupta/incompatible con la versión de Node), **no** del spec. `runE2ETests`/`generateE2ETests` lo **detectan y reparan automáticamente una vez** (`cypress cache clear` + `install` + `verify`) y reintentan; si persiste, devuelven un aviso claro (NO reescriben el test). Repara manualmente en el frontend, con el Node configurado en el PATH: `npx cypress cache clear && npx cypress install && npx cypress verify`. La reparación descarga el binario: asegura conectividad a `download.cypress.io` (revisa `NO_PROXY`) y **sube el timeout MCP** (arriba).

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
