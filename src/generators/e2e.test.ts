import assert from "node:assert/strict";
import test from "node:test";
import { buildE2EHelpersFile } from "./e2e";

type FakeRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type FakeElement = {
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  value: string;
  label: string;
  isConnected: boolean;
  parentElement: FakeElement | null;
  ownerDocument: FakeDocument;
  styleForTest: Record<string, string>;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): FakeRect;
  contains(other: FakeElement | null): boolean;
  querySelectorAll(selector: string): FakeElement[];
};

type FakeDocument = {
  body: FakeElement;
  defaultView: FakeWindow;
  elementFromPoint(x: number, y: number): FakeElement | null;
};

type FakeWindow = {
  innerWidth: number;
  innerHeight: number;
  getComputedStyle(element: FakeElement): Record<string, string>;
};

const visibleRect: FakeRect = {
  left: 100,
  top: 100,
  right: 300,
  bottom: 140,
  width: 200,
  height: 40
};

function makeElement(params: {
  tagName?: string;
  id?: string;
  className?: string;
  text?: string;
  value?: string;
  label?: string;
  attributes?: Record<string, string>;
  parent?: FakeElement | null;
  rect?: FakeRect;
  style?: Record<string, string>;
  query?: (selector: string) => FakeElement[];
} = {}): FakeElement {
  const attributes = { ...(params.attributes ?? {}) };
  const element = {
    tagName: (params.tagName ?? "div").toUpperCase(),
    id: params.id ?? "",
    className: params.className ?? "",
    textContent: params.text ?? "",
    value: params.value ?? "",
    label: params.label ?? "",
    isConnected: true,
    parentElement: params.parent ?? null,
    ownerDocument: undefined as unknown as FakeDocument,
    styleForTest: {
      display: "block",
      visibility: "visible",
      opacity: "1",
      position: "static",
      ...(params.style ?? {})
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
    getBoundingClientRect() {
      return params.rect ?? visibleRect;
    },
    contains(other: FakeElement | null) {
      let current = other;
      while (current) {
        if (current === element) return true;
        current = current.parentElement;
      }
      return false;
    },
    querySelectorAll(selector: string) {
      return params.query ? params.query(selector) : [];
    }
  } satisfies FakeElement;
  return element;
}

function connectDocument(
  body: FakeElement,
  elements: FakeElement[],
  elementFromPoint: (x: number, y: number) => FakeElement | null = () => null
): FakeDocument {
  const fakeWindow: FakeWindow = {
    innerWidth: 1920,
    innerHeight: 1080,
    getComputedStyle(element) {
      return element.styleForTest;
    }
  };
  const document: FakeDocument = {
    body,
    defaultView: fakeWindow,
    elementFromPoint
  };
  [body, ...elements].forEach((element) => {
    element.ownerDocument = document;
  });
  return document;
}

function loadOverlayInternals() {
  const source = buildE2EHelpersFile();
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} };
  const instrumented = `${source}\nmodule.exports.__overlayTest = {\n` +
    "  isConsentActionControl,\n" +
    "  findRecognizedConsentContainer,\n" +
    "  findConsentDismissControl,\n" +
    "  registerOverlayDismissSelectors,\n" +
    "  evidenceOcclusions,\n" +
    "  describeDomElement\n" +
    "};";
  const factory = new Function(
    "require",
    "module",
    "exports",
    "Cypress",
    "cy",
    "expect",
    instrumented
  );
  factory(
    () => ({ DEFAULT_NUMERIC_TOLERANCE: 0, compareBaselineRecord: () => undefined }),
    moduleObject,
    moduleObject.exports,
    { on: () => undefined, Promise },
    {},
    () => undefined
  );
  return {
    source,
    internals: moduleObject.exports.__overlayTest as {
      isConsentActionControl(element: FakeElement): boolean;
      findRecognizedConsentContainer(element: FakeElement, appWindow: FakeWindow): FakeElement | null;
      findConsentDismissControl(body: FakeElement, appWindow: FakeWindow): FakeElement | null;
      registerOverlayDismissSelectors(selectors: string | string[]): void;
      evidenceOcclusions(element: FakeElement): Array<{ name: string; element: FakeElement | null }>;
      describeDomElement(element: FakeElement | null): string;
    }
  };
}

