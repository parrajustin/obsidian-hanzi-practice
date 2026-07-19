# Obsidian Drive Sync Architecture

## Overview
A Firebase-backed synchronization plugin for Obsidian that enables syncing notes, configuration, and raw files directly with Firestore and Firebase Storage. It uses a robust, stateful sync engine driven by a continuous "tick" loop and resolves conflicts utilizing a "last write wins" convergence strategy.

## Core Components
*   **FileSyncer (`src/sync/syncer.ts`)**: 
    *   The stateful engine driving the synchronization loop.
    *   Manages the local file watcher and coordinates with the Firebase remote state.
    *   Executes in a continuous, non-blocking `setTimeout` tick loop.
*   **Convergence Engine (`src/sync/convergence_util.ts`)**:
    *   Determines necessary actions to align local and cloud states.
    *   Actions: `NEW_LOCAL_FILE`, `UPDATE_CLOUD`, `UPDATE_LOCAL`, `DELETE_LOCAL`, `MARK_CLOUD_DELETED`.
    *   Conflict Resolution: Strictly "last write wins" based on modification timestamps (`mTime`).
*   **Unified Filesystem API (`src/filesystem/file_access.ts`)**:
    *   Abstracts Obsidian's Vault API (`TFile`) and Raw FS API (`app.vault.adapter`).
    *   Critical for supporting synchronization of hidden system files (e.g., `.obsidian/` configs) which Obsidian's standard API ignores.
*   **Firebase Backend (`src/sync/firebase_syncer.ts`)**:
    *   Manages Firestore real-time snapshot listeners for immediate cross-device sync.
    *   Employs `FirebaseCache` to maintain an in-memory representation of cloud state, heavily reducing unnecessary network reads.
*   **Observability & UI (`src/sidepanel/progressView.ts`)**:
    *   A custom Obsidian `ItemView` detailing ongoing convergence actions, publishing stats, and error tracking.
    *   Uses native Obsidian DOM methods (`createDiv`, `createEl`) instead of UI frameworks (React/Svelte) for maximum performance during heavy file churn.

## Data Flow (The Sync Cycle)
1.  **State Observation**:
    *   **Local**: File watcher observes FS events (`created`, `modified`, `deleted`, `renamed`) and queues them into `_touchedFilepaths`.
    *   **Remote**: Firebase snapshot listeners observe changes in Firestore and update the `FirebaseCache`.
2.  **Convergence Calculation**:
    *   During the tick, `ConvergenceUtil` compares the Local In-Memory Map, Touched Local Files, and Cloud Cache.
    *   It generates a deterministic list of `ConvergenceAction`s.
3.  **Batched Execution**:
    *   `SyncerUpdateUtil.executeLimitedSyncConvergence` executes a bounded subset (batch) of the actions.
    *   This throttling prevents UI thread locking and Firebase API rate-limiting.
4.  **State Finalization**:
    *   The in-memory file map is updated.
    *   `SyncProgressView` receives event hooks to update the visible progress bars and historical logs.

## Code Flow Pipeline
1.  **Initialization**: `main.ts` -> `onload()` -> Initialize Firebase App -> `loadSettings()`.
2.  **Syncer Boot**: `startupSyncers()` spawns independent `FileSyncer` instances based on user settings (allows multi-root sync).
3.  **Bootstrapping**: `FileSyncer.init()` -> Fetches initial remote state -> Scans initial local FS -> Subscribes to events -> Triggers the first tick.
4.  **Main Loop**: `fileSyncerTick()` -> Computes convergence -> Executes bounded batch -> Schedules next tick (dynamic backoff, ~1s or min 50ms).

## Tips & Tricks
*   **Monadic Error Handling**: The codebase heavily relies on `Result<T, E>` and `Option<T>` wrappers. Always use `.map()`, `.andThen()`, or `.safeUnwrap()` instead of standard `try/catch` blocks.
*   **DOM Building**: When modifying UI components, mirror the pattern in `progressView.ts`: rely on `container.createDiv()` and `container.createEl()`. Avoid injecting large innerHTML strings to prevent XSS and performance degradation.
*   **Debugging Sync Issues**: Sync behavior is fundamentally tied to file hashes (SHA256) and `mTime`. If files aren't syncing, inspect `FileAccess.getFileNode` outputs to ensure the OS-level `mTime` is being read correctly, especially for hidden raw files.
*   **Graceful Teardown**: Syncers track their lifecycle via `_isDead`. Always ensure `killSyncer` or `teardownSyncers` is called before re-initializing to prevent memory leaks and zombie watchers.
