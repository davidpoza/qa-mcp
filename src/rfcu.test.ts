import assert from "node:assert/strict";
import test from "node:test";
import {
  automationContractErrors,
  formatAutomationOperation,
  manualInstructions,
  parseRfCu,
  rfCuContractErrors,
  technicalActionInstruction,
  technicalInstruction,
  validateRfCuMarkdown,
} from "./rfcu";
import { CuAutomationOperation } from "./types";

const validDocument = `# Requisitos funcionales

1. **RF-2 — Datos operativos** (\`— (acción de UI, sin endpoint directo)\`, \`ui-datos\`).
- **CU-1: Introducción de datos válidos.**
  - **Acciones para ejecución manual:**
  1. Acceder al Simulador de facturas.
  2. Introducir 15000 en Peso de la aeronave, 120 en Número de pasajeros y 30 en Pasajeros en conexión.
  3. Comprobar que Importe total muestra el importe calculado.
  - **Contrato de automatización:**
    - \`A01.1\` | acción \`01\` | operación \`visit\` | etiqueta \`Simulador de facturas\` | destino \`/simulador\`
    - \`A02.1\` | acción \`02\` | operación \`set-control\` | clave \`pesoAeronave\` | tipo \`input\` | etiqueta \`Peso de la aeronave\` | selector \`#pesoAeronave input\` | valor \`15000\`
    - \`A02.2\` | acción \`02\` | operación \`set-control\` | clave \`numPasajeros\` | tipo \`input\` | etiqueta \`Número de pasajeros\` | selector \`#numPasajeros input\` | valor \`120\`
    - \`A02.3\` | acción \`02\` | operación \`set-control\` | clave \`numPasajerosConexion\` | tipo \`input\` | etiqueta \`Pasajeros en conexión\` | selector \`#numPasajerosConexion input\` | valor \`30\`
    - \`A03.1\` | acción \`03\` | operación \`verify\` | etiqueta \`Importe total\` | selector \`#importeTotal\` | resultado \`muestra el importe calculado\`
`;

test("parsea acciones humanas agrupadas y operaciones técnicas atómicas", () => {
  const [rf] = parseRfCu(validDocument);
  const cu = rf.cases[0];

  assert.deepEqual(cu.steps, [
    "Acceder al Simulador de facturas.",
    "Introducir 15000 en Peso de la aeronave, 120 en Número de pasajeros y 30 en Pasajeros en conexión.",
    "Comprobar que Importe total muestra el importe calculado.",
  ]);
  assert.equal(cu.actions?.length, 3);
  assert.deepEqual(manualInstructions(cu), cu.steps);
  assert.equal(cu.actions?.[1].automation.length, 3);
  assert.deepEqual(
    cu.inputValues?.map((input) => [input.key, input.actionNumber]),
    [
      ["pesoAeronave", 2],
      ["numPasajeros", 2],
      ["numPasajerosConexion", 2],
    ]
  );
  assert.deepEqual(automationContractErrors(rf.id, cu), []);
});

test("acepta títulos de CU indentados dentro de la lista del RF", () => {
  const indented = validDocument.replace("\n- **CU-1", "\n   - **CU-1");
  const [rf] = parseRfCu(indented);
  assert.equal(rf.cases.length, 1);
  assert.deepEqual(rfCuContractErrors([rf]), []);
});

test("la instrucción Cypress se deriva de los campos estructurados", () => {
  const action = parseRfCu(validDocument)[0].cases[0].actions?.[1];
  const operation = action?.automation[0];
  assert.ok(action);
  assert.ok(operation);
  assert.equal(
    technicalInstruction(operation),
    'Ingresar el valor "15000" en #pesoAeronave input disparando los eventos input y change mediante setDocumentedControl.'
  );
  assert.equal(
    technicalActionInstruction(action),
    'Ingresar el valor "15000" en #pesoAeronave input, el valor "120" en #numPasajeros input y el valor "30" en #numPasajerosConexion input disparando los eventos input y change mediante setDocumentedControl.'
  );
});

test("rechaza selectores, componentes y rutas en instrucciones humanas", () => {
  const technicalManual = validDocument
    .replace(
      "Acceder al Simulador de facturas.",
      "Acceder a /simulador mediante app-simulador para ver simulador.titulo.principal."
    )
    .replace(
      "Introducir 15000 en Peso de la aeronave, 120 en Número de pasajeros y 30 en Pasajeros en conexión.",
      "Introducir 15000 en Peso de la aeronave usando #pesoAeronave input, 120 en Número de pasajeros y 30 en Pasajeros en conexión."
    );
  const [rf] = parseRfCu(technicalManual);
  const errors = automationContractErrors(rf.id, rf.cases[0]);

  assert.ok(errors.some((error) => /nombre de componente|ruta o URL técnica|clave interna o i18n/.test(error)));
  assert.ok(errors.some((error) => /selector CSS|tipo de control técnico/.test(error)));
});

test("rechaza identificadores internos aunque no lleven prefijo CSS", () => {
  const technicalManual = validDocument.replace(
    "Acceder al Simulador de facturas.",
    "Acceder a simulador.titulo mediante pesoAeronave."
  );
  const [rf] = parseRfCu(technicalManual);
  const errors = automationContractErrors(rf.id, rf.cases[0]);

  assert.ok(errors.some((error) => /clave interna o i18n|identificador interno/.test(error)));
});

