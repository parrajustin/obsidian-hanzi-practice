# Obsidian Plugin Architecture & Best Practices

This document outlines the architectural patterns, data flow, code flow, and best practices for developing Obsidian plugins. It is intended to serve as a comprehensive reference for building robust, scalable plugins.

## 1. Core Architecture

Obsidian plugins run in a hybrid environment: an Electron runtime for desktop and a Capacitor runtime for mobile. They are structured around a lifecycle managed by the Obsidian core application.

*   **Plugin Class**: The entry point for any plugin is a class that extends `Plugin` from the `obsidian` module.
*   **Manifest (`manifest.json`)**: Contains essential metadata (ID, version, min App version, name, author, etc.). The ID must match the plugin folder name.
*   **Lifecycle Methods**:
    *   `onload()`: Executed when the plugin is enabled. Responsible for initializing settings, registering views, commands, ribbon icons, and events.
    *   `onunload()`: Executed when the plugin is disabled. Obsidian automatically cleans up events and elements registered via `register*` methods, but manual cleanup is required for raw DOM modifications or unmanaged intervals.

## 2. Component Structure

Plugins typically interact with the Obsidian UI through standard components:

*   **Commands**: Registered using `this.addCommand()`. They can be invoked via the Command Palette or hotkeys. Can use `callback` (always available) or `checkCallback` (conditional availability based on current state).
*   **Ribbon Icons**: Registered using `this.addRibbonIcon()`. Adds a permanent action button to the left sidebar.
*   **Views**: Custom panes that extend `ItemView`. They have their own lifecycle (`onOpen`, `onClose`) and DOM container (`this.contentEl`). Registered via `this.registerView()`.
*   **Modals**: Transient dialogs extending `Modal` or `SuggestModal`. Useful for user input, confirmation, or selecting from a list of options.
*   **Settings Tab**: A dedicated UI for user configuration, extending `PluginSettingTab` and registered with `this.addSettingTab()`.

## 3. Data Flow

Data management is centralized and file-based.

*   **Storage Location**: Plugin settings and persistent state are stored in a `data.json` file inside the `.obsidian/plugins/{plugin-id}/` directory.
*   **Loading Data**: `await this.loadData()` retrieves the parsed JSON object. It returns `null` if the file doesn't exist.
*   **State Initialization Pattern**:
    ```typescript
    const DEFAULT_SETTINGS = { mySetting: 'default' };
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    ```
    *Note: For `standard-obsidian-lib`, it is highly recommended to validate this data at runtime using Zod to handle schema versioning and corrupted user files gracefully.*
*   **Saving Data**: `await this.saveData(this.settings)` serializes the object and writes it back to `data.json`. This should be triggered on user input in the Settings Tab, not on an interval, to avoid disk churn.

## 4. Code Flow & Event System

Obsidian relies heavily on an event-driven architecture, exposing several core managers under the `this.app` object.

*   **Vault (`this.app.vault`)**: Handles the raw filesystem.
    *   *Events*: `create`, `modify`, `delete`, `rename`.
    *   *Methods*: `read()`, `modify()`, `getAbstractFileByPath()`. Works with `TFile` (files) and `TFolder` (directories).
*   **Workspace (`this.app.workspace`)**: Manages the layout, panels, leaves, and active state.
    *   *Events*: `file-open`, `active-leaf-change`, `layout-change`, `quit`.
    *   *Usage*: Used to mount views, iterate through open leaves, and monitor user focus.
*   **Metadata Cache (`this.app.metadataCache`)**: Provides high-performance access to parsed markdown data without disk reads.
    *   *Events*: `changed`, `resolve`.
    *   *Usage*: Retrieve frontmatter (`getFileCache`), tags, headings, and links (`resolvedLinks`, `unresolvedLinks`).
*   **Event Registration Rule**: Always wrap event listeners in `this.registerEvent(this.app.workspace.on(...))` to ensure they are unregistered when the plugin unloads, preventing memory leaks.

## 5. Best Practices, Tips, & Tricks

*   **Mobile Compatibility**: Avoid Node-specific APIs (`fs`, `path`, `child_process`). Rely entirely on `this.app.vault` and Obsidian's API. If Node modules are strictly necessary for desktop, guard them with environment checks.
*   **Debounce File Events**: `vault.on('modify')` and `metadataCache.on('changed')` fire very frequently (e.g., on every keystroke). Always debounce operations triggered by these events to prevent severe performance degradation.
*   **Memory Management**:
    *   Use `this.registerInterval(window.setInterval(...))` instead of raw `setInterval`.
    *   Use `this.registerDomEvent(document, 'click', ...)` instead of `document.addEventListener`.
*   **CSS Isolation**: Write styles in `styles.css`. Always namespace CSS classes with your plugin ID (e.g., `.obsidian-standard-lib-container`) to avoid conflicting with other plugins or custom themes.
*   **Monkey Patching**: Avoid overriding Obsidian core functions. If extending unofficial behavior is unavoidable, use the `around` function from `monkey-around` and carefully unpatch on unload.
*   **File Manager**: Prefer `this.app.fileManager.processFrontMatter()` over manually parsing and rewriting YAML blocks, as it handles edge cases and caching safely.
