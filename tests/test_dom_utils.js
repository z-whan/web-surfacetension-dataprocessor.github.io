const assert = require("assert");

class FakeNode {
  constructor(tagName, text) {
    this.tagName = tagName || "#text";
    this.nodeType = tagName ? 1 : 3;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.className = "";
    this.value = "";
    this.selected = false;
    this._textContent = text || "";
  }

  get firstChild() {
    return this.children[0] || null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  get textContent() {
    if (this.nodeType === 3) {
      return this._textContent;
    }
    return this._textContent + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this.children = [];
    this._textContent = String(value);
  }
}

globalThis.window = globalThis;
globalThis.Node = FakeNode;
globalThis.document = {
  createElement(tagName) {
    return new FakeNode(tagName);
  },
  createTextNode(text) {
    return new FakeNode(null, text);
  },
  querySelector(selector) {
    return selector === "#known" ? new FakeNode("div") : null;
  },
};

require("../assets/js/dom-utils.js");

const dom = globalThis.SurfaceLabDomUtils;
assert(dom, "SurfaceLabDomUtils should attach to globalThis");

const userText = "<img src=x onerror=alert(1)>";
const element = dom.el("div", {
  className: "message",
  text: userText,
  attrs: { "data-kind": "status", hidden: false, role: "status" },
});
assert.strictEqual(element.className, "message");
assert.strictEqual(element.textContent, userText);
assert.strictEqual(element.children.length, 0, "text option should not create HTML children");
assert.strictEqual(element.attributes["data-kind"], "status");
assert.strictEqual(element.attributes.role, "status");
assert.strictEqual(element.attributes.hidden, undefined);

const parent = dom.el("section", null, ["A", dom.el("strong", { text: "B" }), null]);
assert.strictEqual(parent.textContent, "AB");
dom.replaceChildren(parent, [dom.metricCard("Mean", "12.3")]);
assert.strictEqual(parent.children.length, 1);
assert.strictEqual(parent.textContent, "Mean12.3");

const select = dom.el("select");
dom.populateSelect(select, [
  { label: "One", value: "1" },
  { label: "Two", value: "2", selected: true },
]);
assert.strictEqual(select.children.length, 2);
assert.strictEqual(select.children[1].textContent, "Two");
assert.strictEqual(select.children[1].selected, true);

assert.strictEqual(dom.escapeHtml("<>&\"'"), "&lt;&gt;&amp;&quot;&#039;");
assert(dom.qs("#known"), "qs should delegate to document.querySelector");

console.log("dom utils tests passed");