test("el helper generado es JavaScript válido y nunca elimina el bloqueador", () => {
  const source = buildE2EHelpersFile();
  assert.doesNotThrow(() => new Function("require", "module", "exports", "Cypress", "cy", "expect", source));
  assert.doesNotMatch(source, /blocker\.remove\s*\(/);
  assert.doesNotMatch(source, /\.remove\s*\(\s*\)/);
  assert.match(source, /El helper no elimina elementos desconocidos/);
});

test("reconoce una acción de cookies dentro de un diálogo, pero no un botón de negocio", () => {
  const { internals } = loadOverlayInternals();
  const body = makeElement({ tagName: "body" });
  const consentDialog = makeElement({
    id: "privacy-dialog",
    text: "Utilizamos cookies para mejorar el servicio",
    attributes: { role: "dialog", "aria-modal": "true" },
    parent: body,
    style: { position: "fixed" }
  });
  const consentButton = makeElement({
    tagName: "button",
    text: "Aceptar todas",
    attributes: { "aria-label": "Aceptar todas" },
    parent: consentDialog
  });
  const appHeader = makeElement({ tagName: "header", text: "Operaciones", parent: body, style: { position: "fixed" } });
  const businessButton = makeElement({ tagName: "button", text: "Aceptar", parent: appHeader });
  const document = connectDocument(body, [consentDialog, consentButton, appHeader, businessButton]);

  assert.equal(internals.isConsentActionControl(consentButton), true);
  assert.equal(internals.findRecognizedConsentContainer(consentButton, document.defaultView), consentDialog);
  assert.equal(internals.findRecognizedConsentContainer(businessButton, document.defaultView), null);
});

test("descubre controles genéricos solo dentro de un contenedor de consentimiento", () => {
  const { internals } = loadOverlayInternals();
  const body = makeElement({ tagName: "body" });
  const consentDialog = makeElement({
    text: "Preferencias de privacidad y cookies",
    attributes: { role: "dialog" },
    parent: body,
    style: { position: "fixed" }
  });
  const consentButton = makeElement({ tagName: "button", text: "Rechazar todas", parent: consentDialog });
  const businessButton = makeElement({ tagName: "button", text: "Aceptar", parent: body });
  body.querySelectorAll = (selector) => selector.startsWith("button,") ? [businessButton, consentButton] : [];
  const document = connectDocument(body, [consentDialog, consentButton, businessButton]);

  assert.equal(internals.findConsentDismissControl(body, document.defaultView), consentButton);
});

test("un selector explícito permite adaptar un banner propio sin heurísticas", () => {
  const { internals } = loadOverlayInternals();
  const customButton = makeElement({ tagName: "button", text: "Cerrar aviso" });
  const body = makeElement({
    tagName: "body",
    query: (selector) => selector === ".qa-close-banner" ? [customButton] : []
  });
  customButton.parentElement = body;
  const document = connectDocument(body, [customButton]);

  internals.registerOverlayDismissSelectors(".qa-close-banner");
  assert.equal(internals.findConsentDismissControl(body, document.defaultView), customButton);
});

test("la oclusión se comprueba en el centro y en las cuatro esquinas interiores", () => {
  const { internals } = loadOverlayInternals();
  const body = makeElement({ tagName: "body" });
  const target = makeElement({ tagName: "select", id: "airport", parent: body });
  const targetChild = makeElement({ tagName: "option", parent: target });
  const blocker = makeElement({ tagName: "div", id: "sticky-footer", className: "layer active", parent: body });
  connectDocument(body, [target, targetChild, blocker], (x) => x < 150 ? blocker : targetChild);

  const occlusions = internals.evidenceOcclusions(target);
  assert.deepEqual(occlusions.map((hit) => hit.name), ["superior izquierdo", "inferior izquierdo"]);
  assert.equal(internals.describeDomElement(blocker), '<div#sticky-footer.layer.active>');
});
