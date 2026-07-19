# Obsidian Daily Notes - Architecture & Design

## Overview
The `obsidian-daily-notes` plugin serves as a foundational scaffold, establishing robust utilities and structural patterns intended for the `standard-obsidian-lib`. Rather than just providing UI features, it heavily emphasizes robust core logic: structured logging, schema validation, safe error handling, and file system abstractions.

## Architecture
- **Entry Point (`main.ts`)**: The core `DailyNotesPlugin` class extends `Plugin`. It handles Obsidian lifecycle events (`onload`) and wires up the initial UI components (like the Ribbon icon).
- **Schema Manager (`src/schema`)**: Manages plugin settings using a `SchemaManager` backed by `zod`. It supports schema versioning and seamless data migrations. 
- **Telemetry & Logging (`src/logging`)**: Integrates OpenTelemetry semantics and `winston`. It provides a custom Loki transport (`loki/transport.ts`) to batch and send logs to a remote Loki instance (`https://nginx.parrajustin.com/loki/`). 
- **Core Library (`src/lib`)**: Contains critical utilities for robust execution:
  - Custom `Result` and `Option` types (similar to Rust/Neverthrow) for explicit error handling.
  - `diff_merge_patch` for 3-way merging content.
  - Safe promise wrappers (`wrap_promise`, `wrap_to_result`) to catch unhandled rejections from Obsidian APIs.

## Data Flow
- **Settings Initialization**: 
  1. `loadData()` retrieves the raw JSON configuration from Obsidian.
  2. The raw object is passed into `SETTINGS_CONFIG_SCHEMA_MANAGER.updateSchema()`.
  3. `zod` validates and migrates the object (e.g., to `Version0SettingsConfig`).
  4. If validation fails, it safely falls back to a default configuration to prevent plugin crashes.
- **Observability Pipeline**:
  1. Methods decorated with `@Span()` automatically emit execution traces.
  2. The `winston` logger collects debug and critical events.
  3. The `Loki` batcher aggregates these logs and pushes them to the remote server over HTTP.

## Code Flow
1. **Plugin Load**: Obsidian invokes `DailyNotesPlugin.onload()`.
2. **Setup**: The plugin injects the Ribbon icon (`addRibbonIcon`) and executes `await this.loadSettings()`.
3. **Execution**: Core business logic relies heavily on the `Result<T, E>` pattern (`unsafeUnwrap`, `unwrapOr`, `andThen`) rather than traditional `try/catch`.
4. **File Operations**: IO operations rely on `app.vault` (high-level) and `app.vault.adapter` (low-level). As documented in `src/obsidian_api.md`, high-level cache-aware methods (`readBinary`, `createBinary`) are preferred, wrapping them with `WrapPromise` to capture IO failures.

## Tips and Tricks
- **Avoid Try/Catch Chaos**: Embrace the custom `Result` wrapper for Obsidian APIs. Use `wrap_to_result` to convert unstable Promise chains into predictable `Result` objects.
- **Trace Everything Critical**: Apply the `@Span()` decorator to complex lifecycle events (like `onload`, `loadSettings`, `saveSettings`) to automatically trace execution durations.
- **Zod for Configurations**: Never trust raw `loadData()` output. Use the `SchemaManager` with `zod` to validate structure, making future settings updates and migrations trivial.
- **Cache-Aware File Operations**: Use `app.vault.getAbstractFileByPath` to check file existence before attempting to read/write, avoiding file-system race conditions and cache mismatches.
