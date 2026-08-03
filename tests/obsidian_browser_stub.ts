/**
 * Browser-safe stub of the 'obsidian' module for the COMPONENT harness bundle
 * (tests/component_harness.ts) — esbuild aliases 'obsidian' to this file (see
 * the build:e2e script). The harness runs inside a real Obsidian window, but
 * only as a Chromium host: no plugin is loaded there, so the 'obsidian'
 * module itself is not resolvable. This stub supplies just enough for the
 * plugin's modules to LOAD and for HanziPracticeView to render — Obsidian's
 * global DOM helpers (createEl/createDiv/empty) come from the real window.
 *
 * The jest suite has its own richer mock (tests/__mocks__/obsidian.ts); that
 * one depends on jest.fn() and cannot run in a page, hence this sibling.
 */

/** Obsidian's app version — main.ts reports it as telemetry baggage. */
export const apiVersion = '0.0.0-stub';

/** Every Notice text shown, for assertions from the runner. */
export const stubNoticeMessages: string[] = [];

export class Notice {
  constructor(public message: string) {
    stubNoticeMessages.push(message);
  }
}

export class App {}

export class WorkspaceLeaf {}

/**
 * Real implementation, not a jest.fn(): the UI click logger IS a Component,
 * and the tests assert that unloading it actually removes the listener.
 * Mirrors Obsidian's semantics — register() collects teardown callbacks,
 * unload() runs them once and is a no-op when not loaded.
 */
export class Component {
  private loaded = false;
  private cleanups: Array<() => unknown> = [];

  load() {
    if (this.loaded) return;
    this.loaded = true;
    this.onload();
  }

  unload() {
    if (!this.loaded) return;
    this.loaded = false;
    while (this.cleanups.length > 0) this.cleanups.pop()?.();
    this.onunload();
  }

  onload() {}
  onunload() {}

  register(cb: () => unknown) {
    this.cleanups.push(cb);
  }

  registerEvent() {}

  registerDomEvent(
    el: HTMLElement | Window | Document,
    type: string,
    callback: (event: Event) => unknown,
  ) {
    el.addEventListener(type, callback as EventListener);
    this.register(() =>
      el.removeEventListener(type, callback as EventListener),
    );
  }
}

export class ItemView {
  containerEl = document.createElement('div');

  constructor(public leaf: unknown) {
    // Obsidian's view container shape: children[0] = header, [1] = content.
    this.containerEl.appendChild(document.createElement('div'));
    this.containerEl.appendChild(document.createElement('div'));
  }

  getViewType() {
    return 'stub-view';
  }

  getDisplayText() {
    return 'Stub View';
  }

  registerDomEvent(
    el: HTMLElement | Window | Document,
    type: string,
    callback: (event: Event) => unknown,
  ) {
    el.addEventListener(type, callback as EventListener);
  }

  registerEvent() {}

  async setState() {}

  getState(): Record<string, unknown> {
    return {};
  }

  onOpen() {}
  onClose() {}
}

export class Plugin {
  app = new App();
  addSettingTab() {}
  addCommand() {}
  registerView() {}
  async loadData() {
    return null;
  }
  async saveData() {}
}

export class PluginSettingTab {
  containerEl = document.createElement('div');
  constructor(
    public app: App,
    public plugin: Plugin,
  ) {}
  display() {}
  hide() {}
}

export class Modal {
  contentEl = document.createElement('div');
  constructor(public app: App) {}
  open() {
    this.onOpen();
  }
  close() {
    this.onClose();
  }
  onOpen() {}
  onClose() {}
}

export class TFile {}

export class FileSystemAdapter {}

export function normalizePath(path: string): string {
  return path;
}

export class TextComponent {
  inputEl = document.createElement('input');
  setPlaceholder() {
    return this;
  }
  setValue(value: string) {
    this.inputEl.value = value;
    return this;
  }
  onChange(cb: (value: string) => unknown) {
    this.inputEl.addEventListener('input', () => void cb(this.inputEl.value));
    return this;
  }
}

export class TextAreaComponent {
  inputEl = document.createElement('textarea');
  setPlaceholder() {
    return this;
  }
  setValue(value: string) {
    this.inputEl.value = value;
    return this;
  }
  onChange(cb: (value: string) => unknown) {
    this.inputEl.addEventListener('input', () => void cb(this.inputEl.value));
    return this;
  }
}

export class DropdownComponent {
  selectEl = document.createElement('select');
  addOption(value: string, display: string) {
    const option = document.createElement('option');
    option.value = value;
    option.text = display;
    this.selectEl.appendChild(option);
    return this;
  }
  setValue(value: string) {
    this.selectEl.value = value;
    return this;
  }
  onChange(cb: (value: string) => unknown) {
    this.selectEl.addEventListener(
      'change',
      () => void cb(this.selectEl.value),
    );
    return this;
  }
}

export class ToggleComponent {
  toggleEl = document.createElement('div');
  private value = false;
  private cb: ((value: boolean) => unknown) | null = null;
  constructor() {
    this.toggleEl.addEventListener('click', () => {
      this.value = !this.value;
      if (this.cb) void this.cb(this.value);
    });
  }
  setValue(value: boolean) {
    this.value = value;
    return this;
  }
  onChange(cb: (value: boolean) => unknown) {
    this.cb = cb;
    return this;
  }
}

export class ButtonComponent {
  buttonEl = document.createElement('button');
  setButtonText(text: string) {
    this.buttonEl.textContent = text;
    return this;
  }
  setCta() {
    this.buttonEl.classList.add('mod-cta');
    return this;
  }
  setDisabled(disabled: boolean) {
    this.buttonEl.disabled = disabled;
    return this;
  }
  onClick(cb: () => unknown) {
    this.buttonEl.addEventListener('click', () => void cb());
    return this;
  }
}

export class ExtraButtonComponent {
  extraSettingsEl = document.createElement('div');
  setIcon() {
    return this;
  }
  setTooltip() {
    return this;
  }
  onClick(cb: () => unknown) {
    this.extraSettingsEl.addEventListener('click', () => void cb());
    return this;
  }
}

export class Setting {
  settingEl: HTMLElement;
  constructor(public containerEl: HTMLElement) {
    this.settingEl = document.createElement('div');
    containerEl.appendChild(this.settingEl);
  }
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  setHeading() {
    return this;
  }
  addText(cb: (component: TextComponent) => unknown) {
    const component = new TextComponent();
    this.settingEl.appendChild(component.inputEl);
    cb(component);
    return this;
  }
  addTextArea(cb: (component: TextAreaComponent) => unknown) {
    const component = new TextAreaComponent();
    this.settingEl.appendChild(component.inputEl);
    cb(component);
    return this;
  }
  addDropdown(cb: (component: DropdownComponent) => unknown) {
    const component = new DropdownComponent();
    this.settingEl.appendChild(component.selectEl);
    cb(component);
    return this;
  }
  addToggle(cb: (component: ToggleComponent) => unknown) {
    const component = new ToggleComponent();
    this.settingEl.appendChild(component.toggleEl);
    cb(component);
    return this;
  }
  addButton(cb: (component: ButtonComponent) => unknown) {
    const component = new ButtonComponent();
    this.settingEl.appendChild(component.buttonEl);
    cb(component);
    return this;
  }
  addExtraButton(cb: (component: ExtraButtonComponent) => unknown) {
    const component = new ExtraButtonComponent();
    this.settingEl.appendChild(component.extraSettingsEl);
    cb(component);
    return this;
  }
}
