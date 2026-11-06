'use strict';
// A configurable stand-in for the `vscode` module and its webview surfaces. Every fake records what
// the extension did with it in `vscode.fake` so tests can drive views only through public flows.
const Module = require('node:module');

function createEvent() {
  const listeners = new Set();
  const event = (listener) => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  };
  event.fire = (...args) => [...listeners].map((listener) => listener(...args));
  return event;
}

class FakeWebview {
  constructor(journal) {
    this.journal = journal;
    this.currentHtml = '';
    this.htmlHistory = [];
    this.htmlWaiters = [];
    this.options = undefined;
    this.messages = [];
    // Returns what postMessage resolves to: true, false, an Error to reject with, or a Promise.
    this.delivery = () => true;
    this.onDidReceiveMessage = createEvent();
  }

  get html() {
    return this.currentHtml;
  }

  set html(value) {
    this.currentHtml = value;
    this.htmlHistory.push(value);
    for (const resolve of this.htmlWaiters.splice(0)) resolve(value);
  }

  // Resolves with the next document the extension assigns, for example after a reload.
  nextHtml() {
    return new Promise((resolve) => this.htmlWaiters.push(resolve));
  }

  postMessage(message) {
    this.messages.push(message);
    this.journal.push({ type: 'post', target: this.owner, message });
    const outcome = this.delivery(message);
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve(outcome);
  }

  // Delivers a message as if the webview frontend had sent it, resolving when its handlers finish.
  receive(message) {
    return Promise.all(this.onDidReceiveMessage.fire(message)).then(() => undefined);
  }
}

class FakeWebviewSurface {
  constructor(journal, { visible = true, active = false } = {}) {
    this.journal = journal;
    this.webview = new FakeWebview(journal);
    this.webview.owner = this;
    this.visible = visible;
    this.active = active;
    this.disposed = false;
    this.onDidDispose = createEvent();
  }

  get messages() {
    return this.webview.messages;
  }

  receive(message) {
    return this.webview.receive(message);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.journal.push({ type: 'dispose', target: this });
    this.onDidDispose.fire();
  }
}

class FakeWebviewView extends FakeWebviewSurface {
  constructor(journal, options) {
    super(journal, options);
    this.onDidChangeVisibility = createEvent();
  }

  setVisible(visible) {
    this.visible = visible;
    this.onDidChangeVisibility.fire();
  }

  show() {
    this.journal.push({ type: 'show', target: this });
  }
}

class FakeWebviewPanel extends FakeWebviewSurface {
  constructor(journal, { viewType = 'sysmonitor.editor', title = '', column, options, ...state } = {}) {
    super(journal, state);
    Object.assign(this, { viewType, title, column });
    this.webview.options = options;
    this.iconPath = undefined;
    this.onDidChangeViewState = createEvent();
  }

  setState({ visible = this.visible, active = this.active } = {}) {
    this.visible = visible;
    this.active = active;
    this.onDidChangeViewState.fire({ webviewPanel: this });
  }

  reveal(...args) {
    this.journal.push({ type: 'reveal', target: this, args });
  }
}

// A VS Code Memento (workspaceState / globalState). `failUpdate` makes every write reject.
function createMemento(values = {}, { failUpdate = null } = {}) {
  const store = new Map(Object.entries(values));
  return {
    writes: [],
    get(key, fallback) {
      return store.has(key) ? store.get(key) : fallback;
    },
    async update(key, value) {
      this.writes.push([key, value]);
      if (failUpdate) throw failUpdate;
      store.set(key, value);
    },
  };
}

function lookup(handlers, name) {
  return handlers && Object.hasOwn(handlers, name) ? handlers[name] : null;
}

