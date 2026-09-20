import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { EngineClient } from './engine-client';
import type { DocSummary, EngineStats, GpuCaps } from '@umbra/engine';

/**
 * M0 harness UI. This is deliberately not the real workspace — the options bar, tools panel,
 * docking and panels land in M1 (spec 01). What is here exists to drive and observe the
 * engine: open an image, build the synthetic stress document, paint, and watch the budgets.
 */
export function App() {
  let canvasRef!: HTMLCanvasElement;
  let wrapRef!: HTMLDivElement;
  let client: EngineClient | undefined;

  const [caps, setCaps] = createSignal<GpuCaps | null>(null);
  const [stats, setStats] = createSignal<EngineStats | null>(null);
  const [doc, setDoc] = createSignal<DocSummary | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [spikes, setSpikes] = createSignal<string | null>(null);
  const [lost, setLost] = createSignal(false);
  const [paint, setPaint] = createSignal(true);
  const [size, setSize] = createSignal(60);

  const spikeMode = location.hash === '#spikes';

  onMount(() => {
    try {
      client = new EngineClient(canvasRef, {
        onReady: (c) => {
          setCaps(c);
          if (spikeMode) client!.send({ t: 'runSpikes' });
          else client!.send({ t: 'synthetic', layers: 12, width: 2400, height: 1600 });
        },
        onStats: setStats,
        onDoc: setDoc,
        onContextLost: () => setLost(true),
        onContextRestored: () => setLost(false),
        onSpikes: (pass, text) => {
          setSpikes(text);
          const shell = (globalThis as Record<string, any>).umbraShell;
          shell?.reportSpikes?.({ pass, text });
        },
        onError: (m) => {
          setError(m);
          const shell = (globalThis as Record<string, any>).umbraShell;
          if (spikeMode) shell?.reportSpikes?.({ pass: false, text: `ERROR: ${m}` });
        },
      });
      client.paintMode = paint();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setError(m);
      (globalThis as Record<string, any>).umbraShell?.reportSpikes?.({ pass: false, text: `ERROR: ${m}` });
      return;
    }

    const ro = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      client?.resize(Math.max(1, r.width), Math.max(1, r.height));
    });
    ro.observe(wrapRef);
    onCleanup(() => {
      ro.disconnect();
      client?.dispose();
    });
  });

  const send = (m: Parameters<EngineClient['send']>[0]) => client?.send(m);

  async function openFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const bitmap = await createImageBitmap(file);
      client?.send({ t: 'openBitmap', bitmap, name: file.name }, [bitmap]);
    };
    input.click();
  }

  return (
    <div class="workspace">
      <div class="options-bar">
        <button onClick={openFile}>Open…</button>
        <button onClick={() => send({ t: 'synthetic', layers: 100, width: 3840, height: 2160 })}>
          100 layers @ 4K
        </button>
        <button onClick={() => send({ t: 'newDoc', width: 3840, height: 2160 })}>New 4K</button>
        <span class="sep" />
        <button onClick={() => send({ t: 'fit' })}>Fit</button>
        <button onClick={() => send({ t: 'actualPixels' })}>100%</button>
        <button onClick={() => send({ t: 'zoomAt', factor: 1 / 1.4, x: 0, y: 0 })}>−</button>
        <button onClick={() => send({ t: 'zoomAt', factor: 1.4, x: 0, y: 0 })}>+</button>
        <span class="sep" />
        <label>
          <input
            type="checkbox"
            checked={paint()}
            onChange={(e) => {
              setPaint(e.currentTarget.checked);
              if (client) client.paintMode = e.currentTarget.checked;
            }}
          />
          Paint
        </label>
        <label>
          Size
          <input
            type="range"
            min="4"
            max="500"
            value={size()}
            onInput={(e) => {
              const v = +e.currentTarget.value;
              setSize(v);
              if (client) client.brush = { ...client.brush, size: v };
            }}
          />
          <span style={{ width: '30px', 'font-family': 'var(--mono)' }}>{size()}</span>
        </label>
        <span class="sep" />
        <button onClick={() => send({ t: 'loseContext' })}>Lose context</button>
        <button onClick={() => send({ t: 'runSpikes' })}>Run spikes</button>
        <span class="spacer" />
        <Show when={lost()}>
          <span style={{ color: 'var(--bad)' }}>GPU context lost — restoring…</span>
        </Show>
      </div>

      <div class="doc-area" ref={wrapRef}>
        <canvas ref={canvasRef} />
        {/* `stats() && !spikes()` would hand the child the boolean, not the stats object. */}
        <Show when={spikes() ? null : stats()}>
          {(s) => (
            <div class="hud">
              <b>{s().fps.toFixed(0)} fps</b> {s().frameMs.toFixed(2)} ms{'\n'}
              draws <b>{s().drawCalls}</b> instances <b>{s().instances}</b> mip L{s().level}
              {'\n'}
              atlas {s().atlasResident}/{s().atlasCapacity} up {s().atlasUploads} evict 
              {s().atlasEvictions}
              {'\n'}
              layers <b>{s().docLayers}</b> docTiles <b>{s().docTiles}</b>{'\n'}
              tiles <b>{(s().tileBytes / 1e6).toFixed(1)} MB</b> zoom{' '}
              <b>{(s().zoom * 100).toFixed(1)}%</b>
              {'\n'}
              latency{' '}
              <b>{s().lastLatencyMs === null ? '—' : `${s().lastLatencyMs!.toFixed(1)} ms`}</b>
            </div>
          )}
        </Show>
        <Show when={spikes()}>
          <pre class="spikes" innerHTML={colourise(spikes()!)} />
        </Show>
      </div>

      <div class="status-bar">
        <Show when={doc()} fallback={<span>no document</span>}>
          {(d) => (
            <span>
              {d().name} — {d().width} × {d().height} px, {d().layers.length} layer
              {d().layers.length === 1 ? '' : 's'}
            </span>
          )}
        </Show>
        <span class="spacer" />
        <Show when={error()}>
          <span style={{ color: 'var(--bad)' }}>{error()}</span>
        </Show>
        <Show when={caps()}>{(c) => <span>{c().renderer}</span>}</Show>
      </div>
    </div>
  );
}

function colourise(text: string): string {
  const escaped = text.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!);
  return escaped
    .replace(/\bPASS\b/g, '<span class="pass">PASS</span>')
    .replace(/\bFAIL\b/g, '<span class="fail">FAIL</span>');
}
