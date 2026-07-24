/**
 * Obsidian augments the DOM Element prototype with element-creation helpers
 * (`createEl`, `createDiv`, `empty`, …) that the plugin's UI code uses
 * everywhere. jsdom has none of them, so install equivalent shims before any
 * test runs. Guarded so node-environment test files (gunzip, stroke data)
 * can share the same setup file without a DOM present.
 */

interface DomElementInfo {
  cls?: string | string[];
  text?: string;
}

if (typeof Element !== 'undefined') {
  const proto = Element.prototype as any;

  proto.createEl = function (tag: string, o?: DomElementInfo) {
    const el = document.createElement(tag);
    if (o?.cls) {
      const classes = Array.isArray(o.cls) ? o.cls : [o.cls];
      el.classList.add(...classes);
    }
    if (o?.text !== undefined) el.textContent = o.text;
    this.appendChild(el);
    return el;
  };

  proto.createDiv = function (o?: DomElementInfo) {
    return this.createEl('div', o);
  };

  proto.createSpan = function (o?: DomElementInfo) {
    return this.createEl('span', o);
  };

  proto.empty = function () {
    while (this.firstChild) this.removeChild(this.firstChild);
  };

  proto.addClass = function (...classes: string[]) {
    this.classList.add(...classes);
  };

  proto.removeClass = function (...classes: string[]) {
    this.classList.remove(...classes);
  };

  proto.setText = function (text: string) {
    this.textContent = text;
  };
}

export {};
