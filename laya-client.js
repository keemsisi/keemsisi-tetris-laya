'use strict';

/* ------------------------------------------------------------------ *
 * laya-client.js - browser side of the decision engine.
 *
 * Laya's weights are ~1.7 GB and it runs on ONNX Runtime in Node, so
 * the page cannot host it. This talks to the sidecar in server/ over
 * one small POST per piece. Every failure path resolves to null rather
 * than throwing, so a missing or slow sidecar degrades the bot to its
 * own deterministic ranking instead of stalling the game.
 * ------------------------------------------------------------------ */

(function (root) {

  function createClient(cfg) {
    const opt = Object.assign({
      // Served by the sidecar itself? Then talk to the same origin.
      endpoint: (location.protocol === 'http:' || location.protocol === 'https:')
        ? location.origin
        : 'http://localhost:8787',
      // A safety net, not a policy: the caller's own deadline decides when
      // to stop waiting. Set below the model's latency this used to abort
      // every strategy call mid-flight while the server kept computing.
      timeoutMs: 20000
    }, cfg || {});

    const client = {
      endpoint: opt.endpoint,
      reachable: false,
      engine: 'offline',        // 'laya' | 'fallback' | 'offline'
      reason: 'not checked yet',
      lastMs: 0,
      inFlight: 0
    };

    function withTimeout(ms) {
      const c = new AbortController();
      const t = setTimeout(function () { c.abort(); }, ms);
      return { signal: c.signal, done: function () { clearTimeout(t); } };
    }

    client.health = function () {
      const to = withTimeout(1500);
      return fetch(client.endpoint + '/health', { signal: to.signal })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function (h) {
          to.done();
          client.reachable = true;
          client.engine = h.engine === 'laya' ? 'laya' : 'fallback';
          client.reason = h.reason || null;
          client.health_ = h;
          return h;
        })
        .catch(function (err) {
          to.done();
          client.reachable = false;
          client.engine = 'offline';
          client.reason = 'sidecar not reachable at ' + client.endpoint +
            ' (' + (err && err.name === 'AbortError' ? 'timed out' : (err && err.message) || 'error') + ')';
          return null;
        });
    };

    client.decide = function (snapshot) {
      const to = withTimeout(opt.timeoutMs);
      const t0 = performance.now();
      client.inFlight++;
      return fetch(client.endpoint + '/decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snapshot),
        signal: to.signal
      })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function (d) {
          to.done();
          client.inFlight--;
          client.lastMs = Math.round(performance.now() - t0);
          client.reachable = true;
          client.engine = d.engine === 'laya' ? 'laya' : 'fallback';
          client.reason = d.reason || null;
          d.roundTripMs = client.lastMs;
          return d;
        })
        .catch(function (err) {
          to.done();
          client.inFlight--;
          client.reachable = false;
          client.engine = 'offline';
          client.reason = err && err.name === 'AbortError' ? 'decision timed out' : String((err && err.message) || err);
          return null;     // the bot falls back to its own ranking
        });
    };

    return client;
  }

  const api = { createClient: createClient };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LayaClient = api;

})(typeof window !== 'undefined' ? window : globalThis);
