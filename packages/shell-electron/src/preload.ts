// Preload runs in an isolated world with sandbox: true. It exposes the narrowest possible
// surface; everything else the renderer needs comes from standard web APIs.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('umbraShell', {
  kind: 'electron' as const,
  versions: () => ipcRenderer.invoke('umbra:versions'),
  /** Used only by the `--spikes` harness to report results back to the main process. */
  reportSpikes: (payload: { pass: boolean; text: string }) =>
    ipcRenderer.send('umbra:spikes-done', payload),
  /**
   * Writes a file the user picks in a native dialog. The renderer never sees a path it did
   * not get back from this call, and the main process only ever writes where the user chose.
   */
  saveFile: (name: string, data: ArrayBuffer): Promise<string | null> =>
    ipcRenderer.invoke('umbra:save-file', name, data),
  /** Whether this build can update itself (the AppImage can; dev runs cannot). */
  canUpdate: (): Promise<boolean> => ipcRenderer.invoke('umbra:can-update'),
  /** Help ▸ Check for Updates…: the main process runs the whole flow in native dialogs. */
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke('umbra:check-updates'),
});
