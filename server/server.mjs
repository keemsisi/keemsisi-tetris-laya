/* ------------------------------------------------------------------ *
 * server.mjs - the Laya sidecar.
 *
 * Laya runs on ONNX Runtime in Node and its weights are ~1.7 GB, so it
 * cannot run in the browser. This process holds the model, serves the
 * game's static files, and exposes one endpoint the game calls once per
 * piece:
 *
 *   GET  /health  -> which engine is live
 *   POST /decide  -> { ...board snapshot } -> a typed decision
 *
 * Start in fallback mode (no model, deterministic rules):
 *   node server/server.mjs
 * Start with the real model (downloads ~1.7 GB on first run):
 *   LAYA=1 node server/server.mjs
 * ------------------------------------------------------------------ */

import http from 'node:http';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildState, buildQuestions, buildPrompt, normalize, fallbackDecision, TOKEN_BUDGET } from './decide.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.PORT || 8787);
// Loopback only by default: the sidecar answers with no authentication, so
// it should not be reachable from the network unless that is asked for.
const HOST = process.env.HOST || '127.0.0.1';
const WANT_LAYA = process.env.LAYA === '1' || process.argv.includes('--laya');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon'
};

/* ------------------------------- model ---------------------------- */

const engine = {
  state: WANT_LAYA ? 'loading' : 'fallback',   // loading | laya | fallback
  laya: null,
  modelDir: null,
  maxLen: null,
  modelName: null,
  reason: WANT_LAYA ? null : 'started without LAYA=1, using deterministic rules',
  loadMs: 0,
  calls: 0,
  totalMs: 0,
  totalQueuedMs: 0,
  shed: 0,
  abandoned: 0,
  warmups: 0,
  lastWarmMs: 0,
  warmIdle: false
};

// The worker owns the model; this thread only sends it work.
let worker = null;
let nextId = 1;
const pending = new Map();

function callWorker(state, questions) {
  return new Promise(function (resolve, reject) {
    if (!worker) return reject(new Error('the model worker is not running'));
    const id = nextId++;
    pending.set(id, { resolve: resolve, reject: reject });
    worker.postMessage({ type: 'infer', id: id, state: state, questions: questions });
  });
}

async function loadLaya() {
  const t0 = Date.now();
  engine.cacheDir = process.env.LAYA_MODEL_DIR || process.env.LAYA_CACHE || '~/.cache/receptron-laya';
  console.log('[laya] loading weights from ' + engine.cacheDir + ' (on a worker thread)');
  console.log('[laya] first run downloads ~1.7 GB (receptron/laya-onnx) and needs ~2 GB RAM');

  await new Promise(function (resolve) {
    worker = new Worker(new URL('./laya-worker.mjs', import.meta.url));
    let lastLog = 0;

    worker.on('message', function (msg) {
      if (msg.type === 'progress') {
        const now = Date.now();
        if (now - lastLog < 2000) return;              // one line every 2s, not per chunk
        lastLog = now;
        const pct = msg.total ? ' ' + Math.round((msg.received / msg.total) * 100) + '%' : '';
        console.log('[laya] downloading ' + msg.file + pct);
        return;
      }
      if (msg.type === 'loaded') {
        engine.state = 'laya';
        engine.loadMs = Date.now() - t0;
        engine.maxLen = msg.maxLen;
        engine.modelDir = msg.modelDir || engine.cacheDir;
        engine.reason = null;
        scheduleWarm();
        console.log('[laya] ready in ' + engine.loadMs + 'ms (context ' + engine.maxLen + ' tokens)');
        return resolve();
      }
      if (msg.type === 'loadError') {
        engine.state = 'fallback';
        engine.reason = 'model unavailable: ' + msg.error;
        console.error('[laya] ' + engine.reason);
        console.error('[laya] falling back to deterministic rules. Install with: cd server && npm install');
        return resolve();
      }
      if (msg.type === 'result' || msg.type === 'error') {
        const p = pending.get(msg.id);
        if (!p) return;                                // the caller already gave up
        pending.delete(msg.id);
        if (msg.type === 'result') p.resolve(msg.result);
        else p.reject(new Error(msg.error));
      }
    });

    worker.on('error', function (err) {
      engine.state = 'fallback';
      engine.reason = 'model worker crashed: ' + err.message;
      console.error('[laya] ' + engine.reason);
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      resolve();
    });

    worker.postMessage({
      type: 'load',
      modelDir: process.env.LAYA_MODEL_DIR || null,
      cacheDir: process.env.LAYA_CACHE || null,
      // Pin to a published commit: the loader size-checks cached files but
      // never checksums them, so "main" would float under us.
      revision: process.env.LAYA_REVISION || null
    });
  });
}

