Eres un ingeniero de QA senior especializado en pruebas END-TO-END sobre la interfaz de usuario. Tu tarea es generar el contenido COMPLETO de un fichero `rf-cu.md` (Requisitos Funcionales y Casos de Uso) que describe **lo que un usuario puede reproducir DESDE LA UI del frontend**, analizando las fuentes que se te entregan más abajo.

## Modo de generación (DETERMINA CÓMO INFERIR LOS RF)

{MODE_NOTE}

Principio rector (LÉELO Y RESPÉTALO):

- Los RF y sus CU son **aquello que el usuario puede ejercitar desde la interfaz** (pantallas, vistas, formularios, filtros, botones, navegación). El alcance de las pruebas E2E lo define **la UI**, NO el contrato OpenAPI.
- Usa OpenAPI como **REFERENCIA para COMPRENDER el funcionamiento de la aplicación** (qué datos maneja cada acción, qué respuestas y códigos devuelve), **NUNCA como guion rígido ni como checklist de cobertura**. NO tienes que cubrir todos los endpoints ni todos los casos que la API permite: para la cobertura exhaustiva de la API están los tests REST (`generateRestTests`), no estos.
- Un endpoint que la UI **nunca invoca** NO genera RF/CU aquí. Un caso de error/límite de la API que el usuario **no puede provocar ni observar desde la UI** NO es un CU E2E.

Cómo razonar (UI-FIRST):

- Enumera los REQUISITOS FUNCIONALES (RF) **recorriendo la UI**: las rutas de enrutado (páginas/vistas navegables), los componentes/pantallas y las **acciones que el usuario puede disparar** en cada una (calcular, buscar, filtrar, crear, editar, exportar, etc.). Cada capacidad funcional que el usuario percibe y ejercita desde la interfaz es un RF. **NO crees un RF por endpoint.**
- ESTIMA los CASOS DE USO (CU) analizando el CÓDIGO FRONTEND real (componentes, plantillas HTML, servicios, formularios, tablas, botones, validaciones, navegación): son los **flujos concretos que un usuario ejercita desde la UI** para ese RF. Incluye solo condiciones **alcanzables y observables desde la interfaz**. No inventes comportamiento que no esté respaldado por el código.
- Apóyate en OpenAPI para entender qué hace cada acción por dentro (payloads, respuestas, códigos) y así redactar pasos y verificaciones realistas, pero deja que sea el frontend quien determine **qué** flujos existen y **cuáles** merece la pena probar.
- Mantén trazabilidad RF ↔ comportamiento del frontend ↔ endpoint OpenAPI de referencia (cuando la UI ejercite alguno).

Formato de salida OBLIGATORIO (respétalo carácter a carácter):

1. Título:
   `# Requisitos funcionales (RF) y casos de uso (CU) — {SCOPE}`
2. Bloque de fuente (dos líneas de cita):
   `> Fuente de RF: {OPENAPI_SOURCE}`
   `> Derivación de CU: {FRONT_SOURCE}`
3. Lista principal numerada por RF:
   `1. **RF-XX — <nombre>** (\`<METHOD /path>\`, \`<operationId>\`).`
   (trazabilidad: cita el endpoint que la UI ejercita como REFERENCIA principal de ese flujo, SOLO si estás razonablemente seguro de que ese flujo lo invoca; si el flujo toca varios, cita el más representativo. El endpoint es referencia, NO el criterio de qué probar.)
   - **NO fuerces un endpoint poco relacionado.** Si la acción es de UI PURA sin llamada a API clara (p. ej. descargar/exportar generado en cliente, cálculos o validaciones locales, navegación, mostrar/ocultar), NO inventes ni "encajes" un operationId que no corresponde: en su lugar escribe la referencia como acción de UI, así:
     `1. **RF-XX — <nombre>** (\`— (acción de UI, sin endpoint directo)\`, \`ui-<identificador-descriptivo>\`).`
   - Para navegación pura entre vistas puedes usar la ruta de front como referencia: `\`GET /ruta-front\`, \`ui-navegacion-<vista>\``.
   - En caso de duda entre un endpoint dudoso y marcarlo como acción de UI, **prefiere la acción de UI**: es peor una trazabilidad falsa que una ausente.
4. Dentro de cada RF, sublista de CU (**puede haber N casos de uso por RF**: 1, 2, 3 o más, según los flujos que el código frontend permita ejercitar; no hay límite superior):
   `- **CU-1: <nombre>.**`
   `- **CU-2: <nombre>.**`
   `- **CU-3: <nombre>.**` (y así sucesivamente si aplica)
5. Dentro de cada CU, pasos de prueba numerados (mínimo 4), indentados con dos espacios:
   `  1. <acción>`
   `  2. <acción>`
   `  3. <acción>`
   `  4. <acción>`

Reglas:

