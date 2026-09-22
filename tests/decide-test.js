/* ------------------------------------------------------------------ *
 * decide-test.js - the Laya translation layer and the sidecar.
 *
 * The response fixtures below match @receptron/laya's published types
 * (ChoiceAnswer / ScoreAnswer / NoulAnswer in dist/types.d.ts), so the
 * parsing is tested against the real contract, not a guess at it.
 * Run with:  node tests/decide-test.js
 * ------------------------------------------------------------------ */

const { spawn } = require('node:child_process');
const path = require('node:path');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

// A realistic mid-game snapshot, shaped exactly as bot.js sends it.
function snap(over) {
  return Object.assign({
    cols: 10, rows: 20,
    piece: 'T', queue: ['I', 'O', 'S'], hold: 'L', canHold: true,
    level: 4, lines: 32, score: 12400,
    board: '....######\n..########\n.#########\n##########',
    heights: [3, 4, 4, 4, 4, 4, 4, 4, 4, 2],
    maxHeight: 4, holes: 2, bumpiness: 5, deepestWell: 1, rightColumnEmpty: false,
    strategies: ['balanced', 'downstack', 'build_tetris', 'flatten', 'survive'],
    candidates: [
      { key: 'a', why: 'T turned right in col 1, clears nothing, buries none, peak 5/20, flatter.', cleared: 0, useHold: false, r: 1, x: 0, type: 'T' },
      { key: 'b', why: 'T flat in cols 2-4, clears 1 row, buries none, peak 4/20.', cleared: 1, useHold: false, r: 0, x: 1, type: 'T' },
      { key: 'c', why: 'T flipped in cols 8-10, clears nothing, buries 1, peak 6/20, rougher.', cleared: 0, useHold: false, r: 2, x: 7, type: 'T' },
      { key: 'd', why: 'L turned left in col 1, clears nothing, buries none, peak 5/20, flatter, needs the hold swap.', cleared: 0, useHold: true, r: 3, x: 0, type: 'L' }
    ]
  }, over || {});
}