// One model, one forward pass at a time: ONNX holds a single session, and
// serialising keeps memory predictable.
let chain = Promise.resolve();
let queued = 0;
// How many callers may wait for the lock. A game asks once per piece, so a
// backlog means the model is already behind; queueing more only makes every
// answer later than the last. Shed instead.
const MAX_QUEUE = Number(process.env.LAYA_MAX_QUEUE || 1);

/**
 * Keeping the weights resident.
 *
 * Every forward pass touches all 400M parameters, so when the model sits
 * idle the OS compresses or evicts those pages and the next call pays to
 * fault them back in. Measured on this machine: ~730ms warm, ~2200ms after
 * sixty seconds of idling. A tiny periodic pass keeps them hot.
 *
 * It stops itself after a few idle rounds so an unused server does not burn
 * a core forever; the next real request starts it again.
 */
const KEEPWARM_MS = Number(process.env.LAYA_KEEPWARM_MS || 20000);
const KEEPWARM_ROUNDS = Number(process.env.LAYA_KEEPWARM_ROUNDS || 9);
let warmTimer = null;
let warmStreak = 0;

function scheduleWarm() {
  if (!KEEPWARM_MS || engine.state !== 'laya') return;
  clearTimeout(warmTimer);
  warmTimer = setTimeout(runWarm, KEEPWARM_MS);
  if (warmTimer.unref) warmTimer.unref();
}

async function runWarm() {
  if (engine.state !== 'laya' || !worker) return;
  if (queued > 0) { scheduleWarm(); return; }        // real work is keeping it hot
  if (warmStreak >= KEEPWARM_ROUNDS) {               // nobody is playing; go quiet
    engine.warmIdle = true;
    return;
  }
  warmStreak++;
  const t = Date.now();
  try {
    await serialize(function () {
      return callWorker(
        { s: 'idle' },
        { warm: { type: 'choice', instructions: 'keep resident', criteria: { a: 'one', b: 'two' } } }
      );
    });
    engine.warmups++;
    engine.lastWarmMs = Date.now() - t;
  } catch (e) { /* a failed warm-up is not worth reporting */ }
  scheduleWarm();
}

function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(function () {});
  return run;
}

/**
 * `arrivedAt` is stamped when the request lands, not when this function
 * runs. A forward pass saturates the CPU and starves the event loop, so a
 * request can sit unparsed at the socket for seconds - invisible to any
 * counter kept inside this function. Measuring from arrival is the only
 * figure that reflects what the caller actually experienced.
 */
async function decide(snap, isAlive, arrivedAt) {
  if (engine.state !== 'laya' || !worker) {
    return fallbackDecision(snap, {
      engine: 'fallback',
      reason: engine.state === 'loading' ? 'model still loading' : engine.reason
    });
  }

  // Already behind: answer now from the deterministic rules rather than
  // joining a queue whose answers will all arrive too late to be used.
  if (queued >= MAX_QUEUE) {
    engine.shed++;
    return fallbackDecision(snap, {
      engine: 'fallback',
      reason: 'model busy (' + queued + ' already waiting); answered from the rules instead'
    });
  }

  // Real traffic is the best warm-up, and it means someone is playing.
  warmStreak = 0;
  engine.warmIdle = false;
  scheduleWarm();

  const prompt = buildPrompt(snap);
  const queuedAt = arrivedAt || Date.now();
  let queuedMs = 0;
  queued++;
  try {
    const raw = await serialize(function () {
      queuedMs = Date.now() - queuedAt;
      // The caller may have given up while we waited for the lock. Running
      // the pass anyway would hold the model hostage for the next caller.
      if (isAlive && !isAlive()) {
        const e = new Error('caller went away after ' + queuedMs + 'ms in the queue');
        e.abandoned = true;
        throw e;
      }
      return callWorker(prompt.state, prompt.questions);
    });
    // Inference only: queue wait is reported separately so a backlog cannot
    // masquerade as a slow model, and callers can tune on the real figure.
    const ms = Date.now() - queuedAt - queuedMs;
    engine.calls++;
    engine.totalMs += ms;
    engine.totalQueuedMs += queuedMs;
    if (raw && typeof raw.model === 'string') engine.modelName = raw.model;
    const d = normalize(raw, snap, { engine: 'laya', ms: ms, model: raw?.model });
    d.queuedMs = queuedMs;
    d.promptTokens = raw?.usage?.input_tokens || prompt.estimatedTotal;
    d.promptLargest = prompt.tokens;              // the context-limited figure
    d.promptEstimatedTotal = prompt.estimatedTotal;
    d.promptTrimmed = prompt.trimmed;
    return d;
  } catch (err) {
    if (err && err.abandoned) {
      engine.abandoned++;
      return fallbackDecision(snap, { engine: 'fallback', reason: err.message });
    }
    return fallbackDecision(snap, {
      engine: 'fallback',
      ms: Date.now() - queuedAt,
      reason: 'inference failed: ' + (err && err.message ? err.message : String(err))
    });
  } finally {
    queued--;
  }
}

