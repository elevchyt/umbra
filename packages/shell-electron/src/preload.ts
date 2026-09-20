// Preload runs in an isolated world with sandbox: true. It exposes the narrowest possible
// surface; everything else the renderer needs comes from standard web APIs.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('umbraShell', {
  kind: 'electron' as const,
  versions: () => ipcRenderer.invoke('umbra:versions'),
  /** Used only by the `--spikes` harness to report results back to the main process. */
  reportSpikes: (payload: { pass: boolean; text: string }) =>
    ipcRenderer.send('umbra:spikes-done', payload),
});