test("rechaza acciones manuales sin operación técnica", () => {
  const withoutLastOperation = validDocument.replace(
    /^\s+- `A03\.1`[^\n]*\n/m,
    ""
  );
  const [rf] = parseRfCu(withoutLastOperation);
  const errors = automationContractErrors(rf.id, rf.cases[0]);
  assert.ok(errors.some((error) => /acción 03: no tiene ninguna operación/.test(error)));
});

test("rechaza divergencia de finalidad entre el verbo humano y la operación", () => {
  const divergent = validDocument.replace(
    "Introducir 15000 en Peso de la aeronave, 120 en Número de pasajeros y 30 en Pasajeros en conexión.",
    "Comprobar 15000 en Peso de la aeronave, 120 en Número de pasajeros y 30 en Pasajeros en conexión."
  );
  const [rf] = parseRfCu(divergent);
  const errors = automationContractErrors(rf.id, rf.cases[0]);
  assert.ok(errors.some((error) => /finalidad humana no corresponde.*set-control/.test(error)));
});

test("exige en la acción humana el valor literal de cada control", () => {
  const missingLiteral = validDocument.replace(
    "120 en Número de pasajeros",
    "un valor en Número de pasajeros"
  );
  const [rf] = parseRfCu(missingLiteral);
  const errors = automationContractErrors(rf.id, rf.cases[0]);

  assert.ok(errors.some((error) => /debe mencionar el valor humano `120`/.test(error)));
});

test("rechaza opciones, fechas y horas ambiguas", () => {
  const ambiguous = validDocument
    .replace(
      "120 en Número de pasajeros",
      "una opción disponible en Número de pasajeros"
    )
    .replace("valor `120`", "valor `una opción disponible`");
  const [rf] = parseRfCu(ambiguous);
  const errors = automationContractErrors(rf.id, rf.cases[0]);

  assert.ok(errors.some((error) => /instrucción humana usa un valor ambiguo/.test(error)));
  assert.ok(errors.some((error) => /declara el valor ambiguo `una opción disponible`/.test(error)));
});

test("conserva y rechaza operaciones que apuntan a acciones inexistentes", () => {
  const orphanOperation = validDocument.replace(
    /(`A03\.1` \| acción `)03(` \|)/,
    "$199$2"
  );
  const [rf] = parseRfCu(orphanOperation);
  const cu = rf.cases[0];
  const errors = automationContractErrors(rf.id, cu);

  assert.equal(cu.actions?.at(-1)?.id, "A99");
  assert.ok(errors.some((error) => /acciones manuales.*no tienen la misma longitud/.test(error)));
  assert.ok(errors.some((error) => /referencia la acción 99/.test(error)));
});

test("rechaza operaciones y tipos de control desconocidos sin abortar la validación", () => {
  const unsupported = validDocument
    .replace("operación `visit`", "operación `hover`")
    .replace("tipo `input`", "tipo `slider`");
  const [rf] = parseRfCu(unsupported);
  const errors = automationContractErrors(rf.id, rf.cases[0]);

  assert.ok(errors.some((error) => /operación no soportada hover/.test(error)));
  assert.ok(errors.some((error) => /tipo de control no soportado slider/.test(error)));
});

test("no ignora líneas técnicas mal formadas", () => {
  const malformed = validDocument.replace(
    "| clave `numPasajerosConexion` |",
    "| clave numPasajerosConexion |"
  );
  const [rf] = parseRfCu(malformed);
  const errors = automationContractErrors(rf.id, rf.cases[0]);

  assert.equal(rf.cases[0].automationParseErrors?.length, 1);
  assert.ok(errors.some((error) => /operación técnica mal formada/.test(error)));
});

test("el estado booleano de un checkbox permanece fuera de la acción humana", () => {
  const checkboxDocument = validDocument
    .replace(
      "Introducir 15000 en Peso de la aeronave, 120 en Número de pasajeros y 30 en Pasajeros en conexión.",
      "Marcar Acepto las condiciones."
    )
    .replace(
      /^    - `A02\.[123]`[^\n]*\n/gm,
      ""
    )
    .replace(
      /^    - `A03\.1`/m,
      "    - `A02.1` | acción `02` | operación `set-control` | clave `aceptaCondiciones` | tipo `checkbox` | etiqueta `Acepto las condiciones` | selector `#aceptaCondiciones input` | valor `true`\n    - `A03.1`"
    );
  const [rf] = parseRfCu(checkboxDocument);
  assert.deepEqual(automationContractErrors(rf.id, rf.cases[0]), []);
});

test("renderiza de forma estable una operación del contrato", () => {
  const operation: CuAutomationOperation = {
    id: "A02.1",
    actionNumber: 2,
    kind: "set-control",
    key: "pesoAeronave",
    controlType: "input",
    label: "Peso de la aeronave",
    selector: "#pesoAeronave input",
    value: "15000",
  };
  assert.equal(
    formatAutomationOperation(operation),
    "    - `A02.1` | acción `02` | operación `set-control` | clave `pesoAeronave` | tipo `input` | etiqueta `Peso de la aeronave` | selector `#pesoAeronave input` | valor `15000`"
  );
});

test("rechaza RF duplicados antes de persistir el documento", () => {
  assert.throws(
    () => validateRfCuMarkdown(`${validDocument}\n${validDocument}`),
    /RF duplicado: RF-2/
  );
});
