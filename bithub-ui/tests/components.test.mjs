// components.test.mjs — testes leves dos primitivos de UI.
//
// `components.mjs` usa `document.createElement` — para evitar `jsdom`
// (zero-dep) montamos um stub minimalista compatível apenas com a fatia
// que `h()` toca.

import { describe, it, before } from "node:test";
import { strict as assert } from "node:assert";

class StubElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.textContent = "";
  }
  setAttribute(k, v) {
    this.attributes[k] = v;
  }
  addEventListener(event, fn) {
    (this.listeners[event] = this.listeners[event] || []).push(fn);
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

class StubTextNode {
  constructor(value) {
    this.nodeValue = String(value);
  }
}

const stubDocument = Object.freeze({
  createElement: (tag) => new StubElement(tag),
  createTextNode: (value) => new StubTextNode(value),
});

// Provide the stub before importing the module under test. The module reads
// `document` at call time, not at import time, so this works as long as the
// stub is in place before any `h()` call.
before(() => {
  if (typeof globalThis.document === "undefined") {
    globalThis.document = stubDocument;
  }
  // Node provides a global `Node` class with no shape we care about; the
  // `instanceof Node` check in components.mjs needs to match StubElement.
  globalThis.Node = StubElement;
});

const { h } = await import("../public/app/components.mjs");

describe("h() — DOM primitive", () => {
  it("creates element with class", () => {
    const el = h("div", { class: "card" });
    assert.equal(el.tagName, "DIV");
    assert.equal(el.attributes.class, "card");
  });

  it("appends text children safely via createTextNode", () => {
    const el = h("span", null, "hello", "world");
    assert.equal(el.children.length, 2);
    assert.equal(el.children[0].nodeValue, "hello");
    assert.equal(el.children[1].nodeValue, "world");
  });

  it("handles data-* and aria-* attribute normalization", () => {
    const el = h("button", { dataStatus: "ok", ariaPressed: "true" });
    assert.equal(el.attributes["data-status"], "ok");
    assert.equal(el.attributes["aria-pressed"], "true");
  });

  it("wires onClick as event listener", () => {
    let called = 0;
    const el = h("button", { onClick: () => { called += 1; } });
    assert.ok(el.listeners.click);
    el.listeners.click[0]();
    assert.equal(called, 1);
  });

  it("REJECTS prop 'html' — innerHTML path is closed", () => {
    // Defesa contra XSS: o ramo `html` que existia em UI-1 foi removido
    // em UI-2A. Qualquer caller que tente passar `html:` agora falha
    // ruidosamente, ao inves de injetar HTML cru silenciosamente.
    assert.throws(
      () => h("div", { html: "<img src=x onerror=alert(1)>" }),
      /prop 'html' is forbidden/
    );
  });

  it("REJECTS prop 'html' even when value is empty string", () => {
    assert.throws(() => h("div", { html: "" }), /prop 'html' is forbidden/);
  });
});
