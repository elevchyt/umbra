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
      case 'layerCommand': {
        if (!engine) break;
        const id = msg.id ?? engine.doc.activeLayerIds[0];
        switch (msg.command) {
          case 'add': engine.addLayer(); break;
          case 'delete': if (id !== undefined) engine.deleteLayer(id); break;
          case 'duplicate': if (id !== undefined) engine.duplicateLayer(id); break;
          case 'raise': if (id !== undefined) engine.reorderLayer(id, 1); break;
          case 'lower': if (id !== undefined) engine.reorderLayer(id, -1); break;
          case 'group': engine.groupLayers(msg.ids ?? (id !== undefined ? [id] : [])); break;
          case 'ungroup': if (id !== undefined) engine.ungroupLayers(id); break;
          case 'mergeDown': if (id !== undefined) engine.mergeDown(id); break;
          case 'mergeVisible': engine.mergeVisible(); break;
          case 'flatten': engine.flatten(); break;
          case 'stampVisible': engine.stampVisible(); break;
        }
        post({ t: 'doc', doc: engine.summary() });
        break;
      }
      case 'imageCommand': {
        if (!engine) break;
        switch (msg.command) {
          case 'imageSize':
            engine.imageSize(msg.width!, msg.height!, (msg.method ?? 'bicubic') as never);
            break;
          case 'canvasSize':
            engine.canvasSize(msg.width!, msg.height!, (msg.anchor ?? 'center') as never);
            break;
          case 'rotate': engine.rotateImage((msg.angle ?? 90) as never); break;
          case 'flip': engine.flipImage(!!msg.horizontal); break;
          case 'trim': engine.trimImage(); break;
          case 'revealAll': engine.revealAll(); break;
        }
        post({ t: 'doc', doc: engine.summary() });
        break;
      }
      case 'savePsd': {
        if (!engine) break;
        const buffer = engine.toPsd();
        post({ t: 'psdSaved', name: msg.name, buffer }, [buffer]);
        break;
      }
      case 'beginSelect':
        engine?.beginSelect(msg.tool, msg.x, msg.y, msg.op as never);
        break;
      case 'updateSelect':
        engine?.updateSelect(msg.x, msg.y);
        break;
      case 'addSelectPoint':
        engine?.addSelectPoint(msg.x, msg.y);
        break;
      case 'endSelect':
        engine?.endSelect(msg.x, msg.y);
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'fill':
        engine?.fill({
          color: msg.color,
          mode: msg.mode as never,
          opacity: msg.opacity,
          preserveTransparency: msg.preserveTransparency,
          clear: msg.clear,
        });
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'stroke':
        engine?.stroke({
          color: msg.color,
          mode: msg.mode as never,
          opacity: msg.opacity,
          preserveTransparency: msg.preserveTransparency,
          width: msg.width,
          location: msg.location as never,
        });
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'sample': {
        const color = engine?.sampleColor(msg.x, msg.y, msg.size);
        if (color) post({ t: 'sampled', color, toBackground: msg.toBackground });
        break;
      }
      case 'beginTransform':
        if (engine?.beginTransform(msg.transient, msg.selectionOnly ?? false)) {
          post({ t: 'transform', active: true });
        }
        break;
      case 'transformDragBegin':
        engine?.beginTransformDrag(msg.x, msg.y, msg.rotate);
        break;
      case 'transformDragMove':
        engine?.updateTransformDrag(msg.x, msg.y, msg.constrain, msg.fromCentre);
        break;
      case 'transformDragEnd':
        if (!engine) break;
        engine.endTransformDrag();
        if (!engine.transformActive) {
          post({ t: 'transform', active: false });
          post({ t: 'doc', doc: engine.summary() });
        }
        break;
      case 'commitTransform':
        engine?.commitTransform((msg.method ?? 'bicubic') as never);
        post({ t: 'transform', active: false });
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'cancelTransform':
        engine?.cancelTransform();
        post({ t: 'transform', active: false });
        break;
      case 'nudge':
        engine?.nudge(msg.dx, msg.dy);
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'clipboard': {
        if (!engine) break;
        switch (msg.op) {
          case 'copy': engine.copy(false); break;
          case 'copyMerged': engine.copy(true); break;
          case 'cut': engine.cut(); break;
          case 'paste': engine.paste('normal'); break;
          case 'pasteInPlace': engine.paste('inPlace'); break;
          case 'pasteInto': engine.paste('into'); break;
          case 'pasteOutside': engine.paste('outside'); break;
        }
        post({ t: 'doc', doc: engine.summary() });
        break;
      }
      case 'bucket':
        engine?.bucketAt(msg.x, msg.y, msg.color, msg.mode as never, msg.opacity);
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'gradient':
        engine?.drawGradient({
          gradient: msg.gradient,
          style: msg.style as never,
          from: msg.from,
          to: msg.to,
          reverse: msg.reverse,
          dither: msg.dither,
          mode: msg.mode as never,
          opacity: msg.opacity,
        });
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'beginCrop':
        engine?.beginCrop();
        post({ t: 'transform', active: true });
        break;
      case 'setCropRect':
        engine?.setCropRect(msg.x0, msg.y0, msg.x1, msg.y1);
        break;
      case 'commitCrop':
        engine?.commitCrop();
        post({ t: 'transform', active: false });
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'cancelCrop':
        engine?.cancelCrop();
        post({ t: 'transform', active: false });
        break;
      case 'cropToSelection':
        engine?.cropToSelection();
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'setCropDeletes':
        if (engine) engine.cropDeletesPixels = msg.on;
        break;
      case 'setQuickMask':
        engine?.setQuickMask(msg.on);
        break;
      case 'cancelSelect':
        engine?.cancelSelect();
        break;
      case 'magicWand':
        engine?.magicWandAt(msg.x, msg.y, msg.op as never);
        if (engine) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'setSelectOptions':
        engine?.setSelectOptions(msg);
        break;
      case 'selectCommand': {
        if (!engine) break;
        switch (msg.command) {
          case 'all': engine.selectAllPixels(); break;
          case 'deselect': engine.deselect(); break;
          case 'inverse': engine.invertSelectionCmd(); break;
          case 'feather': engine.modifySelection('feather', msg.amount ?? 1); break;
          case 'expand': engine.modifySelection('expand', msg.amount ?? 1); break;
          case 'contract': engine.modifySelection('contract', msg.amount ?? 1); break;
          case 'border': engine.modifySelection('border', msg.amount ?? 1); break;
          case 'smooth': engine.modifySelection('smooth', msg.amount ?? 1); break;
          case 'grow': engine.growSelection(false); break;
          case 'similar': engine.growSelection(true); break;
        }
        post({ t: 'doc', doc: engine.summary() });
        break;
      }
      case 'undo':
        if (engine?.undo()) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'redo':
        if (engine?.redo()) post({ t: 'doc', doc: engine.summary() });
        break;
      case 'placeBitmap':
        engine?.placeBitmap(msg.bitmap, msg.name);
        if (engine) post({ t: 'doc', doc: engine.summary() });
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
        engine?.beginStroke(msg.brush, msg.color, msg.mode as never);
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