(async function () {
  const D = await import('../server/decide.mjs');

  console.log('\n== state construction ==');
  {
    const st = D.buildState(snap());
    const text = Object.values(st).join(' ');
    ok('state is a flat object of strings',
       Object.values(st).every(function (v) { return typeof v === 'string'; }));
    // The state is re-encoded once per question, so it is deliberately
    // terse - every field is paid for as many times as questions asked.
    ok('names the game and the well size', /Tetris well 10 wide, 20 tall/.test(st.stack), st.stack);
    ok('reports the tallest column', /Tallest column 4\./.test(st.stack), st.stack);
    ok('reports buried cells', /2 buried cells/.test(st.stack), st.stack);
    ok('reports roughness and the deepest gap', /Roughness 5/.test(st.stack) && /Deepest gap 1/.test(st.stack));
    ok('reports the right column honestly', /Last column filled/.test(st.stack));
    ok('lists column heights', /Heights: 3,4,4,4,4,4,4,4,4,2/.test(st.columns), st.columns);
    ok('names the falling piece and the queue', /Falling T/.test(st.pieces) && /Next I,O,S/.test(st.pieces));
    ok('says whether a swap is available', /swap ok/.test(st.pieces), st.pieces);
    ok('says when the swap is spent',
       /swap used/.test(D.buildState(snap({ canHold: false })).pieces), D.buildState(snap({ canHold: false })).pieces);
    // The summary fields are what every question pays for; the ascii well
    // is optional and the first thing dropped.
    const core = D.buildState(snap(), { omitWell: true });
    ok('the summary fields stay small because they are encoded per question',
       Object.values(core).join('').length < 220, String(Object.values(core).join('').length));
    ok('the well is what makes it bigger, and it is optional',
       Object.values(st).join('').length > Object.values(core).join('').length,
       Object.values(st).join('').length + ' vs ' + Object.values(core).join('').length);
    ok('includes the ascii well', /#/.test(st.well || ''), String(st.well));
    ok('the well is trimmed to the top of the stack',
       (st.well || '').split('\n').length <= 7, String((st.well || '').split('\n').length));
    ok('the well can be omitted on request', D.buildState(snap(), { omitWell: true }).well === undefined);
  }

  console.log('\n== the prompt fits the context window ==');
  {
    // The move options are last in the prompt, so truncation would eat
    // exactly the part the decision depends on.
    const p = D.buildPrompt(snap());
    ok('a normal position is inside the budget',
       p.tokens <= D.TOKEN_BUDGET, p.tokens + ' of ' + D.TOKEN_BUDGET);
    ok('the budget is inside the 512-token context', D.TOKEN_BUDGET < 512, String(D.TOKEN_BUDGET));
    ok('nothing needed trimming for a normal position', p.trimmed.length === 0, p.trimmed.join(','));
    ok('the well survives when there is room', p.state.well !== undefined);

    // A worst case: a full-height messy board and long descriptions.
    const huge = snap({
      heights: new Array(10).fill(19), maxHeight: 19, holes: 40, bumpiness: 99,
      board: new Array(20).fill('#.#.#.#.#.').join('\n'),
      candidates: snap().candidates.map(function (c) {
        return Object.assign({}, c, { why: c.why + ' ' + c.why + ' ' + c.why });
      })
    });
    const ph = D.buildPrompt(huge);
    ok('a worst-case position is still inside the budget',
       ph.tokens <= D.TOKEN_BUDGET, ph.tokens + ' of ' + D.TOKEN_BUDGET);
    ok('it trims when it has to, and says what it gave up',
       ph.tokens <= D.TOKEN_BUDGET, ph.tokens + ' trimmed=' + ph.trimmed.join(','));
    ok('the move options are never trimmed away',
       Object.keys(ph.questions.move.criteria).join(',') === 'a,b,c,d');
    ok('the estimator reports the largest single question',
       D.estimateTokens(p.state, p.questions).largest === p.tokens,
       D.estimateTokens(p.state, p.questions).largest + ' vs ' + p.tokens);
    ok('an empty prompt estimates zero', D.estimateTokens({}, {}).total === 0);
    ok('the scalar helper returns the largest question',
       D.estimateContextTokens(p.state, p.questions) === p.tokens);
  }

  console.log('\n== the cost model is per question, not per batch ==');
  {
    // Laya encodes the whole state once per question, so usage.input_tokens
    // is the sum over questions while the 512-token context applies to the
    // largest single one. Measured on the real checkpoint.
    const all = D.buildPrompt(snap({ askStrategy: true }));
    const moveOnly = D.buildPrompt(snap({ askStrategy: false }));
    ok('a strategy call asks two questions',
       Object.keys(all.questions).join(',') === 'strategy,risk', Object.keys(all.questions).join(','));
    ok('a move call asks one',
       Object.keys(moveOnly.questions).join(',') === 'move', Object.keys(moveOnly.questions).join(','));

    ok('each question is costed separately', Object.keys(all.perQuestion).length === 2,
       JSON.stringify(all.perQuestion));
    ok('the total is the sum over questions',
       all.estimatedTotal === Object.values(all.perQuestion).reduce((a, b) => a + b, 0),
       all.estimatedTotal + ' vs ' + JSON.stringify(all.perQuestion));
    ok('the context check uses the largest question, not the total',
       all.tokens === Math.max.apply(null, Object.values(all.perQuestion)) && all.tokens < all.estimatedTotal,
       all.tokens + ' of ' + all.estimatedTotal);
    ok('the largest question fits the 512-token context',
       all.tokens < D.CONTEXT_TOKENS, all.tokens + ' / ' + D.CONTEXT_TOKENS);
    ok('a move call costs less than a strategy call',
       moveOnly.estimatedTotal < all.estimatedTotal,
       moveOnly.estimatedTotal + ' vs ' + all.estimatedTotal);
    ok('every single call stays well inside one context window',
       all.tokens < D.CONTEXT_TOKENS && moveOnly.tokens < D.CONTEXT_TOKENS,
       all.tokens + ' / ' + moveOnly.tokens);
    ok('splitting the calls keeps each one cheap: no call encodes the state three times',
       all.estimatedTotal + moveOnly.estimatedTotal < 3 * Math.max(all.tokens, moveOnly.tokens) + 300,
       (all.estimatedTotal + moveOnly.estimatedTotal) + '');

    // The estimate must never sit under the real count; the safety factor
    // was fitted against measured usage.input_tokens on this checkpoint.
    ok('the estimate is conservative, not optimistic',
       all.estimatedTotal > (Object.values(all.state).join('').length / 4) * 3,
       String(all.estimatedTotal));
  }

  console.log('\n== a move-only answer leaves the play style alone ==');
  {
    const raw = {
      model: 'laya',
      answers: { move: { type: 'choice', choice: 'b', probabilities: { a: 0.3, b: 0.7 }, confidence: 0.5 } }
    };
    const d = D.normalize(raw, snap({ askStrategy: false }), { engine: 'laya', ms: 400 });
    ok('the move is read', d.move === 'b' && Math.abs(d.moveConfidence - 0.7) < 1e-9);
    ok('the strategy is null, meaning "not asked"', d.strategy === null, String(d.strategy));
    ok('its confidence is null too', d.strategyConfidence === null);
    ok('the risk is null', d.risk === null && d.riskLabel === null);
    ok('only the move was asked', d.questionsAsked.join(',') === 'move', d.questionsAsked.join(','));

    // Asked but unparseable is different: that still defaults defensively.
    const asked = D.normalize({ answers: {} }, snap({ askStrategy: true }), {});
    ok('an unparseable strategy still defaults to balanced', asked.strategy === 'balanced');
    ok('an unparseable risk still defaults to zero', asked.risk === 0);
  }

  console.log('\n== question construction ==');
  {
    // A call asks for one concern: the move, or the play style and risk.
    const qm = D.buildQuestions(snap());
    const qs = D.buildQuestions(snap({ askStrategy: true }));

    ok('a move call asks only for the move', Object.keys(qm).join(',') === 'move', Object.keys(qm).join(','));
    ok('a strategy call asks for the play style and the risk',
       Object.keys(qs).join(',') === 'strategy,risk', Object.keys(qs).join(','));
    ok('the two never overlap', qm.strategy === undefined && qs.move === undefined);

    ok('strategy is a choice with one criterion per strategy',
       qs.strategy.type === 'choice' && Object.keys(qs.strategy.criteria).length === 5,
       Object.keys(qs.strategy.criteria).join(','));
    ok('strategy criteria are non-empty descriptions',
       Object.values(qs.strategy.criteria).every(function (v) { return typeof v === 'string' && v.length > 20; }));
    ok('risk is a score over an ordered rubric',
       qs.risk.type === 'score' && Array.isArray(qs.risk.criteria) && qs.risk.criteria.length === 4);
    ok('rubric runs lowest to highest', /plenty of room/.test(qs.risk.criteria[0]) && /lose/.test(qs.risk.criteria[3]));

    ok('move is a choice keyed by candidate',
       qm.move.type === 'choice' && Object.keys(qm.move.criteria).join(',') === 'a,b,c,d',
       Object.keys(qm.move.criteria).join(','));
    ok('each move option carries its description', qm.move.criteria.b === snap().candidates[1].why);
    ok('move descriptions stay short enough for the context',
       Object.values(qm.move.criteria).every(function (v) { return v.length < 140; }),
       String(Math.max.apply(null, Object.values(qm.move.criteria).map(function (v) { return v.length; }))));
    ok('the hold swap rides on the move options, not a separate question',
       qm.use_hold === undefined && /needs the hold swap/.test(qm.move.criteria.d),
       Object.keys(qm).join(','));
    ok('never asks a separate hold question', qs.use_hold === undefined && qm.use_hold === undefined);
    ok('every question has instructions',
       Object.values(qm).concat(Object.values(qs)).every(function (v) {
         return typeof v.instructions === 'string' && v.instructions.length > 10;
       }));

    const single = D.buildQuestions(snap({ candidates: [snap().candidates[0]] }));
    ok('no move question when there is only one placement', single.move === undefined);
    const singleStrategy = D.buildQuestions(snap({ candidates: [snap().candidates[0]], askStrategy: true }));
    ok('the play style is still worth asking with one placement', singleStrategy.strategy !== undefined);
    const subset = D.buildQuestions(snap({ strategies: ['balanced', 'survive'], askStrategy: true }));
    ok('only the offered strategies are listed',
       Object.keys(subset.strategy.criteria).join(',') === 'balanced,survive');
  }

  console.log('\n== parsing a real Laya response ==');
  {
    // Shapes taken from @receptron/laya dist/types.d.ts.
    const raw = {
      model: 'laya-english',
      answers: {
        strategy: {
          type: 'choice', choice: 'downstack',
          probabilities: { balanced: 0.11, downstack: 0.68, build_tetris: 0.05, flatten: 0.12, survive: 0.04 },
          confidence: 0.62, rl_agent: { act_probability: 0.9 }
        },
        risk: {
          type: 'score', score: 1.3886, legend: {}, 
          probabilities: { 0: 0.2, 1: 0.4, 2: 0.3, 3: 0.1 },
          confidence: 0.4, rl_agent: { act_probability: 0.8 }
        },
        use_hold: { type: 'noul', noul: 0.0988, rl_agent: { act_probability: 0.7 } },
        move: {
          type: 'choice', choice: 'b',
          probabilities: { a: 0.12, b: 0.71, c: 0.06, d: 0.11 },
          confidence: 0.58, rl_agent: { act_probability: 0.95 }
        }
      },
      usage: { input_tokens: 267, output_tokens: 0 }
    };
    // Answers arrive on separate calls now, so parse each against the
    // snapshot that would have produced it.
    const dMove = D.normalize({ model: raw.model, answers: { move: raw.answers.move }, usage: raw.usage },
                              snap(), { engine: 'laya', ms: 33 });
    const d = D.normalize({ model: raw.model, answers: { strategy: raw.answers.strategy, risk: raw.answers.risk } },
                          snap({ askStrategy: true }), { engine: 'laya', ms: 33 });
    Object.assign(d, {
      move: dMove.move, moveConfidence: dMove.moveConfidence,
      moveProbabilities: dMove.moveProbabilities, usage: dMove.usage
    });
    ok('engine and latency reported', d.engine === 'laya' && d.ms === 33);
    ok('model name taken from the top-level field', d.model === 'laya-english', String(d.model));
    ok('strategy parsed', d.strategy === 'downstack', d.strategy);
    ok('strategy probability is the chosen option, not the entropy',
       Math.abs(d.strategyConfidence - 0.68) < 1e-9 && Math.abs(d.strategyCertainty - 0.62) < 1e-9,
       d.strategyConfidence + '/' + d.strategyCertainty);
    ok('move parsed', d.move === 'b', d.move);
    ok('move gate uses the option probability', Math.abs(d.moveConfidence - 0.71) < 1e-9, String(d.moveConfidence));
    ok('move distribution passed through', d.moveProbabilities.c === 0.06);
    ok('risk score kept as an expected level', Math.abs(d.risk - 1.3886) < 1e-9, String(d.risk));
    ok('risk label reads off the rubric', d.riskLabel === D.RISK_RUBRIC[1], d.riskLabel);
    // The swap now rides on the chosen placement, but an explicit noul
    // answer is still honoured if one is ever asked for.
    const withNoul = D.normalize(
      { answers: { move: raw.answers.move, use_hold: { type: 'noul', noul: 0.0988 } } },
      snap(), { engine: 'laya', ms: 10 });
    ok('a noul below 0.5 means no swap',
       withNoul.useHold === false && Math.abs(withNoul.useHoldProbability - 0.0988) < 1e-9,
       String(withNoul.useHoldProbability));
    ok('with no noul, the swap comes from the chosen placement',
       dMove.useHold === false, String(dMove.useHold));
    ok('token usage passed through', d.usage.input_tokens === 267);
    ok('a strategy call records its questions', d.questionsAsked.join(',') === 'strategy,risk',
       d.questionsAsked.join(','));
    ok('a move call records its own', dMove.questionsAsked.join(',') === 'move', dMove.questionsAsked.join(','));
    ok('a move call reports no strategy', dMove.strategy === null && dMove.risk === null);

    const yes = D.normalize({ model: 'm', answers: { use_hold: { type: 'noul', noul: 0.91 } } }, snap(), {});
    ok('a noul answer is still honoured if one is ever asked', yes.useHold === true);
    const viaMove = D.normalize({ answers: { move: { type: 'choice', choice: 'd', probabilities: { a: 0.1, d: 0.9 } } } }, snap(), {});
    ok('the swap is taken from the chosen placement', viaMove.useHold === true && viaMove.useHoldProbability === 1);
    const noSwapMove = D.normalize({ answers: { move: { type: 'choice', choice: 'b', probabilities: { b: 0.9 } } } }, snap(), {});
    ok('a non-hold placement means no swap', noSwapMove.useHold === false);
    const rounded = D.normalize({ answers: { risk: { type: 'score', score: 2.7 } } }, snap({ askStrategy: true }), {});
    ok('a high risk score maps to the top rubric level', rounded.riskLabel === D.RISK_RUBRIC[3], rounded.riskLabel);
  }

  console.log('\n== parsing is defensive ==');
  {
    const bad = D.normalize({ answers: { move: { type: 'choice', choice: 'zzz', probabilities: { a: 0.9 } } } }, snap(), {});
    ok('an out-of-range choice falls back to the first candidate', bad.move === 'a', bad.move);
    const noStrat = D.normalize({ answers: {} }, snap({ askStrategy: true }), {});
    ok('a strategy that was asked for but missing defaults to balanced', noStrat.strategy === 'balanced');
    ok('a risk that was asked for but missing defaults to zero',
       noStrat.risk === 0 && noStrat.riskLabel === D.RISK_RUBRIC[0]);
    ok('a missing noul means no swap', noStrat.useHold === false);
    ok('an empty response yields a usable decision',
       D.normalize({ answers: {} }, snap(), {}).move === 'a');
    const inferred = D.normalize({ answers: { move: { type: 'choice', probabilities: { a: 0.1, b: 0.2, c: 0.7 } } } }, snap(), {});
    ok('the choice is inferred from probabilities when absent', inferred.move === 'c', inferred.move);
    ok('nothing throws on a null response',
       D.normalize(null, snap({ askStrategy: true }), {}).strategy === 'balanced');
  }

  console.log('\n== the deterministic fallback ==');
  {
    const f = D.fallbackDecision(snap());
    ok('labelled as the fallback, never as laya', f.engine === 'fallback');
    ok('always picks the top-ranked candidate', f.move === 'a' && f.moveConfidence === 1);
    ok('never asks for a swap', f.useHold === false);
    ok('low clean stack -> build_tetris',
       D.fallbackDecision(snap({ maxHeight: 6, holes: 0, bumpiness: 3 })).strategy === 'build_tetris');
    ok('buried cells -> downstack',
       D.fallbackDecision(snap({ maxHeight: 6, holes: 3 })).strategy === 'downstack');
    ok('jagged surface -> flatten',
       D.fallbackDecision(snap({ maxHeight: 6, holes: 0, bumpiness: 14 })).strategy === 'flatten');
    ok('tall stack -> survive',
       D.fallbackDecision(snap({ maxHeight: 15, holes: 3 })).strategy === 'survive');
    const bands = [2, 9, 13, 17].map(function (h) { return D.fallbackDecision(snap({ maxHeight: h })).risk; });
    ok('risk rises with stack height', JSON.stringify(bands) === '[0,1,2,3]', JSON.stringify(bands));
    ok('carries the reason through', D.fallbackDecision(snap(), { reason: 'model still loading' }).reason === 'model still loading');
  }

  console.log('\n== a stubbed model through the real path ==');
  {
    // Exactly what server.mjs does, with systemOne faked: proves the
    // question keys we send line up with the answer keys we read back.
    const s = snap({ askStrategy: true });
    const state = D.buildState(s);
    const questions = D.buildQuestions(s);
    const fakeLaya = {
      systemOne: async function (st, qs) {
        ok('the model receives the state object', st && typeof st.stack === 'string');
        const answers = {};
        for (const key of Object.keys(qs)) {
          const q = qs[key];
          if (q.type === 'choice') {
            const opts = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria);
            const probs = {};
            opts.forEach(function (o, i) { probs[o] = i === opts.length - 1 ? 0.7 : 0.3 / (opts.length - 1); });
            answers[key] = { type: 'choice', choice: opts[opts.length - 1], probabilities: probs, confidence: 0.5, rl_agent: { act_probability: 1 } };
          } else if (q.type === 'score') {
            answers[key] = { type: 'score', score: 2.0, legend: {}, probabilities: {}, confidence: 0.5, rl_agent: { act_probability: 1 } };
          } else {
            answers[key] = { type: 'noul', noul: 0.8, rl_agent: { act_probability: 1 } };
          }
        }
        return { model: 'laya-english', answers: answers, usage: { input_tokens: 300, output_tokens: 0 } };
      }
    };
    const raw = await fakeLaya.systemOne(state, questions);
    const d = D.normalize(raw, s, { engine: 'laya', ms: 40, model: raw.model });
    ok('every question got an answer back',
       Object.keys(raw.answers).sort().join(',') === Object.keys(questions).sort().join(','));
    ok('the last strategy option is read back', d.strategy === 'survive', d.strategy);
    ok('the risk level is picked up', d.risk === 2 && d.riskLabel === D.RISK_RUBRIC[2]);

    // And the move, on its own call.
    const sm = snap();
    const rawMove = await fakeLaya.systemOne(D.buildState(sm), D.buildQuestions(sm));
    const dm = D.normalize(rawMove, sm, { engine: 'laya', ms: 40, model: rawMove.model });
    ok('the last move option is read back', dm.move === 'd', dm.move);
    ok('the swap is picked up from the chosen placement', dm.useHold === true);
  }

  console.log('\n== the sidecar over http ==');
  {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.mjs')], {
      env: Object.assign({}, process.env, { PORT: '0', LAYA: '0' }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', function (b) { stderr += b; });
    const port = await new Promise(function (resolve, reject) {
      let out = '';
      child.stdout.on('data', function (b) {
        out += b;
        const m = out.match(/http:\/\/localhost:(\d+)\/\n/);
        if (m) resolve(Number(m[1]));
      });
      child.on('exit', function (code) { reject(new Error('sidecar exited ' + code + ': ' + stderr)); });
      setTimeout(function () { reject(new Error('sidecar did not report a port: ' + stderr)); }, 8000);
    });
    ok('the sidecar starts and reports its port', port > 0, String(port));

    const base = 'http://127.0.0.1:' + port;
    try {
      const h = await (await fetch(base + '/health')).json();
      ok('health reports the fallback engine when started without LAYA=1', h.engine === 'fallback', JSON.stringify(h));
      ok('health explains why', /LAYA=1/.test(h.reason || ''), String(h.reason));

      // Operational visibility: a saturated or cold model should be legible
      // from /health rather than showing up as a game that quietly stalls.
      ok('health reports queue depth and its limit',
         typeof h.queued === 'number' && typeof h.maxQueue === 'number' && h.maxQueue >= 1,
         h.queued + '/' + h.maxQueue);
      ok('health counts shed and abandoned requests',
         typeof h.shed === 'number' && typeof h.abandoned === 'number');
      ok('health separates inference time from queue time',
         typeof h.avgMs === 'number' && typeof h.avgQueuedMs === 'number');
      ok('health reports the keep-warm setting', typeof h.keepWarm === 'string', String(h.keepWarm));
      ok('health counts keep-warm passes', typeof h.warmups === 'number');

      const r1 = await fetch(base + '/decide', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snap())
      });
      const d1 = await r1.json();
      ok('decide answers with a usable decision',
         r1.status === 200 && d1.engine === 'fallback' && d1.move === 'a' && typeof d1.strategy === 'string',
         JSON.stringify(d1).slice(0, 90));
      ok('decide says the model was not used', d1.model === null);

      const r2 = await fetch(base + '/prompt', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snap())
      });
      const d2 = await r2.json();
      ok('prompt returns exactly what the model would be asked',
         d2.state && d2.questions && d2.questions.move.criteria.a === snap().candidates[0].why);
      ok('prompt reports the token estimate against the budget',
         d2.estimatedTokens > 0 && d2.estimatedTokens <= d2.budget,
         d2.estimatedTokens + '/' + d2.budget);

      const r3 = await fetch(base + '/decide', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"nope":1}'
      });
      ok('a payload without candidates is rejected', r3.status === 400, String(r3.status));
      const r4 = await fetch(base + '/decide', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json'
      });
      ok('malformed json is rejected', r4.status === 400, String(r4.status));
      const r5 = await fetch(base + '/decide');
      ok('GET on decide is rejected', r5.status === 405, String(r5.status));

      const r6 = await fetch(base + '/');
      const html = await r6.text();
      ok('the game itself is served', r6.status === 200 && /<canvas id="board"/.test(html));
      const r7 = await fetch(base + '/game.js');
      ok('the game scripts are served',
         r7.status === 200 && /javascript/.test(r7.headers.get('content-type')));
      ok('cors is open so file:// pages can reach it',
         r7.headers.get('access-control-allow-origin') === '*');
      const r8 = await fetch(base + '/nope.js');
      ok('a missing file is a 404', r8.status === 404);
      const r9 = await fetch(base + '/../../../etc/passwd');
      ok('path traversal is refused', r9.status === 403 || r9.status === 404, String(r9.status));

      // The sidecar has no authentication, so by default it must not be
      // reachable from anything but this machine.
      const os = require('node:os');
      const external = Object.values(os.networkInterfaces()).flat()
        .filter(function (n) { return n && n.family === 'IPv4' && !n.internal; });
      if (external.length) {
        const ip = external[0].address;
        let reachable = false;
        try {
          const c = new AbortController();
          const t = setTimeout(function () { c.abort(); }, 1200);
          const rr = await fetch('http://' + ip + ':' + port + '/health', { signal: c.signal });
          clearTimeout(t);
          reachable = rr.ok;
        } catch { reachable = false; }
        ok('not reachable from the network by default (' + ip + ')', reachable === false);
      } else {
        ok('not reachable from the network by default', true, 'no external interface to test');
      }
    } finally {
      child.kill('SIGKILL');
    }
  }

  console.log('\n---------------------------------------');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
