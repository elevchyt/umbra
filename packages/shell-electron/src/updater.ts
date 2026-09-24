// Self-update for the AppImage build: electron-updater reads the latest GitHub release's
// latest-linux.yml, and on the user's say-so downloads the new AppImage (sha512-verified) and
// swaps it in place of the running one. Only an AppImage can replace itself, so every other
// way of running Umbra (dev, `electron dist/main.js`, a distro package) never checks.
import { app, BrowserWindow, dialog } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

/** Set while a check, download or prompt is in flight, so checks never stack. */
let busy = false;

export function canUpdate(): boolean {
  return app.isPackaged && !!process.env.APPIMAGE;
}

/**
 * Check GitHub for a newer release and walk the user through installing it. `manual` is a
 * Help ▸ Check for Updates… request: it also reports "up to date" and errors, which a launch
 * check keeps quiet about (offline is not worth a dialog).
 */
export async function checkForUpdates(manual: boolean): Promise<void> {
  const win = BrowserWindow.getAllWindows()[0] ?? null;
  const box = (opts: Electron.MessageBoxOptions) => (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
  if (!canUpdate()) {
    if (manual) await box({ type: 'info', title: 'Check for Updates', message: 'Updates are only available in the AppImage build.' });
    return;
  }
  if (busy) return;
  busy = true;
  try {
    autoUpdater.autoDownload = false;
    // "Later" after downloading still installs, the next time Umbra quits.
    autoUpdater.autoInstallOnAppQuit = true;
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo.version;
    if (!result?.isUpdateAvailable || !latest) {
      if (manual) await box({ type: 'info', title: 'Check for Updates', message: `Umbra ${app.getVersion()} is the latest version.` });
      return;
    }

    const { response } = await box({
      type: 'info',
      title: 'Update Available',
      message: `Umbra ${latest} is available.`,
      detail: `You have ${app.getVersion()}. Download and install it now?${notes(result.updateInfo.releaseNotes)}`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;

    const progress = (p: { percent: number }) => win?.setProgressBar(p.percent / 100);
    autoUpdater.on('download-progress', progress);
    try {
      await autoUpdater.downloadUpdate();
    } finally {
      autoUpdater.off('download-progress', progress);
      win?.setProgressBar(-1);
    }

    const restart = await box({
      type: 'info',
      title: 'Update Ready',
      message: `Umbra ${latest} is ready to install.`,
      detail: 'Restart now to finish updating. Save your work first: unsaved changes are lost. Choose Later to install it the next time you quit.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (restart.response === 0) autoUpdater.quitAndInstall();
  } catch (err) {
    console.error('[updater]', err);
    if (manual) {
      await box({ type: 'error', title: 'Check for Updates', message: 'Could not check for updates.', detail: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    busy = false;
  }
}

/** Release notes arrive as HTML (GitHub renders the Markdown); a message box wants text. */
function notes(raw: string | { note: string | null }[] | null | undefined): string {
  const text = (typeof raw === 'string' ? raw : (raw ?? []).map((n) => n.note ?? '').join('\n'))
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return '';
  return `\n\nWhat's new:\n${text.length > 600 ? `${text.slice(0, 600)}…` : text}`;
}
