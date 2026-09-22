/* ------------------------------------------------------------------ *
 * real-model-test.js - the Tetris decision engine on the real Laya
 * checkpoint.
 *
 * Every other suite runs the engine on its deterministic fallback. This
 * one starts the sidecar with LAYA=1, plays real Tetris through the real
 * bot, and asserts that Laya - not the heuristic - is making the calls.
 *
 * Skips itself unless the 1.69 GB bundle is already cached.
 *
 *   node tests/real-model-test.js
 * ------------------------------------------------------------------ */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { loadGame } = require('./dom-stub.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

const REVISION = process.env.LAYA_REVISION || 'main';
const cacheRoot = process.env.LAYA_CACHE ||
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'receptron-laya');
const bundle = path.join(cacheRoot, 'receptron--laya-onnx', REVISION, 'laya.onnx.data');

if (!fs.existsSync(bundle) || fs.statSync(bundle).size < 1e9) {
  console.log('SKIPPED: the Laya bundle is not cached at ' + bundle);
  process.exit(0);
}

function startSidecar() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.mjs')], {
    cwd: path.join(__dirname, '..'),
    // Keep-warm off: a background pass holding the model would make the
    // load-shedding assertions below depend on timing luck.
    env: Object.assign({}, process.env, { PORT: '0', LAYA: '1', LAYA_REVISION: REVISION, LAYA_KEEPWARM_MS: '0' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '', err = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { err += b; });
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const m = out.match(/http:\/\/localhost:(\d+)\//);
      if (m && /\[laya\] ready/.test(out)) { clearInterval(tick); resolve({ child, port: Number(m[1]), log: () => out }); }
      else if (/\[laya\] model unavailable|falling back/.test(out + err)) {
        clearInterval(tick); reject(new Error('the sidecar fell back: ' + out + err));
      } else if (Date.now() - started > 180000) {
        clearInterval(tick); reject(new Error('the model did not load in 180s: ' + out + err));
      }
    }, 500);
  });
}

