export class App {
  workspace = new Workspace();
  vault = new Vault();
}

export class Vault {
  adapter = new Adapter();
  readBinary = jest.fn();
  modifyBinary = jest.fn();
  createBinary = jest.fn();
  trash = jest.fn();
  // Text-file API used by the modals. Tests set per-case return values.
  getAbstractFileByPath = jest.fn().mockReturnValue(null);
  read = jest.fn().mockResolvedValue('');
  modify = jest.fn().mockResolvedValue(undefined);
  create = jest.fn().mockResolvedValue(undefined);
}

export class Adapter {
  readBinary = jest.fn();
  writeBinary = jest.fn();
  trashSystem = jest.fn();
  trashLocal = jest.fn();
}

export class Workspace {
  getLeavesOfType = jest.fn().mockReturnValue([]);
  getRightLeaf = jest.fn().mockReturnValue(new WorkspaceLeaf());
  revealLeaf = jest.fn();
  detachLeavesOfType = jest.fn();
}

export class WorkspaceLeaf {
  view = new ItemView(this);
  setViewState = jest.fn();
}

export class ItemView {
  containerEl = document.createElement('div');

  constructor(public leaf: any) {
    // Setup a dummy DOM structure for Obsidian view container
    const header = document.createElement('div');
    const content = document.createElement('div');
    this.containerEl.appendChild(header);
    this.containerEl.appendChild(content);
  }

  getViewType() {
    return 'dummy-view';
  }

  getDisplayText() {
    return 'Dummy View';
  }

  async setState() {}

  getState(): Record<string, unknown> {
    return {};
  }

  onOpen() {}
  onClose() {}
}

export class Plugin {
  app = new App();
  addSettingTab = jest.fn();
  addCommand = jest.fn();
  registerView = jest.fn();
  loadData = jest.fn().mockResolvedValue(null);
  saveData = jest.fn().mockResolvedValue(null);
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

export class TFile {}

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
    // Obsidian toggles flip on click.
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

/** Every Notice text shown since the last `noticeMessages.length = 0`. */
export const noticeMessages: string[] = [];

export class Notice {
  constructor(public message: string) {
    noticeMessages.push(message);
  }
}
