## Prompt RF/CU (plantilla externa)

Este archivo define la plantilla base que usa `autoCompleteRfCu` para generar los CU y pasos.
Puedes personalizar nombres y redacción manteniendo las claves.

CU1_NAME: Flujo nominal de {RF_NAME}
CU1_STEP1: Navegar a la ruta asociada ({ROUTES}) y preparar datos válidos.
CU1_STEP2: Ejecutar la operación principal vinculada a {METHOD_PATH}.
CU1_STEP3: Verificar respuesta API y datos mostrados en UI para el caso nominal.
CU1_STEP4: Registrar evidencia de trazabilidad endpoint ↔ UI.

CU2_NAME: Validaciones y errores de {RF_NAME}
CU2_STEP1: Preparar entradas inválidas o incompletas sobre el flujo asociado ({ROUTES}).
CU2_STEP2: Disparar la operación {METHOD_PATH} con datos inválidos.
CU2_STEP3: Verificar mensajes de error y restricciones funcionales esperadas.
CU2_STEP4: Registrar evidencia del manejo de error sin persistencia incorrecta.

CU3_NAME: Consistencia API ↔ UI de {RF_NAME}
CU3_STEP1: Ejecutar {METHOD_PATH} y capturar los datos clave de la respuesta.
CU3_STEP2: Comparar los datos API con su representación en UI (tabla, totales, formato, estado).
CU3_STEP3: Confirmar consistencia considerando la evidencia de frontend: {FRONT_EVIDENCE}.
CU3_STEP4: Registrar evidencia final de correspondencia de datos.
