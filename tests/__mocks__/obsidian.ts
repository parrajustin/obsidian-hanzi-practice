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
}

export class Setting {
  constructor(public containerEl: HTMLElement) {}
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  addText() {
    return this;
  }
  addButton() {
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

export class Notice {
  constructor(public message: string) {}
}
