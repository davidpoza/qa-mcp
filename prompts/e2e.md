# Prompt E2E (Cypress)

Objetivo:
- Crear escenarios E2E robustos y deterministas.
- Respetar el patrón de selectores e interacción usado actualmente.

Reglas obligatorias de implementación:
1) Estructura base
- Mantén constantes para URL y selectores reutilizables.
- Reutiliza los helpers compartidos de `cypress/support/e2e-helpers.js` para:
  - Buscar/seleccionar opciones de <select> por texto o value.
  - Rellenar inputs numéricos con eventos de la ventana de la aplicación.
  - Cerrar overlays/cookies conocidos.
- No declares copias locales de esos helpers dentro del spec.

2) Interacción con selects (CRÍTICO)
- Usar patrón de búsqueda de opción por texto/value (case-insensitive).
- Si el caso exige existencia: validar con expect(match).to.exist antes de seleccionar.
- Si el caso es opcional: usar variante “if present”.
- Seleccionar por value si existe; si no, por texto visible.

3) Interacción con controles que contienen datos de prueba (CRÍTICO)
- Cuando el CU declare `Valores de controles`, usar exclusivamente `setDocumentedControl(clave, tipo, selector, valor, captura)` con los cinco literales exactos. Sirve para `input`, `select` y `checkbox`: espera cualquier re-render, vuelve a localizar/desplazar el control, verifica y resalta el valor/estado real, y ejecuta la captura integrada. Sólo en documentos legacy se permiten los helpers separados de inputs/selects.
- PROHIBIDO reimplementar helpers locales de escritura o usar directamente `clear()`, `type()`, `invoke('val')` o `trigger('input'/'change')`: Cypress puede emitir eventos desde otra ventana, fallar `instanceof Event` en el componente Angular y guardar `[object Event]` como valor.
- El helper registra automáticamente cada input, opción visible o checkbox manipulado. `persistOrAssertBaseline` incorpora esos valores bajo `inputs`.
- El CU sólo puede quedar verde si el conjunto completo de claves/valores de `e2e-baseline.json` coincide exactamente con lo declarado en `rf-cu.md`.

4) Selectores
- **Deriva los selectores del código frontend proporcionado** (ids, atributos `data-*`, `formControlName`, `name`, textos de opciones/botones). No inventes selectores que no aparezcan en el código.
- Prioriza ids y atributos estables ya usados en las plantillas del proyecto.
- Evita selectores frágiles basados en estructura profunda innecesaria.

5) Sincronización y estabilidad
- Usar timeouts explícitos en lecturas de options/inputs cuando corresponda.
- Usar cy.intercept para llamadas clave y alias con cy.wait('@alias').
- Verificar request.url exacta o parámetros relevantes.
- Minimizar waits arbitrarios; preferir espera por red o por estado visible.

6) Asserts funcionales
- Verificar estado inicial (visibilidad/disabled).
- Verificar habilitación por datos obligatorios.
- Verificar resultados funcionales (desglose, totales, importes esperados).
- Incluir aserts de regresión sobre comportamiento crítico del flujo.

7) Convenciones de código
- Mantener describe/it en español.
- Código limpio, sin duplicación, extrayendo helpers.
- No introducir utilidades nuevas si ya existe helper equivalente.

8) Evidencias por acción (CRÍTICO)
- No agrupar varias interacciones en una acción: cada input, dropdown, checkbox, click o acordeón debe tener su propio paso y su propia captura. Para controles documentados, la captura ya está integrada en el quinto argumento de `setDocumentedControl`; no duplicarla con otro `cy.screenshot`.
- Antes de CUALQUIER interacción con un elemento de UI, llevarlo al viewport. Los helpers compartidos de inputs, selects, botones y acordeones ya lo hacen; para una interacción directa usar `scrollIntoViewForEvidence(selector)` o encadenar `.scrollIntoView(...).should('be.visible')` antes de actuar.
- Al expandir un acordeón, hacer scroll sobre su encabezado antes del click; `openAccordionByComponent` incorpora este comportamiento.
- Después de completar y verificar cada acción numerada del CU, llamar a `cy.screenshot()` con el nombre exacto indicado por el prompt de generación.
- Generar una captura documental por cada acción, en el mismo orden, cuando el estado visual ya sea estable y la imagen muestre inequívocamente el control/resultado afectado. La mera existencia del PNG no basta si el elemento probado queda fuera del viewport.
- Usar `{ capture: "viewport", overwrite: true }` y no añadir extensión: Cypress genera el PNG.
- El viewport configurado es 1920×1080 con factor de escala 1 (100 %); no llamar nunca a `cy.viewport()` ni modificar el zoom. `cy.viewport()` sólo cambia el tamaño lógico y no corrige el DPR físico de Electron.
- No agrupar las capturas al final del test ni eliminar estas llamadas durante una corrección.

Entrega esperada:
- Archivo .cy.js/.cy.ts listo para ejecutar.
- Nuevos casos alineados con RF/CU definidos en rf-cu.md.
- Si hay supuestos de datos de entorno (ej. MAD/AASA), declararlos como constantes.
- Cuando aplique validación de resultados:
  - Persistir baseline en `cypress/fixtures/e2e-baseline.json`.
  - Capturar snapshot genérico (datos API + representación UI: tablas, columnas, estados, totales, etc.).
  - En modo normal, comparar snapshot actual contra baseline (comparación profunda con tolerancia numérica).
  - Si falta una clave baseline, autocapturarla por defecto (`AUTO_CAPTURE_MISSING_BASELINE=true`) para que la primera ejecución no falle.
  - Para forzar error cuando falte baseline: `AUTO_CAPTURE_MISSING_BASELINE=false`.
