import { contextBridge, ipcRenderer } from "electron";

// Keep this file dependency-free at runtime: in sandbox: true preloads, only
// the `electron` module and very small relative imports are safe to require.
// The IPC channel name is duplicated from main/diagnostics.ts on purpose so
// the preload bundle does not pull in node-only modules transitively.
const DESKTOP_DIAGNOSTICS_IPC_CHANNEL = "diagnostics:export-to-file";

export type DesktopDiagnosticsExportResult =
  | { ok: true; path: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; message: string };

export interface OpenDesignDesktopApi {
  exportDiagnostics(): Promise<DesktopDiagnosticsExportResult>;
}

const api: OpenDesignDesktopApi = {
  exportDiagnostics: () => ipcRenderer.invoke(DESKTOP_DIAGNOSTICS_IPC_CHANNEL) as Promise<DesktopDiagnosticsExportResult>,
};

contextBridge.exposeInMainWorld("openDesignDesktop", api);
