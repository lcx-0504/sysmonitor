'use strict';
// A small DOM stand-in for running webview rendering code in Node. Elements requested by id that the
// template would contain are created on first use; selectors support tag, #id, .class and [attribute]
// compounds joined by descendant spaces, which is all the webview modules query.

const LAYOUT_WIDTH = 400;

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  tokens() {
    return this.element.className.split(/\s+/).filter(Boolean);
  }

  add(...names) {
    const tokens = this.tokens();
    for (const name of names) if (!tokens.includes(name)) tokens.push(name);
    this.element.className = tokens.join(' ');
  }

  remove(...names) {
    this.element.className = this.tokens().filter((token) => !names.includes(token)).join(' ');
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.contains(name) : !!force;
    if (enabled) this.add(name);
    else this.remove(name);
    return enabled;
  }

  contains(name) {
    return this.tokens().includes(name);
  }
}

class FakeText {
  constructor(text) {
    this.textContent = String(text);
    this.parentNode = null;
  }

  cloneNode() {
    return new FakeText(this.textContent);
  }
}

function parseCompound(text) {
  const tag = text.match(/^[a-z][\w-]*/i);
  return {
    tag: tag ? tag[0].toUpperCase() : null,
    id: (text.match(/#([\w-]+)/) || [])[1] || null,
    classes: [...text.matchAll(/\.([\w-]+)/g)].map((match) => match[1]),
    attributes: [...text.matchAll(/\[([\w-]+)\]/g)].map((match) => match[1]),
  };
}

function matchesCompound(element, compound) {
  if (compound.tag && element.tagName !== compound.tag) return false;
  if (compound.id && element.id !== compound.id) return false;
  if (!compound.classes.every((name) => element.classList.contains(name))) return false;
  return compound.attributes.every((name) => element.getAttribute(name) !== null);
}

function matchesSelector(element, selector) {
  const parts = selector.trim().split(/\s+/).map(parseCompound);
  if (!matchesCompound(element, parts.at(-1))) return false;
  let ancestor = element.parentNode;
  for (let index = parts.length - 2; index >= 0; index--) {
    while (ancestor && !(ancestor instanceof FakeElement && matchesCompound(ancestor, parts[index]))) ancestor = ancestor.parentNode;
    if (!ancestor) return false;
    ancestor = ancestor.parentNode;
  }
  return true;
}

const datasetName = (attribute) => attribute.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

class FakeElement {
  constructor(document, tagName) {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.className = '';
    this.id = '';
    this.title = '';
    this.hidden = false;
    this.disabled = false;
    this.style = {};
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this.markup = null;
  }

  // Like HTMLCollection, the returned list stays live as children are added or removed.
  get children() {
    const element = this;
    return new Proxy([], {
      get(target, property) {
        const list = element.childNodes.filter((node) => node instanceof FakeElement);
        const value = Reflect.get(list, property);
        return typeof value === 'function' ? value.bind(list) : value;
      },
    });
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get lastChild() {
    return this.childNodes.at(-1) || null;
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    this.replaceChildren(...(value === '' || value === null || value === undefined ? [] : [String(value)]));
  }

  get innerHTML() {
    return this.markup === null ? this.textContent : this.markup;
  }

  set innerHTML(value) {
    this.replaceChildren();
    this.markup = String(value);
  }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument.documentElement;
  }

  get clientWidth() {
    return this.isConnected && !this.hidden ? LAYOUT_WIDTH : 0;
  }

  get scrollWidth() {
    return 0;
  }

  adopt(node) {
    const child = node instanceof FakeElement || node instanceof FakeText ? node : new FakeText(node);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.insertBefore(node, null);
  }

  insertBefore(node, reference) {
    const child = this.adopt(node);
    this.markup = null;
    const index = reference ? this.childNodes.indexOf(reference) : -1;
    if (index < 0) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    return child;
  }

  removeChild(node) {
    this.childNodes = this.childNodes.filter((child) => child !== node);
    node.parentNode = null;
    return node;
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.markup = null;
    this.append(...nodes);
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }

  setAttribute(name, value) {
    const text = String(value);
    if (name === 'class') this.className = text;
    else if (name === 'id') this.id = text;
    else if (name.startsWith('data-')) this.dataset[datasetName(name)] = text;
    else this.attributes.set(name, text);
  }

  getAttribute(name) {
    if (name === 'class') return this.className || null;
    if (name === 'id') return this.id || null;
    if (name.startsWith('data-')) return this.dataset[datasetName(name)] ?? null;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    if (name === 'title') this.title = '';
    else if (name.startsWith('data-')) delete this.dataset[datasetName(name)];
    else this.attributes.delete(name);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry !== listener));
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    return true;
  }

  click() {
    this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} });
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  getBoundingClientRect() {
    const width = this.clientWidth;
    return { left: 0, top: 0, right: width, bottom: 0, width, height: 0 };
  }

  getClientRects() {
    return this.isConnected && !this.hidden ? [this.getBoundingClientRect()] : [];
  }

  cloneNode(deep = false) {
    const copy = new FakeElement(this.ownerDocument, this.tagName);
    Object.assign(copy, { className: this.className, id: this.id, title: this.title, hidden: this.hidden, markup: this.markup });
    copy.style = { ...this.style };
    copy.dataset = { ...this.dataset };
    copy.attributes = new Map(this.attributes);
    if (deep) copy.append(...this.childNodes.map((node) => node.cloneNode(true)));
    return copy;
  }

  descendants() {
    return [...this.children].flatMap((child) => [child, ...child.descendants()]);
  }

  querySelectorAll(selector) {
    const selectors = selector.split(',');
    return this.descendants().filter((element) => selectors.some((part) => matchesSelector(element, part)));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    for (let node = this; node instanceof FakeElement; node = node.parentNode) if (matchesSelector(node, selector)) return node;
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement(this, 'html');
    this.body = new FakeElement(this, 'body');
    this.documentElement.append(this.body);
    this.listeners = new Map();
    this.activeElement = this.body;
    this.hidden = false;
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }

  createElementNS(_namespace, tagName) {
    return new FakeElement(this, tagName);
  }

  getElementById(id) {
    const found = this.documentElement.descendants().find((element) => element.id === id);
    if (found) return found;
    const created = this.createElement('div');
    created.id = id;
    this.body.append(created);
    return created;
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener() {}
}

// Installs document, window and animation frames as globals; returns the document and a frame runner.
function installFakeDom() {
  const document = new FakeDocument();
  const frames = [];
  const window = {
    innerWidth: LAYOUT_WIDTH * 2,
    innerHeight: LAYOUT_WIDTH * 2,
    addEventListener() {},
    removeEventListener() {},
  };
  Object.assign(globalThis, {
    document,
    window,
    requestAnimationFrame: (callback) => frames.push(callback),
    cancelAnimationFrame() {},
    getComputedStyle: () => ({ getPropertyValue: () => '', paddingLeft: '0', paddingRight: '0', borderLeftWidth: '0', borderRightWidth: '0', columnGap: '0' }),
  });
  return {
    document,
    runFrames() {
      for (const callback of frames.splice(0)) callback(0);
    },
  };
}

module.exports = { installFakeDom };
