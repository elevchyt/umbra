/// <reference lib="webworker" />
/**
 * Engine worker entry point. Owns the document and the GL context; the UI thread only sends
 * commands and rAF ticks, and receives stats (spec 03 §2).
 */
import { Engine } from './engine.js';
import { runSpikes } from './spikes.js';
import type { FromEngine, ToEngine } from './protocol.js';

let engine: Engine | null = null;
let ringSab: SharedArrayBuffer | null = null;

function post(msg: FromEngine, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

self.onmessage = async (ev: MessageEvent<ToEngine>) => {
  const msg = ev.data;
  try {
    switch (msg.t) {
      case 'init': {
        ringSab = msg.ring;
        engine = new Engine(msg.canvas, msg.ring, msg.width, msg.height, msg.dpr, msg.atlasBudgetBytes);
        engine.resize(msg.width, msg.height, msg.dpr);
        engine.onContextLost = () => post({ t: 'contextLost' });
        engine.onContextRestored = () => post({ t: 'contextRestored' });
        post({ t: 'ready', caps: serialisableCaps(engine) });
        post({ t: 'doc', doc: engine.summary() });
        break;
      }
      case 'resize':
        engine?.resize(msg.width, msg.height, msg.dpr);
        break;
      case 'tick': {
        if (!engine) break;
        post({ t: 'stats', stats: engine.frame() });
        if (engine.strokeEnded) {
          engine.strokeEnded = false;
          post({ t: 'doc', doc: engine.summary() });
        }
        break;
      }
      case 'pan':
        engine?.pan(msg.dx, msg.dy);
        break;
      case 'zoomAt':
        engine?.zoomAtPoint(msg.factor, msg.x, msg.y);
        break;
      case 'setZoom':
        engine?.setZoom(msg.zoom);
        break;
      case 'rotate':
        engine?.rotate(msg.radians);
        break;
      case 'fit':
        engine?.fit();
        break;
      case 'actualPixels':
        engine?.actualPixels();
        break;
      case 'openPsd':
        engine?.openPsdBuffer(msg.buffer, msg.name);
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'setLayerVisible':
        engine?.setLayerVisible(msg.id, msg.visible);
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'setLayerOpacity':
        engine?.setLayerOpacity(msg.id, msg.opacity);
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'setLayerBlendMode':
        engine?.setLayerBlendMode(msg.id, msg.mode as never);
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'selectLayer':
        engine?.selectLayer(msg.id);
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'toggleGroup':
        engine?.toggleGroup(msg.id);
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'undo':
        if (engine?.undo()) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'redo':
        if (engine?.redo()) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'openBitmap':
        engine?.openBitmap(msg.bitmap, msg.name);
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'newDoc':
        engine?.newDoc(msg.width, msg.height);
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'synthetic':
        engine?.addSyntheticLayers(msg.layers, msg.width, msg.height);
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'strokeBegin':
        engine?.beginStroke(msg.size, msg.hardness, msg.color);
        break;
      case 'strokeEnd':
        engine?.endStroke();
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'loseContext':
        engine?.caps.loseContext?.loseContext();
        setTimeout(() => engine?.caps.loseContext?.restoreContext(), 600);
        break;
      case 'runParity': {
        if (!engine) throw new Error('engine not initialised');
        const { runParity } = await import('./parity-run.js');
        const { pass, text } = runParity(engine.gl, engine.caps);
        post({ t: 'parity', pass, text });
        break;
      }
      case 'runSpikes': {
        if (!engine || !ringSab) throw new Error('engine not initialised');
        const { pass, text } = await runSpikes(engine, ringSab);
        post({ t: 'spikes', pass, text });
        break;
      }
    }
  } catch (err) {
    post({ t: 'error', message: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) });
  }
};

/** `loseContext` is a live GL object and cannot cross a postMessage boundary. */
function serialisableCaps(e: Engine) {
  return { ...e.caps, loseContext: null };
}