/* ------------------------------- http ----------------------------- */

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  cors(res);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

async function readBody(req, limit) {
  const cap = limit || 256 * 1024;
  let size = 0;
  const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) throw new Error('payload too large');
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString('utf8');
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const full = path.resolve(ROOT, rel);
  if (!full.startsWith(ROOT + path.sep) && full !== path.join(ROOT, 'index.html')) {
    return json(res, 403, { error: 'forbidden' });
  }
  try {
    const data = await fs.readFile(full);
    cors(res);
    res.writeHead(200, {
      'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-cache'
    });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found', path: rel });
  }
}

const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  if (url.pathname === '/health') {
    return json(res, 200, {
      engine: engine.state,
      model: engine.modelName || (engine.state === 'laya' ? 'convaiinnovations/laya (receptron/laya-onnx)' : null),
      revision: process.env.LAYA_REVISION || (engine.state === 'laya' ? 'main (unpinned)' : null),
      modelDir: engine.modelDir || null,
      contextTokens: engine.maxLen || null,
      reason: engine.reason,
      loadMs: engine.loadMs,
      calls: engine.calls,
      avgMs: engine.calls ? Math.round(engine.totalMs / engine.calls) : 0,
      avgQueuedMs: engine.calls ? Math.round(engine.totalQueuedMs / engine.calls) : 0,
      queued: queued,
      maxQueue: MAX_QUEUE,
      shed: engine.shed,
      abandoned: engine.abandoned,
      // Time from a request landing to its forward pass starting. Covers
      // event-loop starvation as well as waiting for the model lock.
      avgWaitMs: engine.calls ? Math.round(engine.totalQueuedMs / engine.calls) : 0,
      warmups: engine.warmups,
      lastWarmMs: engine.lastWarmMs,
      keepWarm: KEEPWARM_MS ? (engine.warmIdle ? 'idle (stopped)' : KEEPWARM_MS + 'ms') : 'off'
    });
  }

  if (url.pathname === '/decide') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    const arrivedAt = Date.now();
    try {
      const snap = JSON.parse(await readBody(req));
      if (!snap || typeof snap !== 'object' || !Array.isArray(snap.candidates)) {
        return json(res, 400, { error: 'expected a board snapshot with a candidates array' });
      }
      // Track whether the caller is still listening, so an abandoned request
      // does not tie up the model.
      let alive = true;
      res.on('close', function () { alive = false; });
      return json(res, 200, await decide(snap, function () { return alive; }, arrivedAt));
    } catch (err) {
      return json(res, 400, { error: String(err && err.message ? err.message : err) });
    }
  }

  // Debug helper: see exactly what Laya is being asked.
  if (url.pathname === '/prompt') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    try {
      const snap = JSON.parse(await readBody(req));
      const p = buildPrompt(snap);
      return json(res, 200, {
        state: p.state, questions: p.questions,
        estimatedTokens: p.tokens, budget: TOKEN_BUDGET, trimmed: p.trimmed
      });
    } catch (err) {
      return json(res, 400, { error: String(err && err.message ? err.message : err) });
    }
  }

  if (req.method === 'GET') return serveStatic(req, res, url.pathname);
  return json(res, 404, { error: 'not found' });
});

// A bound port used to kill the process with no explanation; say so instead.
server.on('error', function (err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error('[server] port ' + PORT + ' is already in use.');
    console.error('[server] pick another with: PORT=8788 node server/server.mjs');
  } else {
    console.error('[server] ' + (err && err.message ? err.message : String(err)));
  }
  process.exit(1);
});

// PORT=0 asks the OS for a free port, so report what we actually got.
server.listen(PORT, HOST, function () {
  const addr = server.address();
  const loopback = addr.address === '127.0.0.1' || addr.address === '::1';
  console.log('Tetris + Laya decision engine');
  console.log('  game    http://localhost:' + addr.port + '/');
  console.log('  health  http://localhost:' + addr.port + '/health');
  console.log('  bound   ' + addr.address + ':' + addr.port +
              (loopback ? ' (this machine only)' : ' (REACHABLE FROM THE NETWORK)'));
  console.log('  engine  ' + (WANT_LAYA ? 'laya (loading)' : 'fallback (run with LAYA=1 for the real model)'));
  if (!loopback) {
    console.warn('  warning: /decide has no authentication; bound beyond loopback by HOST=' + HOST);
  }
  if (WANT_LAYA) loadLaya();
});

process.on('SIGINT', async function () {
  try { if (worker) await worker.terminate(); } catch {}
  process.exit(0);
});
