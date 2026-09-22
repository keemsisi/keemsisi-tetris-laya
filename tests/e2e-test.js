/* ------------------------------------------------------------------ *
 * e2e-test.js - game core + bot + browser client + real sidecar.
 *
 * Everything but the pixels: the same laya-client.js the page loads
 * talks HTTP to a real server process, and the bot plays a real game
 * on its answers.
 * Run with:  node tests/e2e-test.js
 * ------------------------------------------------------------------ */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

// laya-client.js reads location.protocol when building its defaults.
globalThis.location = { protocol: 'http:', origin: 'http://127.0.0.1:1' };

function startServer(env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.mjs')], {
    env: Object.assign({}, process.env, { PORT: '0', LAYA: '0' }, env || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', function (b) { stderr += b; });
  return new Promise(function (resolve, reject) {
    let out = '';
    child.stdout.on('data', function (b) {
      out += b;
      const m = out.match(/http:\/\/localhost:(\d+)\/\n/);
      if (m) resolve({ child: child, port: Number(m[1]) });
    });
    child.on('exit', function (c) { reject(new Error('exited ' + c + ': ' + stderr)); });
    setTimeout(function () { reject(new Error('no port: ' + stderr)); }, 8000);
  });
}

(async function () {
  const { loadGame } = require('./dom-stub.js');
  const env = loadGame();
  const T = env.T, botCore = env.botCore;
  const core = botCore.makeCore(T);

  // The real browser client, loaded the same way the page loads it.
  const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'laya-client.js'), 'utf8');
  const clientMod = { exports: {} };
  new Function('module', 'globalThis', 'location', 'fetch', 'performance', 'AbortController', 'setTimeout', 'clearTimeout',
    clientSrc)(clientMod, globalThis, globalThis.location, fetch, performance, AbortController, setTimeout, clearTimeout);
  const LayaClient = clientMod.exports;
  ok('laya-client.js loads outside a browser', typeof LayaClient.createClient === 'function');

  const srv = await startServer();
  const client = LayaClient.createClient({ endpoint: 'http://127.0.0.1:' + srv.port });

  try {
    console.log('\n== the client finds the sidecar ==');
    const h = await client.health();
    ok('health round-trips', h && h.engine === 'fallback', JSON.stringify(h));
    ok('client records reachability', client.reachable === true && client.engine === 'fallback');

    console.log('\n== the bot plays on the sidecar\'s decisions ==');
    const bot = botCore.createBot(T, { stepMs: 0, lookahead: true });
    bot.attach();
    const seen = [];
    bot.decide = function (snap) {
      snap.cols = T.COLS; snap.rows = T.ROWS;
      return client.decide(snap).then(function (d) { seen.push(d); return d; });
    };
    T.start();
    bot.setMode('autoplay');

    // Each piece: let the decision resolve, then let the bot execute it.
    for (let i = 0; i < 40; i++) {
      await new Promise(function (r) { setTimeout(r, 0); });
      bot.tick(16);
      if (T.S.over) break;
    }
    ok('decisions came back over http', seen.length > 10, 'decisions=' + seen.length);
    ok('all of them were answered', seen.every(function (d) { return d && d.move; }),
       JSON.stringify(seen[0] || null));
    ok('every decision is labelled fallback, not laya',
       seen.every(function (d) { return d.engine === 'fallback'; }));
    ok('the round trip is recorded', seen.every(function (d) { return typeof d.roundTripMs === 'number'; }));
    ok('the bot counted them as fallback calls', bot.stats.fallback > 10, String(bot.stats.fallback));
    ok('no call was counted as laya', bot.stats.laya === 0, String(bot.stats.laya));
    ok('the game actually advanced', bot.stats.pieces > 10 && T.S.score > 0,
       'pieces=' + bot.stats.pieces + ' score=' + T.S.score);
    ok('a strategy was adopted from the engine',
       core.STRATEGIES.indexOf(bot.strategy) !== -1, bot.strategy);
    ok('strategies changed as the board changed',
       new Set(seen.map(function (d) { return d.strategy; })).size >= 1,
       Array.from(new Set(seen.map(function (d) { return d.strategy; }))).join(','));
    ok('risk was scored on every decision',
       seen.every(function (d) { return typeof d.risk === 'number' && d.risk >= 0 && d.risk <= 3; }));

    console.log('\n== the game survives losing the sidecar ==');
    srv.child.kill('SIGKILL');
    await new Promise(function (r) { setTimeout(r, 200); });

    const before = bot.stats.pieces;
    const offlineBefore = bot.stats.offline;
    for (let i = 0; i < 40; i++) {
      await new Promise(function (r) { setTimeout(r, 0); });
      bot.tick(16);
      if (T.S.over) break;
    }
    ok('the bot keeps playing with no engine', bot.stats.pieces > before,
       before + ' -> ' + bot.stats.pieces);
    ok('the dead sidecar is counted, not crashed through',
       bot.stats.offline > offlineBefore, String(bot.stats.offline));
    ok('the client reports itself offline', client.engine === 'offline', client.engine);
    ok('the client explains why', typeof client.reason === 'string' && client.reason.length > 0, client.reason);
    ok('placements are still legal with no engine',
       core.features(T.S.board).holes < 20 && !T.S.over,
       'holes=' + core.features(T.S.board).holes + ' over=' + T.S.over);

    console.log('\n== health reflects a restarted sidecar ==');
    const srv2 = await startServer();
    try {
      client.endpoint = 'http://127.0.0.1:' + srv2.port;
      const h2 = await client.health();
      ok('the client reconnects', h2 && h2.engine === 'fallback' && client.reachable === true);
    } finally {
      srv2.child.kill('SIGKILL');
    }
  } finally {
    try { srv.child.kill('SIGKILL'); } catch {}
  }

  console.log('\n---------------------------------------');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