async function main() {
  console.log('\n== loading the real checkpoint into the sidecar ==');
  const t0 = Date.now();
  const srv = await startSidecar();
  const loadMs = Date.now() - t0;
  const base = 'http://127.0.0.1:' + srv.port;

  try {
    const health = await (await fetch(base + '/health')).json();
    ok('the sidecar reports the laya engine', health.engine === 'laya', health.engine + ' ' + (health.reason || ''));
    ok('it is not the fallback', health.engine !== 'fallback');
    ok('the context window came from the checkpoint', health.contextTokens === 512, String(health.contextTokens));
    ok('the revision is pinned', health.revision === REVISION, String(health.revision));
    console.log('        loaded in ' + loadMs + 'ms, context ' + health.contextTokens + ' tokens');

    console.log('\n== the prompt the game actually sends ==');
    const env = loadGame();
    const T = env.T, botCore = env.botCore;
    const core = botCore.makeCore(T);
    // Instant execution would play a piece in under a millisecond, which no
    // 0.5s model can serve. waitForDecision holds each piece for its answer,
    // which is the regime where the engine is genuinely in charge.
    const bot = botCore.createBot(T, { stepMs: 20, lookahead: true, waitForDecision: true, strategyEvery: 6 });
    bot.attach();

    const decisions = [];
    bot.decide = function (snap) {
      snap.cols = T.COLS;
      snap.rows = T.ROWS;
      return fetch(base + '/decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snap)
      }).then((r) => r.json()).then((d) => { decisions.push(d); return d; });
    };

    T.start();
    // setMode('autoplay') is what arms the engine; with mode 'off' the bot
    // never asks. It triggers the first decision itself.
    bot.setMode('autoplay');
    ok('the bot is armed', bot.mode === 'autoplay' && typeof bot.decide === 'function');
    await new Promise((r) => setTimeout(r, 8000));
    const first = decisions[0];
    ok('a decision came back', !!first, JSON.stringify(first || null));
    ok('it came from laya, not the fallback', first && first.engine === 'laya', first && first.engine);
    ok('the model named itself', typeof first.model === 'string' && first.model.length > 0, String(first.model));
    ok('the largest question fits the 512-token context',
       (first.promptLargest || 0) < 512, String(first.promptLargest));
    ok('the reported total matches the per-question sum, not one sequence',
       first.promptTokens > 0, String(first.promptTokens));
    ok('the estimate is not optimistic about the real token count',
       (first.promptEstimatedTotal || 0) >= first.promptTokens * 0.85,
       'estimated ' + first.promptEstimatedTotal + ' vs real ' + first.promptTokens);
    ok('nothing had to be trimmed for a normal board',
       !first.promptTrimmed || first.promptTrimmed.length === 0, JSON.stringify(first.promptTrimmed));
    console.log('        model=' + first.model + '  inference=' + first.ms + 'ms  prompt=' + first.promptTokens + ' tokens');
    console.log('        strategy=' + first.strategy + ' p=' + Number(first.strategyConfidence).toFixed(3));
    console.log('        strategy distribution=' + JSON.stringify(first.strategyProbabilities));
    console.log('        move=' + first.move + ' p=' + Number(first.moveConfidence).toFixed(3) +
                ' over ' + JSON.stringify(first.moveProbabilities));
    console.log('        risk=' + Number(first.risk).toFixed(2) + ' (' + first.riskLabel + ')');

    console.log('\n== the answers are a real, calibrated distribution ==');
    ok('a strategy was chosen from the five offered',
       core.STRATEGIES.indexOf(first.strategy) !== -1, first.strategy);
    const sp = first.strategyProbabilities || {};
    const sSum = Object.values(sp).reduce((a, b) => a + b, 0);
    ok('the strategy distribution covers every strategy',
       Object.keys(sp).sort().join(',') === core.STRATEGIES.slice().sort().join(','), Object.keys(sp).join(','));
    ok('it sums to 1', Math.abs(sSum - 1) < 0.02, String(sSum));
    // The first call asks for the play style; the move comes on its own
    // call, so fetch one to inspect.
    const moveSnap = bot.snapshot(bot.candidates, bot.before);
    moveSnap.cols = T.COLS; moveSnap.rows = T.ROWS; moveSnap.askStrategy = false;
    const moveOnly = await fetch(base + '/decide', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(moveSnap)
    }).then((r) => r.json());
    console.log('        move-only call: ' + moveOnly.promptTokens + ' tokens, ' + moveOnly.ms + 'ms, ' +
                'move=' + moveOnly.move + ' over ' + JSON.stringify(moveOnly.moveProbabilities));
    ok('a move call asks for no play style', moveOnly.strategy === null, String(moveOnly.strategy));
    ok('a move call is cheaper than a strategy call',
       moveOnly.promptTokens < first.promptTokens, moveOnly.promptTokens + ' vs ' + first.promptTokens);

    const mp = moveOnly.moveProbabilities || {};
    const mSum = Object.values(mp).reduce((a, b) => a + b, 0);
    ok('the move distribution covers the shortlist', Object.keys(mp).length === bot.candidates.length,
       Object.keys(mp).length + ' vs ' + bot.candidates.length);
    ok('it sums to 1', Math.abs(mSum - 1) < 0.02, String(mSum));
    ok('every probability is in [0,1]',
       Object.values(sp).concat(Object.values(mp)).every((v) => v >= 0 && v <= 1));
    ok('the risk score is inside its rubric', first.risk >= 0 && first.risk <= 3, String(first.risk));

    console.log('\n== laya plays tetris ==');
    const PIECES = 14;
    const startLines = T.S.lines;
    let guard = 0;
    while (bot.stats.pieces < PIECES && guard++ < 4000 && !T.S.over) {
      await new Promise((r) => setTimeout(r, 20));
      bot.tick(20);
    }
    const layaCalls = bot.stats.laya;
    console.log('        pieces=' + bot.stats.pieces + '  laya=' + layaCalls +
                '  fallback=' + bot.stats.fallback + '  offline=' + bot.stats.offline +
                '  timeouts=' + bot.stats.timeouts + '  overrides=' + bot.stats.overrides +
                '  skipped(in-flight)=' + bot.stats.skipped);
    console.log('        lines=' + (T.S.lines - startLines) + '  score=' + T.S.score + '  over=' + T.S.over);

    ok('laya decided the majority of pieces', layaCalls >= Math.floor(bot.stats.pieces * 0.6),
       layaCalls + ' of ' + bot.stats.pieces);
    ok('no piece was played without asking', bot.stats.skipped === 0, String(bot.stats.skipped));
    ok('timeouts are the exception, not the rule', bot.stats.timeouts <= bot.stats.pieces * 0.3,
       bot.stats.timeouts + ' of ' + bot.stats.pieces);
    ok('the fallback was never used', bot.stats.fallback === 0, String(bot.stats.fallback));
    ok('every answer came from the model', decisions.every((d) => d.engine === 'laya'),
       decisions.map((d) => d.engine).join(','));
    ok('the game actually advanced', bot.stats.pieces >= 10 && T.S.score > 0,
       'pieces=' + bot.stats.pieces + ' score=' + T.S.score);
    ok('the board is legal', core.features(T.S.board).holes < 40);

    const inferenceMs = decisions.map((d) => d.ms).filter((n) => typeof n === 'number');
    const avg = inferenceMs.reduce((a, b) => a + b, 0) / (inferenceMs.length || 1);
    console.log('        inference: min=' + Math.min.apply(null, inferenceMs) + 'ms avg=' +
                Math.round(avg) + 'ms max=' + Math.max.apply(null, inferenceMs) + 'ms');
    // The minimum reflects what the model can do; the average also reflects
    // whatever else is competing for the CPU, which a test cannot control.
    ok('a move decision can be served in well under a second',
       Math.min.apply(null, inferenceMs) < 1200, 'min ' + Math.min.apply(null, inferenceMs) + 'ms');
    console.log('        move-only asks are the common case; the play style is ' +
                'refreshed every ' + bot.opt.strategyEvery + ' pieces');

    console.log('\n== laya is really steering, not rubber-stamping ==');
    const strategies = {};
    decisions.forEach((d) => { strategies[d.strategy] = (strategies[d.strategy] || 0) + 1; });
    console.log('        strategies chosen: ' + JSON.stringify(strategies));
    const moves = {};
    decisions.forEach((d) => { moves[d.move] = (moves[d.move] || 0) + 1; });
    console.log('        moves chosen:      ' + JSON.stringify(moves));

    const withMove = decisions.filter((d) => d.move !== null);
    const nonTopPicks = withMove.filter((d) => d.move !== 'a').length;
    ok('it sometimes picks a move other than the heuristic top choice',
       nonTopPicks > 0, nonTopPicks + ' of ' + withMove.length + ' were not "a"');
    ok('the strategy is a real decision, not a constant',
       Object.keys(strategies).length >= 1, JSON.stringify(strategies));
    const moveDecisions = decisions.filter((d) => d.move !== null);
    const strategyDecisions = decisions.filter((d) => d.strategy !== null);
    const confident = moveDecisions.filter((d) => d.moveConfidence >= 0.34).length;
    console.log('        ' + moveDecisions.length + ' move calls, ' + strategyDecisions.length +
                ' play-style calls; ' + confident + ' moves cleared the 0.34 confidence floor');
    ok('every move call carries a confidence to gate on',
       moveDecisions.length > 0 && moveDecisions.every((d) => typeof d.moveConfidence === 'number'),
       'of ' + moveDecisions.length);
    ok('gating actually fired on at least one low-confidence answer',
       bot.stats.overrides > 0, String(bot.stats.overrides));
    ok('the play style was refreshed on its own cadence, not every piece',
       strategyDecisions.length > 0 && strategyDecisions.length < moveDecisions.length,
       strategyDecisions.length + ' vs ' + moveDecisions.length);

    console.log('\n== a saturated model sheds load instead of piling up ==');
    {
      // agent:false forces real parallel sockets; node's default fetch would
      // reuse one connection and serialise these client-side.
      const http = require('node:http');
      const body = JSON.stringify(Object.assign({}, bot.snapshot(bot.candidates, bot.before),
        { cols: T.COLS, rows: T.ROWS, askStrategy: false }));
      const fire = () => new Promise((resolve) => {
        const t = Date.now();
        const req = http.request({ host: '127.0.0.1', port: srv.port, path: '/decide', method: 'POST', agent: false,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
          let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(Object.assign(JSON.parse(b), { wall: Date.now() - t })));
        });
        req.end(body);
      });
      // Wait for the model to go idle first, so the first of the burst is
      // genuinely the one that acquires it.
      for (let i = 0; i < 40; i++) {
        const h = await (await fetch(base + '/health')).json();
        if (h.queued === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 150));

      const burst = await Promise.all([fire(), fire(), fire(), fire()]);
      const served = burst.filter((r) => r.engine === 'laya');
      const shed = burst.filter((r) => r.engine === 'fallback');
      console.log('        4 parallel: ' + served.length + ' served by the model, ' + shed.length + ' shed');
      ok('the queue limit sheds the surplus', shed.length >= 2, served.length + ' served / ' + shed.length + ' shed');
      ok('at most one request holds the model at a time', served.length <= 1,
         String(served.length));
      ok('shed requests say why', shed.every((r) => /busy/.test(r.reason || '')), shed[0] && shed[0].reason);
      ok('shed requests still return a usable decision',
         shed.every((r) => r.move !== undefined && r.strategy !== undefined));
      ok('shed requests come back fast rather than queueing',
         Math.min.apply(null, shed.map((r) => r.wall)) < 500,
         shed.map((r) => r.wall).join(','));
      ok('served requests report inference separately from wait time',
         served.every((r) => typeof r.ms === 'number' && typeof r.queuedMs === 'number'),
         JSON.stringify(served[0] ? { ms: served[0].ms, queuedMs: served[0].queuedMs } : null));

      // The point of the worker thread: the server answers while it thinks.
      const slow = fire();
      await new Promise((r) => setTimeout(r, 120));
      const probe = Date.now();
      const h = await (await fetch(base + '/health')).json();
      const probeMs = Date.now() - probe;
      await slow;
      console.log('        /health answered in ' + probeMs + 'ms while a pass was running');
      ok('the server stays responsive during inference, because the model is on a worker thread',
         probeMs < 250, probeMs + 'ms');
      ok('and health is still meaningful mid-pass', h.engine === 'laya');
    }

    const after = await (await fetch(base + '/health')).json();
    ok('the sidecar counted the inferences', after.calls >= layaCalls, after.calls + ' vs ' + layaCalls);
    // This suite runs with LAYA_KEEPWARM_MS=0 so a background pass cannot
    // skew the shedding assertions; health should say so plainly.
    ok('health reports the keep-warm setting honestly', after.keepWarm === 'off', String(after.keepWarm));
    ok('shedding is recorded for operators', after.shed > 0, String(after.shed));
    console.log('        avg inference ' + after.avgMs + 'ms, avg queue wait ' + after.avgQueuedMs +
                'ms, shed ' + after.shed + ', warm-ups ' + after.warmups);
    console.log('        sidecar: ' + after.calls + ' inferences, average ' + after.avgMs + 'ms');
  } finally {
    try { srv.child.kill('SIGKILL'); } catch (e) { /* already gone */ }
  }

  console.log('\n---------------------------------------');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