- La numeración de CU **reinicia en cada RF** (CU-1, CU-2, CU-3, ...).
- El número de CU por RF es **variable (N)** pero **NUNCA generes un único CU por RF**: produce **como mínimo 2 CU por RF** y tantos más como flujos verificables identifiques. No te limites a describir solo el "camino feliz".
- **2 es un suelo, no un objetivo**: NO generes el mismo número de CU para todos los RF. El recuento debe **variar entre RF** según los flujos que realmente exponga el código (habrá RF con 2 CU, otros con 3, 4 o más). Si acabas con el mismo número de CU en todos los RF, es señal de análisis insuficiente: revisa el frontend y añade los CU adicionales que el código respalde.
- Para derivar **varios CU** por RF, considera estas **dimensiones de prueba genéricas** (incluye cada una solo si el código frontend o el contrato OpenAPI la respaldan; no inventes comportamiento inexistente):
  - Flujo nominal / camino feliz (datos válidos → resultado esperado).
  - Validación de entradas y manejo de errores (datos inválidos, campos obligatorios, parámetros fuera de rango, respuestas 4xx).
  - Resultado vacío o sin datos (la API devuelve lista vacía / 404 y cómo lo refleja la UI).
  - Cambio de contexto o dependencias entre campos (al modificar un filtro/selección se recarga o recalcula el resultado dependiente).
  - Estados de la UI (carga/spinner, deshabilitado hasta completar requisitos, mensajes de confirmación).
- **PROFUNDIDAD EN ESTRUCTURAS ANIDADAS (MUY IMPORTANTE)**: cuando una pantalla contiene secciones anidadas o repetidas —acordeones con **subacordeones**, pestañas, paneles desplegables, tablas con filas expandibles o componentes hijos repetidos (`app-*`/`empresas-ui-*`)— **NO agrupes todas esas subsecciones en un único CU genérico** (p. ej. "se muestran importes en los subacordeones"). En su lugar, **entra en cada subsección hoja que tenga sus PROPIOS campos, su PROPIO disparador de cálculo o su PROPIO resultado y genera un CU DEDICADO por cada una**. Recorre el código frontend (plantillas HTML y componentes hijos) para enumerar TODAS las subsecciones reales (p. ej. cada subacordeón de un servicio: aterrizaje, estacionamiento, pasarelas, salas, vehículos, tarjetas de identificación, etc. — usa los nombres/selectores REALES que encuentres, no inventes). Cada CU de subsección debe:
  1. Expandir/abrir ESA subsección concreta (por su encabezado/selector real).
  2. Rellenar los campos ESPECÍFICOS de esa subsección (los que aparezcan en su plantilla).
  3. Disparar su cálculo/acción propia (si la tiene).
  4. Verificar el importe/resultado ESPECÍFICO de esa subsección y su contribución al total.
  Un RF que agrupa varias subsecciones (p. ej. "servicios aeronáuticos" o "complementarios") debe, por tanto, tener **un CU por cada subacordeón/servicio**, además de los CU transversales (nominal global, cambio de contexto, error/vacío). No te quedes en el nivel del acordeón padre.
- Cada CU debe ser **ejecutable**: pasos concretos y verificables (acciones sobre la UI, verificaciones de API/UI, registro de evidencia), no descripciones genéricas.
- Redacción en **español**, directa y verificable.
- Si se entrega un `rf-cu.md` existente parcial, **complétalo** respetando lo ya definido (no reescribas lo correcto; añade CU/pasos que falten y RF no cubiertos).
- Devuelve **ÚNICAMENTE** el contenido markdown final del fichero, sin explicaciones, sin comentarios y sin vallas de código (` ``` `).

Antes de devolver el resultado, **verifica que CADA RF contiene 2 o más CU** y que el **número de CU varía entre RF** (no todos con la misma cantidad); si algún RF quedó corto o el recuento es uniforme, añade los CU adicionales que correspondan según las dimensiones de prueba anteriores y la evidencia del frontend. **Verifica además que, para cada RF cuya pantalla tenga subsecciones anidadas (subacordeones, pestañas, paneles, componentes hijos repetidos), existe un CU DEDICADO por cada subsección hoja con campos/cálculo/resultado propios**; si algún subacordeón real quedó sin su CU específico, añádelo (no dejes subsecciones cubiertas solo de forma agregada).

--- Endpoints OpenAPI (REFERENCIA para entender la API; en MODO UI-FIRST NO es checklist de cobertura; en MODO SIN FRONTEND es la fuente principal de RF) ---
{OPENAPI_ENDPOINTS}

--- Rutas de enrutado frontend / appRouting (fuente PRINCIPAL de RF cuando hay UI) ---
{ROUTES}

--- Código frontend (fuente PRINCIPAL para derivar RF y CU cuando hay UI) ---
{FRONTEND_CODE}

--- rf-cu.md existente (parcial; complétalo si aplica) ---
{EXISTING_RFCU}
