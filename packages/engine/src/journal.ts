/**
 * Crash-recovery journal — spec 03 §7.
 *
 * The journal is a PSD. That is deliberate: a bespoke format would be a second serialiser to
 * keep in step with the document model, and the one thing a recovery file must never do is
 * fail to load. Recovery is therefore the ordinary open path, and a journal left behind by a
 * crash can also just be opened by hand.
 *
 * It lives in the Origin Private File System, which is available inside the worker that owns
 * the document, so writing it never crosses a thread boundary or touches the UI.
 */

const DIR = 'umbra-journal';
const FILE = 'recovery.psd';
const META = 'recovery.json';

export interface JournalMeta {
  name: string;
  /** Epoch milliseconds of the last write. */
  savedAt: number;
  width: number;
  height: number;
}

async function dir(): Promise<FileSystemDirectoryHandle | null> {
  // OPFS is absent in some contexts (older engines, tests, private modes). Journalling is a
  // convenience, so its absence must never break editing.
  const storage = (navigator as { storage?: StorageManager }).storage;
  if (!storage?.getDirectory) return null;
  try {
    const root = await storage.getDirectory();
    return await root.getDirectoryHandle(DIR, { create: true });
  } catch {
    return null;
  }
}

export class Journal {
  /** Set while a write is in flight, so a slow save cannot overlap the next one. */
  private writing = false;
  private pending: { bytes: ArrayBuffer; meta: JournalMeta } | null = null;

  /**
   * Queue a snapshot. Calls that arrive while one is being written replace the queued one
   * rather than stacking up — only the newest state is worth keeping.
   */
  write(bytes: ArrayBuffer, meta: JournalMeta): void {
    this.pending = { bytes, meta };
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.writing) return;
    const next = this.pending;
    if (!next) return;
    this.pending = null;
    this.writing = true;
    try {
      const handle = await dir();
      if (handle) {
        await writeFile(handle, FILE, next.bytes);
        await writeFile(handle, META, new TextEncoder().encode(JSON.stringify(next.meta)).buffer as ArrayBuffer);
      }
    } catch (err) {
      // A failed journal write is not worth interrupting the user for; the next one may work.
      console.warn('[journal] write failed', err);
    } finally {
      this.writing = false;
      if (this.pending) void this.drain();
    }
  }

  async read(): Promise<{ bytes: ArrayBuffer; meta: JournalMeta } | null> {
    const handle = await dir();
    if (!handle) return null;
    try {
      const metaFile = await (await handle.getFileHandle(META)).getFile();
      const meta = JSON.parse(await metaFile.text()) as JournalMeta;
      const psd = await (await handle.getFileHandle(FILE)).getFile();
      return { bytes: await psd.arrayBuffer(), meta };
    } catch {
      return null;
    }
  }

  /** Called once the work is safely saved, so the next start does not offer stale recovery. */
  async clear(): Promise<void> {
    const handle = await dir();
    if (!handle) return;
    for (const name of [FILE, META]) {
      try {
        await handle.removeEntry(name);
      } catch {
        // Already gone.
      }
    }
  }
}

async function writeFile(
  handle: FileSystemDirectoryHandle,
  name: string,
  bytes: ArrayBuffer,
): Promise<void> {
  const file = await handle.getFileHandle(name, { create: true });
  const stream = await file.createWritable();
  await stream.write(bytes);
  await stream.close();
}
