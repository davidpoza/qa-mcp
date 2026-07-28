# Prompt E2E (Cypress)

Objetivo:
- Crear escenarios E2E robustos y deterministas.
- Respetar el patrón de selectores e interacción usado actualmente.

Reglas obligatorias de implementación:
1) Estructura base
- Mantén constantes para URL y selectores reutilizables.
- Crea helpers reutilizables para:
  - Buscar/seleccionar opciones de <select> por texto o value.
  - Rellenar inputs numéricos disparando eventos de Angular.
  - Cerrar overlays/cookies conocidos.

2) Interacción con selects (CRÍTICO)
- Usar patrón de búsqueda de opción por texto/value (case-insensitive).
- Si el caso exige existencia: validar con expect(match).to.exist antes de seleccionar.
- Si el caso es opcional: usar variante “if present”.
- Seleccionar por value si existe; si no, por texto visible.

3) Interacción con inputs de texto y numéricos (CRÍTICO)
- Evitar depender solo de .type() en campos problemáticos.
- Usar patrón:
  - click({ force: true })
  - invoke('val', valor)
  - trigger('input', { force: true })
  - trigger('change', { force: true })
  - assert final: should('have.value', valor)
- Para horas/minutos usar clear/type con force cuando aplique.

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