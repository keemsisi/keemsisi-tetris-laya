/**
 * The model, on its own thread.
 *
 * onnxruntime-node's forward pass blocks the thread it runs on for its whole
 * duration - measured here at 2-4s, during which a single-threaded server
 * cannot accept a connection, answer /health, or notice that a caller has
 * given up. Running it in a worker keeps the HTTP thread responsive, which
 * is what makes queueing, shedding and abandonment detection work at all.
 */
import { parentPort } from 'node:worker_threads';

let laya = null;

parentPort.on('message', async function (msg) {
  if (msg.type === 'load') {
    try {
      const mod = await import('@receptron/laya');
      const Laya = mod.Laya;
      if (!Laya || typeof Laya.load !== 'function') throw new Error('@receptron/laya did not export Laya.load()');
      laya = await Laya.load({
        modelDir: msg.modelDir || undefined,
        cacheDir: msg.cacheDir || undefined,
        revision: msg.revision || undefined,
        onProgress: function (p) { parentPort.postMessage({ type: 'progress', file: p.file, received: p.received, total: p.total }); }
      });
      parentPort.postMessage({
        type: 'loaded',
        maxLen: laya.config ? laya.config.max_len : null,
        modelDir: laya.modelDir || null
      });
    } catch (err) {
      parentPort.postMessage({ type: 'loadError', error: err && err.message ? err.message : String(err) });
    }
    return;
  }

  if (msg.type === 'infer') {
    if (!laya) {
      parentPort.postMessage({ type: 'error', id: msg.id, error: 'the model is not loaded' });
      return;
    }
    const started = Date.now();
    try {
      const result = await laya.systemOne(msg.state, msg.questions);
      parentPort.postMessage({ type: 'result', id: msg.id, result: result, ms: Date.now() - started });
    } catch (err) {
      parentPort.postMessage({ type: 'error', id: msg.id, error: err && err.message ? err.message : String(err) });
    }
    return;
  }

  if (msg.type === 'close') {
    try { if (laya && laya.close) await laya.close(); } catch (e) { /* shutting down anyway */ }
    parentPort.postMessage({ type: 'closed' });
  }
});