// Options: language, remoteName, settings ({ section: { key: value } }), commands ({ id: handler }),
// onSettingUpdate(section, key, value, target) to observe or reject writes, and window handlers
// showWarningMessage / showErrorMessage / showQuickPick returning the user's choice.
function createFakeVscode({ language = 'en', remoteName, settings = {}, commands = {}, onSettingUpdate = null, window: windowHandlers = {} } = {}) {
  const journal = [];
  const fake = {
    journal,
    contexts: new Map(),
    executed: [],
    registeredCommands: new Map(),
    viewProviders: new Map(),
    serializers: new Map(),
    panels: [],
    terminals: [],
    statusBarItems: [],
    output: [],
    warnings: [],
    errors: [],
    quickPicks: [],
    externalLinks: [],
    clipboard: [],
    settings: structuredClone(settings),
    settingWrites: [],
    createView: (options) => new FakeWebviewView(journal, options),
    createPanel: (options) => new FakeWebviewPanel(journal, options),
  };
  const sectionValues = (section) => {
    if (!Object.hasOwn(fake.settings, section)) fake.settings[section] = {};
    return fake.settings[section];
  };
  const message = (list, handler) => async (text, ...items) => {
    list.push([text, ...items]);
    return handler ? handler(text, ...items) : undefined;
  };
  const vscode = {
    fake,
    ExtensionKind: { UI: 1, Workspace: 2 },
    ViewColumn: { Active: -1, Beside: -2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    Uri: {
      file: (file) => file,
      parse: (value) => value,
      from: (parts) => parts,
    },
    env: {
      language,
      remoteName,
      clipboard: {
        async writeText(text) {
          fake.clipboard.push(text);
        },
      },
      async openExternal(uri) {
        fake.externalLinks.push(uri);
        return true;
      },
    },
    commands: {
      async executeCommand(command, ...args) {
        journal.push({ type: 'command', command, args });
        if (command === 'setContext') {
          fake.contexts.set(args[0], args[1]);
          return undefined;
        }
        fake.executed.push([command, ...args]);
        const handler = lookup(commands, command);
        return handler ? handler(...args) : undefined;
      },
      registerCommand(id, callback) {
        fake.registeredCommands.set(id, callback);
        return { dispose: () => fake.registeredCommands.delete(id) };
      },
    },
    window: {
      createWebviewPanel(viewType, title, column, options) {
        const panel = new FakeWebviewPanel(journal, { viewType, title, column, options, active: true });
        fake.panels.push(panel);
        return panel;
      },
      registerWebviewViewProvider(id, provider, options) {
        fake.viewProviders.set(id, { provider, options });
        return { dispose() {} };
      },
      registerWebviewPanelSerializer(id, serializer) {
        fake.serializers.set(id, serializer);
        return { dispose() {} };
      },
      createTerminal(options) {
        const terminal = {
          options, shown: false,
          show() {
            this.shown = true;
          },
        };
        fake.terminals.push(terminal);
        return terminal;
      },
      createOutputChannel(name) {
        return { name, appendLine: (line) => fake.output.push(line), dispose() {} };
      },
      createStatusBarItem(alignment, priority) {
        const item = {
          alignment, priority, text: '', visible: false, disposed: false,
          show() {
            this.visible = true;
          },
          hide() {
            this.visible = false;
          },
          dispose() {
            this.disposed = true;
          },
        };
        fake.statusBarItems.push(item);
        return item;
      },
      showWarningMessage: message(fake.warnings, windowHandlers.showWarningMessage),
      showErrorMessage: message(fake.errors, windowHandlers.showErrorMessage),
      async showQuickPick(items, options) {
        fake.quickPicks.push([items, options]);
        return windowHandlers.showQuickPick ? windowHandlers.showQuickPick(items, options) : undefined;
      },
    },
    workspace: {
      workspaceFolders: undefined,
      onDidChangeConfiguration: createEvent(),
      getConfiguration(section) {
        return {
          get(key, fallback) {
            const values = sectionValues(section);
            return Object.hasOwn(values, key) ? structuredClone(values[key]) : fallback;
          },
          inspect(key) {
            const values = sectionValues(section);
            return { key: `${section}.${key}`, globalValue: Object.hasOwn(values, key) ? structuredClone(values[key]) : undefined };
          },
          async update(key, value, target) {
            fake.settingWrites.push({ section, key, value, target });
            if (onSettingUpdate) await onSettingUpdate(section, key, value, target);
            sectionValues(section)[key] = structuredClone(value);
          },
        };
      },
    },
  };
  return vscode;
}

// Requires a module whose dependency graph imports `vscode`, resolving that import to the given fake.
function requireWithVscode(modulePath, vscode) {
  const load = Module._load;
  Module._load = function loadWithFakeVscode(request, ...rest) {
    return request === 'vscode' ? vscode : load.call(this, request, ...rest);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = load;
  }
}

module.exports = { createFakeVscode, createMemento, requireWithVscode };
