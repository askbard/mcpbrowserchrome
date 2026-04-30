// Smoke tests for the in-page helpers in browser-tools.js. These functions
// are serialized into the page via chrome.scripting.executeScript, so they
// must not close over any module state. We re-extract them here from the
// source and run them against a tiny DOM stub.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(here, "../extension/lib/tools/browser-tools.js"),
  "utf8"
);

// Pull out the four `function _foo() {...}` definitions verbatim and eval
// them so they reference their own `document`/`location`/`window` globals.
function extractFn(name) {
  const re = new RegExp(`function ${name}\\s*\\(([^)]*)\\)\\s*\\{`);
  const m = src.match(re);
  if (!m) throw new Error(`could not find ${name}`);
  const start = m.index;
  // walk braces
  let depth = 0;
  let i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        const body = src.slice(start, i + 1);
        return new Function(`return (${body})`)();
      }
    }
  }
  throw new Error("brace mismatch");
}

let pass = 0,
  fail = 0;
const ok = (c, l) => {
  console.log((c ? "  ok  -" : "  FAIL -") + " " + l);
  c ? pass++ : fail++;
};

// Build a minimal DOM
class El {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.children = children;
    this.id = attrs.id || "";
    this.className = attrs.class || "";
    this.innerText = attrs.text || "";
    this._listeners = {};
    this.value = attrs.value;
    this._removed = false;
    this.parentNode = null;
    for (const c of children) c.parentNode = this;
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  closest(sel) {
    let cur = this;
    while (cur) {
      if (cur.tagName.toLowerCase() === sel) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  scrollIntoView() {}
  click() {
    this._clicked = true;
  }
  focus() {
    this._focused = true;
  }
  dispatchEvent(e) {
    (this._listeners[e.type] || []).forEach((f) => f(e));
  }
  addEventListener(t, f) {
    (this._listeners[t] = this._listeners[t] || []).push(f);
  }
  remove() {
    this._removed = true;
  }
  querySelectorAll(sel) {
    return select(this, sel);
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  requestSubmit() {
    this._submitted = true;
  }
  submit() {
    this._submitted = true;
  }
  get outerHTML() {
    return `<${this.tagName.toLowerCase()}>${this.innerText}</${this.tagName.toLowerCase()}>`;
  }
}
function select(root, sel) {
  // Tiny selector engine: tag, '#id', '.class', or 'tag.class', plus ','-list
  const out = [];
  const parts = sel.split(",").map((s) => s.trim());
  function walk(node) {
    for (const p of parts) {
      if (matches(node, p)) {
        out.push(node);
        break;
      }
    }
    for (const c of node.children) walk(c);
  }
  for (const c of root.children) walk(c);
  return out;
}
function matches(el, sel) {
  if (sel === "body") return el.tagName === "BODY";
  if (sel.startsWith("#")) return el.id === sel.slice(1);
  if (sel.startsWith(".")) return (el.className || "").split(" ").includes(sel.slice(1));
  // tag + optional class
  const m = sel.match(/^([a-z]+)(?:\.([a-z0-9_-]+))?$/i);
  if (!m) return false;
  if (el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
  if (m[2] && !(el.className || "").split(" ").includes(m[2])) return false;
  return true;
}

const input = new El("input", { id: "q", type: "text", name: "q", placeholder: "search" });
const button = new El("button", { class: "go", text: "Go" });
const form = new El("form", {}, [input, button]);
const body = new El("body", {}, [
  new El("h1", { text: "Hello world" }),
  form
]);
const html = new El("html", {}, [body]);
html.body = body;

globalThis.document = {
  body,
  documentElement: html,
  title: "Page Title",
  cloneNode() {
    return html;
  },
  querySelectorAll: (sel) => select(html, sel),
  querySelector: (sel) => select(html, sel)[0] || null,
  getElementById(id) {
    return select(html, "#" + id)[0] || null;
  }
};
globalThis.location = { href: "https://example.test/" };
globalThis.window = {
  scrollY: 0,
  innerHeight: 800,
  scrollBy({ top }) {
    this.scrollY += top;
  }
};
globalThis.HTMLInputElement = function () {};
HTMLInputElement.prototype = {};
globalThis.HTMLTextAreaElement = function () {};
HTMLTextAreaElement.prototype = {};
globalThis.Event = class {
  constructor(t) {
    this.type = t;
  }
};
globalThis.KeyboardEvent = class {
  constructor(t) {
    this.type = t;
  }
};

// Extract functions from source and run them
const _readability = extractFn("_readability");
const _querySnapshot = extractFn("_querySnapshot");
const _click = extractFn("_click");
const _type = extractFn("_type");
const _scroll = extractFn("_scroll");

console.log("\n_readability");
const page = _readability();
ok(page.url === "https://example.test/", "captures location");
ok(page.title === "Page Title", "captures title");
ok(typeof page.html_length === "number", "html_length numeric");

console.log("\n_querySnapshot");
const snap = _querySnapshot("button.go", 5);
ok(snap.length === 1, "matched one button");
ok(snap[0].tag === "button", "tag captured");

console.log("\n_click");
const clickRes = _click("button.go", 0);
ok(button._clicked === true, "click() invoked on element");
ok(clickRes.clicked === "button", "returns clicked tag");

console.log("\n_type");
// _type uses the Object.getOwnPropertyDescriptor(...).set path; to avoid
// jumping through hoops in the stub we just verify it falls back to direct
// assignment without throwing.
try {
  _type("#q", "claude code", true);
  ok(input.value === "claude code", "input value set");
  ok(form._submitted === true, "form was submitted");
} catch (e) {
  ok(false, "_type threw: " + e.message);
}

console.log("\n_scroll");
const sres = _scroll("down", 500);
ok(sres.scrollY === 500, "scrolled down 500");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
