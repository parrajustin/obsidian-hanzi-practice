# Standard Obsidian Library (`standard-obsidian-lib`) Architecture

## Overview
A standardized utility library for Obsidian plugin development, extending `standard-ts-lib` to enforce Google TypeScript Style Guide practices. It provides robust error handling (`Result` / `Optional`), tracing, filesystem abstraction, and schema versioning.

## Architecture & Modules

### 1. Decorators (`src/decorators`)
**Purpose**: OpenTelemetry span instrumentation for `Result`-returning functions.

*   **`@ResultSpanError`**: Synchronous wrapper.
*   **`@PromiseResultSpanError`**: Asynchronous wrapper.

**Code/Data Flow**:
1. Method invoked -> Span created (named via class/method).
2. Method executed (or Promise awaited).
3. Evaluates returned `Result<T, StatusError>`.
4. `Ok` -> Span status `OK`.
5. `Err` -> Span status `ERROR`, attaches error message to span.
6. Returns the original `Result` downstream.

**Tips & Tricks**:
*   Attach these strictly to methods returning `Result` or `Promise<Result>`. Use these decorators to avoid manual `try/catch` span manipulation in your core business logic, keeping functions clean.

### 2. Filesystem (`src/filesystem`)
**Purpose**: Unified API (`FileUtil`) bridging high-level `Vault` and low-level `Adapter` Obsidian APIs.

*   **`FileSystemType.OBSIDIAN`**: Uses `app.vault` (`readBinary`, `modifyBinary`, `createBinary`, `trash`). Recommended for vault-safe operations.
*   **`FileSystemType.RAW`**: Uses `app.vault.adapter` (`readBinary`, `writeBinary`, `trashSystem`/`trashLocal`). Useful for raw system access.

**Data Flow**:
*   **`fetchFile`**: `(App, Path, Type) -> Promise<Result<Uint8Array, StatusError>>`
*   **`writeToFile`**: Takes `Uint8Array`. Automatically handles creating missing parent directories. Returns `StatusResult<StatusError>`.
*   **`deleteFile`**: Moves files to trash safely.

**Code Flow**:
`FileUtil` acts as a facade. Its methods determine the `FileSystemType` and delegate to the internal implementation (`FileUtilObsidianApi` or `FileUtilRawApi`). All underlying Obsidian API exceptions are caught and wrapped in a standardized `StatusError`.

**Tips & Tricks**:
*   Always default to `OBSIDIAN` type unless you strictly need adapter features.
*   The API forces binary (`Uint8Array`) data handling. Text encoding/decoding should be handled explicitly by the caller when necessary.

### 3. Schema (`src/schema`)
**Purpose**: Versioned schema management with `zod` for robust data migrations (e.g., plugin settings data).

*   **`SchemaManager`**: Orchestrates validation and sequential upgrading.
*   **`VersionedSchema<T, V>`**: Utility type enforcing a literal `version` field.

**Data Flow (Migration)**:
1. `updateSchema(data)` receives an unknown `any` payload (e.g., from `loadData()`).
2. Extracts the `version` field.
3. Validates against the Zod schema for that specific version.
4. Executes a chain of `Converters` (e.g., V0 -> V1, V1 -> V2) sequentially.
5. Returns `Result<LatestData, StatusError>`.

**Code Flow**:
To use it, instantiate `SchemaManager` with:
1. Ordered array of Zod schemas `[v0, v1, v2]`.
2. Ordered array of migration functions `[v0_to_v1, v1_to_v2]`.
3. Default data factory function `() => LatestData`.

**Tips & Tricks**:
*   Migrations are processed sequentially. To go from V0 to V2, the system automatically runs V0->V1, then V1->V2. Do not write monolithic direct migrations (V0->V2).
*   Always use `getDefault()` on initial plugin load if `loadData()` returns null, ensuring new users start cleanly on the latest version.
