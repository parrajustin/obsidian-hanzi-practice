# BRAT (Beta Reviewer's Auto-update Tool) Architecture

## Overview
BRAT streamlines the installation and auto-updating of beta or unreleased Obsidian plugins directly from GitHub repositories. It bypasses the official Obsidian Community Plugins list, allowing developers and beta testers to distribute and test plugins quickly.

## Architecture & Core Modules
The architecture is modular, separating UI, GitHub API interactions, and local filesystem manipulation.
- `main.ts` (`ThePlugin`): Entry point. Loads settings, registers commands, registers the `obsidian://brat` protocol handler, and schedules the auto-update check on startup.
- `features/BetaPlugins.ts`: The core business logic. Handles the validation, downloading, installation, updating, and reloading of plugins.
- `features/githubUtils.ts`: Pure functions for interacting with the GitHub REST API and raw user content. Handles authentication for private repositories.
- `ui/`: Contains the settings tab (`SettingsTab.ts`), command registration (`PluginCommands.ts`), and the modal for adding new plugins (`AddNewPluginModal.ts`).
- `settings.ts`: Defines settings interfaces and helper functions for mutating state (e.g., adding to the `pluginList` or `pluginSubListFrozenVersion`).

## Code & Data Flow

### 1. Adding a Beta Plugin
1. **Trigger**: User inputs a repo path (e.g., `user/repo`) via `AddNewPluginModal` or clicks a URI `obsidian://brat?plugin=user/repo`.
2. **Validation**: `BetaPlugins.validateRepository` requests `manifest-beta.json` (fallback to `manifest.json`) from `raw.githubusercontent.com`.
3. **Version Extraction**: Checks `id` and `version`, and validates `minAppVersion` against the current Obsidian version (`apiVersion`).
4. **Fetch Release Assets**: `BetaPlugins.getAllReleaseFiles` calls `githubUtils.ts` to fetch `main.js`, `manifest.json`, and optionally `styles.css` from the GitHub Release matching the extracted version.
5. **Disk Write**: `writeReleaseFilesToPluginFolder` saves the fetched assets to `.obsidian/plugins/{plugin-id}/`.
6. **Enablement**: Adds the repo to the settings list and enables the plugin using Obsidian's internal `app.plugins` API.

### 2. Auto-Updating Process
1. **Trigger**: 60 seconds after `onLayoutReady` (if enabled in settings) or via Command Palette.
2. **Iteration**: `BetaPlugins.checkForPluginUpdatesAndInstallUpdates` iterates over `pluginList`, skipping repos in `pluginSubListFrozenVersion`.
3. **Comparison**: Compares the version in `.obsidian/plugins/{plugin-id}/manifest.json` with the remote manifest version.
4. **Update & Reload**: If an update exists, fetches the new release assets, overwrites the local files, and triggers a live reload by calling `app.plugins.disablePlugin()` followed by `enablePlugin()`.

## Advanced Features & Mechanisms
- **Private Repositories**: Uses a Personal Access Token (PAT) stored in settings to attach an `Authorization: Token {PAT}` header to `obsidian::request` calls.
- **Frozen Versions**: Allows users to specify an exact release tag to install and ignores it during the auto-update loop.
- **Beta Manifests**: Prioritizes `manifest-beta.json` over `manifest.json` to allow developers to publish stable releases to the community while testing newer betas with BRAT.
- **Custom URI Protocol**: Registers `brat` using `registerObsidianProtocolHandler`.

## Tips & Tricks for Plugin Development
- **Live Reloading Pattern**: BRAT implements a clever hot-reload by toggling the plugin state:
  ```typescript
  await plugins.disablePlugin(pluginName);
  await plugins.enablePlugin(pluginName);
  ```
- **Internal API Usage**: Leverages undocumented Obsidian APIs like `app.plugins.plugins`, `app.plugins.manifests`, and `app.plugins.enablePluginAndSave()` which are powerful but require careful TypeScript typing.
- **Deferred Startup**: Uses `setTimeout(..., 60000)` inside `onLayoutReady` to defer the heavy network requests for checking updates, preventing Obsidian startup lag.
- **Global Window Object**: BRAT exposes itself to the console for debugging via `window.bratAPI = this.bratApi;`, a useful pattern for complex plugins.
- **GitHub API Rate Limits**: Uses `raw.githubusercontent.com` where possible instead of the REST API to save on rate limits, only calling the API when necessary (e.g., for release assets or private repos).
