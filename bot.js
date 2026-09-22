'use strict';

/* ------------------------------------------------------------------ *
 * bot.js - the spatial half of the decision engine.
 *
 * Laya is a text decision model: it cannot see a board or search a
 * game tree. So this file does the part Laya cannot do -
 *
 *   1. enumerate every placement the current piece can legally reach
 *      (rotate at spawn, slide, drop - the same moves a player has),
 *   2. score each one with a weighted feature evaluation,
 *   3. shortlist the best few and describe them in plain English,
 *   4. execute the chosen placement through the normal primitives.
 *
 * Laya then does the part a heuristic is bad at: choosing *which*
 * shortlisted move to play and *which* weight profile (play style)
 * the situation calls for. See laya-client.js and server/decide.mjs.
 * ------------------------------------------------------------------ */

(function (root) {

  /* ----------------------- weight profiles ----------------------- */

  // The base profile is Dellacherie's evaluation function, whose published
  // weights are a strong Tetris player on their own. Each strategy is a
  // deliberate distortion of it, so "which strategy" is a real decision
  // with real consequences for which placement wins.
  const BASE = {
    landingHeight: -4.500158825082766,
    eroded: 3.4181268101392694,
    rowTransitions: -3.2178882868487753,
    colTransitions: -9.348695305445199,
    holes: -7.899265427351652,
    wells: -3.3855972247263626,
    maxHeight: 0,
    bumpiness: 0,
    aggHeight: 0,
    rightColumnOpen: 0,
    lineScore: [0, 0, 0, 0, 0]
  };

  function profile(over) { return Object.assign({}, BASE, over); }

  const PROFILES = {
    // Straight Dellacherie - efficient, no agenda.
    balanced: profile({}),

    // Buried holes are the thing to fix; clearing rows to expose them
    // is worth paying height for.
    downstack: profile({
      holes: -15.8,
      eroded: 4.6,
      colTransitions: -7.0,
      lineScore: [0, 30, 70, 120, 200]
    }),

    // Nine-wide stacking: keep the right column empty and refuse small
    // clears so a vertical I can cash in four rows at once.
    build_tetris: profile({
      rightColumnOpen: 14,
      wells: -1.2,
      lineScore: [0, -55, -25, 15, 480]
    }),

    // Trade a little efficiency for an even surface.
    flatten: profile({
      bumpiness: -3.2,
      maxHeight: -2.2,
      rowTransitions: -4.8
    }),

    // The stack is nearly out of room: clear now, at almost any cost.
    survive: profile({
      maxHeight: -9.0,
      aggHeight: -0.9,
      holes: -6.0,
      lineScore: [0, 110, 240, 380, 560]
    })
  };

  const STRATEGIES = Object.keys(PROFILES);

  /* ------------------------- board features ---------------------- */

  function makeCore(T) {
    const COLS = T.COLS, ROWS = T.ROWS;

    function cloneBoard(b) {
      const out = new Array(b.length);
      for (let i = 0; i < b.length; i++) out[i] = b[i].slice();
      return out;
    }

    function emptyRow() { return new Array(COLS).fill(null); }

    function colHeights(board) {
      const h = new Array(COLS).fill(0);
      for (let x = 0; x < COLS; x++) {
        for (let y = 0; y < ROWS; y++) {
          if (board[y][x]) { h[x] = ROWS - y; break; }
        }
      }
      return h;
    }

    function features(board) {
      const h = colHeights(board);
      let agg = 0, max = 0, holes = 0, bump = 0, wells = 0, deepest = 0;

      for (let x = 0; x < COLS; x++) {
        agg += h[x];
        if (h[x] > max) max = h[x];
        let seen = false;
        for (let y = 0; y < ROWS; y++) {
          if (board[y][x]) seen = true;
          else if (seen) holes++;      // empty cell with something above it
        }
      }
      for (let x = 0; x < COLS - 1; x++) bump += Math.abs(h[x] - h[x + 1]);

      // Cumulative well depth: a depth-3 well counts 1+2+3, so deep
      // single-column gaps hurt far more than shallow dips.
      for (let x = 0; x < COLS; x++) {
        const l = x === 0 ? ROWS : h[x - 1];
        const r = x === COLS - 1 ? ROWS : h[x + 1];
        const d = Math.min(l, r) - h[x];
        if (d > 0) { wells += (d * (d + 1)) / 2; if (d > deepest) deepest = d; }
      }

      // Transition counts (Dellacherie): walls and the floor count as filled.
      let rowT = 0, colT = 0;
      for (let y = 0; y < ROWS; y++) {
        let prev = 1;
        for (let x = 0; x < COLS; x++) {
          const c = board[y][x] ? 1 : 0;
          if (c !== prev) rowT++;
          prev = c;
        }
        if (prev !== 1) rowT++;
      }
      for (let x = 0; x < COLS; x++) {
        let prev = 0;
        for (let y = 0; y < ROWS; y++) {
          const c = board[y][x] ? 1 : 0;
          if (c !== prev) colT++;
          prev = c;
        }
        if (prev !== 1) colT++;
      }

      return {
        heights: h, aggHeight: agg, maxHeight: max, holes: holes,
        bumpiness: bump, wells: wells, deepestWell: deepest,
        rowTransitions: rowT, colTransitions: colT,
        rightColumnEmpty: h[COLS - 1] === 0,
        rightColumnHeight: h[COLS - 1]
      };
    }

    /* ---------------------- placement search --------------------- */

    function matrixKey(m) { return m.map(function (r) { return r.join(''); }).join('/'); }

    function cellsOf(pl) {
      const cells = [];
      for (let y = 0; y < pl.m.length; y++) {
        for (let x = 0; x < pl.m[y].length; x++) {
          if (pl.m[y][x]) cells.push([pl.x + x, pl.y + y]);
        }
      }
      return cells;
    }

    // Every placement reachable by: rotate at the spawn row, slide
    // sideways, drop. No tucks or spins - exactly what the executor
    // below can actually reproduce with move/rotate/hardDrop.
    function placements(board, type) {
      const out = [];
      let p = { type: type, m: T.clone(T.SHAPES[type]), x: T.SPAWN_X[type], y: 0, r: 0 };
      if (T.collidesOn(board, p.m, p.x, p.y)) return out;   // already topped out

      // Two rotation states can land on identical cells (an I or S or Z
      // sits in a different row of its bounding box at r0 and r2). Key on
      // the landed footprint so each distinct move is offered once.
      const seenShape = {};
      const seenLanding = {};
      for (let k = 0; k < 4; k++) {
        if (k > 0) {
          const np = T.rotatedPiece(board, p, 1);
          if (!np) break;                                   // rotation walled in
          p = np;
        }
        const key = matrixKey(p.m);
        if (seenShape[key]) continue;                       // O repeats its shape
        seenShape[key] = true;

        const xs = [p.x];
        for (let x = p.x - 1; x >= -3; x--) {
          if (T.collidesOn(board, p.m, x, p.y)) break;
          xs.push(x);
        }
        for (let x = p.x + 1; x <= COLS + 3; x++) {
          if (T.collidesOn(board, p.m, x, p.y)) break;
          xs.push(x);
        }

        for (let i = 0; i < xs.length; i++) {
          let y = p.y;
          while (!T.collidesOn(board, p.m, xs[i], y + 1)) y++;
          const pl = { type: type, m: p.m, r: p.r, x: xs[i], y: y };
          const land = cellsOf(pl).sort().join(';');
          if (seenLanding[land]) continue;
          seenLanding[land] = true;
          out.push(pl);
        }
      }
      return out;
    }

    // Drop the piece onto a copy of the board and resolve line clears.
    function applyPlacement(board, pl) {
      const b = cloneBoard(board);
      const cells = cellsOf(pl);
      let topOut = false;
      for (let i = 0; i < cells.length; i++) {
        const cx = cells[i][0], cy = cells[i][1];
        if (cy < 0) { topOut = true; continue; }            // locked above the well
        b[cy][cx] = pl.type;
      }

      const clearedRows = [];
      for (let y = 0; y < ROWS; y++) {
        let full = true;
        for (let x = 0; x < COLS; x++) if (!b[y][x]) { full = false; break; }
        if (full) clearedRows.push(y);
      }
      // Rebuild rather than splice: removing a row shifts the rows above
      // it, so a list of row indices goes stale after the first removal.
      if (clearedRows.length) {
        const kept = [];
        for (let y = 0; y < ROWS; y++) {
          if (clearedRows.indexOf(y) === -1) kept.push(b[y]);
        }
        while (kept.length < ROWS) kept.unshift(emptyRow());
        for (let y = 0; y < ROWS; y++) b[y] = kept[y];
      }

      // Dellacherie's "eroded piece cells": rows cleared x how many of
      // the cleared cells belonged to this piece. Rewards clears the
      // piece actually paid for.
      let own = 0;
      for (let i = 0; i < cells.length; i++) {
        if (clearedRows.indexOf(cells[i][1]) !== -1) own++;
      }

      let bottom = -1;
      for (let i = 0; i < cells.length; i++) if (cells[i][1] > bottom) bottom = cells[i][1];

      return {
        board: b,
        cleared: clearedRows.length,
        eroded: clearedRows.length * own,
        landingHeight: ROWS - bottom,
        topOut: topOut
      };
    }

    function evaluate(board, pl, W) {
      const r = applyPlacement(board, pl);
      const f = features(r.board);
      let s = 0;
      s += W.lineScore[r.cleared];
      s += W.eroded * r.eroded;
      s += W.landingHeight * r.landingHeight;
      s += W.holes * f.holes;
      s += W.rowTransitions * f.rowTransitions;
      s += W.colTransitions * f.colTransitions;
      s += W.wells * f.wells;
      s += W.maxHeight * f.maxHeight;
      s += W.bumpiness * f.bumpiness;
      s += W.aggHeight * f.aggHeight;
      if (W.rightColumnOpen) s += W.rightColumnOpen * (f.rightColumnEmpty ? 1 : 0);
      if (r.topOut) s -= 1e6;                               // never choose to die
      return { score: s, cleared: r.cleared, after: r.board, f: f, topOut: r.topOut };
    }

    // Best achievable score for `type` on `board` - the lookahead term.
    function bestReply(board, type, W) {
      const list = placements(board, type);
      let best = -Infinity;
      for (let i = 0; i < list.length; i++) {
        const s = evaluate(board, list[i], W).score;
        if (s > best) best = s;
      }
      return best === -Infinity ? -1e6 : best;
    }

    const ORIENT = ['flat', 'turned right', 'flipped', 'turned left'];

    // Kept short deliberately: these four strings are the bulk of what is
    // sent to Laya, whose context is 512 tokens.
    function describe(cand, before) {
      const cols = cand.cells.map(function (c) { return c[0] + 1; });
      const lo = Math.min.apply(null, cols), hi = Math.max.apply(null, cols);
      const span = lo === hi ? ('col ' + lo) : ('cols ' + lo + '-' + hi);
      const newHoles = cand.f.holes - before.holes;
      const bits = [];
      bits.push(cand.type + ' ' + ORIENT[cand.r] + ' in ' + span);
      bits.push(cand.cleared === 0 ? 'clears nothing'
        : ('clears ' + cand.cleared + (cand.cleared === 1 ? ' row' : ' rows')));
      if (newHoles > 0) bits.push('buries ' + newHoles);
      else if (newHoles < 0) bits.push('frees ' + (-newHoles));
      else bits.push('buries none');
      bits.push('peak ' + cand.f.maxHeight + '/' + ROWS);
      if (cand.f.bumpiness < before.bumpiness) bits.push('flatter');
      else if (cand.f.bumpiness > before.bumpiness) bits.push('rougher');
      if (cand.f.rightColumnEmpty) bits.push('right column open');
      if (cand.useHold) bits.push('needs the hold swap');
      return bits.join(', ') + '.';
    }

    /* -------------------------- planning ------------------------- */

    // Rank every placement for the live piece (and for the hold swap, if
    // it is available) under one weight profile.
    function rank(board, curType, swapType, W, opts) {
      const o = opts || {};
      const before = features(board);
      const cands = [];

      function collect(type, useHold) {
        if (!type) return;
        const list = placements(board, type);
        for (let i = 0; i < list.length; i++) {
          const ev = evaluate(board, list[i], W);
          cands.push({
            type: type, r: list[i].r, x: list[i].x, y: list[i].y, m: list[i].m,
            cells: cellsOf(list[i]), useHold: !!useHold,
            score: ev.score, base: ev.score, cleared: ev.cleared,
            f: ev.f, after: ev.after, topOut: ev.topOut
          });
        }
      }
      collect(curType, false);
      if (swapType && swapType !== curType) collect(swapType, true);

      cands.sort(function (a, b) { return b.score - a.score; });

      // One-piece lookahead on the shortlist: a placement that leaves the
      // well unable to take the next piece is not actually good.
      if (o.lookahead && o.nextType) {
        const depth = Math.min(cands.length, o.lookaheadWidth || 14);
        for (let i = 0; i < depth; i++) {
          const reply = bestReply(cands[i].after, o.nextType, W);
          cands[i].reply = reply;
          cands[i].score = cands[i].base + 0.7 * reply;
        }
        const head = cands.slice(0, depth).sort(function (a, b) { return b.score - a.score; });
        cands.length = 0;
        Array.prototype.push.apply(cands, head);
      }

      for (let i = 0; i < cands.length; i++) cands[i].why = describe(cands[i], before);
      return { before: before, candidates: cands };
    }

    // The shortlist handed to Laya: the best few *materially different*
    // placements. Near-duplicates would make the choice meaningless.
    function shortlist(cands, n) {
      const out = [], seen = {};
      for (let i = 0; i < cands.length && out.length < n; i++) {
        const k = cands[i].useHold + ':' + cands[i].r + ':' + cands[i].x;
        if (seen[k]) continue;
        seen[k] = true;
        out.push(cands[i]);
      }
      return out;
    }

    return {
      cloneBoard: cloneBoard, colHeights: colHeights, features: features,
      placements: placements, applyPlacement: applyPlacement, evaluate: evaluate,
      bestReply: bestReply, rank: rank, shortlist: shortlist, describe: describe,
      cellsOf: cellsOf, PROFILES: PROFILES, STRATEGIES: STRATEGIES
    };
  }

  /* ------------------------- the controller ---------------------- */

  const KEYS = 'abcdefgh';

  function createBot(T, cfg) {
    const core = makeCore(T);
    const opt = Object.assign({
      shortlist: 4,
      lookahead: true,
      lookaheadWidth: 14,
      stepMs: 55,
      confidenceFloor: 0.34,   // below this, keep the heuristic pick
      maxSteps: 28,
      // Laya re-encodes the whole board for every question asked, so the
      // play style and risk are refreshed periodically while the move is
      // asked every piece. Measured: move alone ~400ms, all three ~2.6s.
      strategyEvery: 6,
      maxWaitMs: 900,
      // Hold the piece until the model answers, however long it takes, so
      // every placement is Laya's. Costs wall-clock; buys a game that is
      // genuinely model-driven rather than mostly heuristic.
      waitForDecision: false,
      waitCapMs: 8000
    }, cfg || {});

    const bot = {
      core: core,
      opt: opt,
      mode: 'off',            // 'off' | 'assist' | 'autoplay'
      strategy: 'balanced',
      decide: null,           // async (snapshot) => decision, injected
      onDecision: null,       // UI callback
      decision: null,
      candidates: [],
      plan: null,
      risk: null,
      riskLabel: null,
      pending: false,
      inFlight: false,
      latencyMs: null,        // exponential moving average of answer latency
      strategyAge: 99,        // pieces since the play style was last refreshed
      waitedMs: 0,
      waitBudget: 0,
      acc: 0,
      steps: 0,
      stats: { pieces: 0, laya: 0, fallback: 0, offline: 0, timeouts: 0, overrides: 0, holds: 0, skipped: 0 }
    };

    function snapshot(shortlist, before) {
      const S = T.S;
      return {
        piece: S.cur ? S.cur.type : null,
        queue: S.queue.slice(0, 3),
        hold: S.hold,
        canHold: S.canHold,
        level: S.level,
        lines: S.lines,
        score: S.score,
        board: renderBoard(),
        heights: before.heights.slice(),
        maxHeight: before.maxHeight,
        holes: before.holes,
        bumpiness: before.bumpiness,
        deepestWell: before.deepestWell,
        rightColumnEmpty: before.rightColumnEmpty,
        strategies: core.STRATEGIES,
        candidates: shortlist.map(function (c, i) {
          return {
            key: KEYS[i], why: c.why, cleared: c.cleared,
            useHold: c.useHold, r: c.r, x: c.x, type: c.type
          };
        })
      };
    }

    // A compact picture of the well for Laya's state. '#' filled, '.' empty.
    function renderBoard() {
      const rows = [];
      let started = false;
      for (let y = 0; y < T.ROWS; y++) {
        let line = '';
        let any = false;
        for (let x = 0; x < T.COLS; x++) {
          const filled = !!T.S.board[y][x];
          if (filled) any = true;
          line += filled ? '#' : '.';
        }
        if (any) started = true;
        if (started) rows.push(line);
      }
      return rows.join('\n');          // empty string when the well is empty
    }

    function replan() {
      const S = T.S;
      if (!S.cur) { bot.plan = null; bot.candidates = []; return null; }
      const W = core.PROFILES[bot.strategy] || core.PROFILES.balanced;
      const swap = S.canHold ? (S.hold || S.queue[0]) : null;
      const r = core.rank(S.board, S.cur.type, swap, W, {
        lookahead: opt.lookahead,
        lookaheadWidth: opt.lookaheadWidth,
        nextType: S.queue[0]
      });
      bot.candidates = core.shortlist(r.candidates, opt.shortlist);
      bot.plan = bot.candidates[0] || null;
      bot.before = r.before;
      return r;
    }

    // Re-rank under a (possibly new) strategy and re-resolve the choice by
    // key, so a strategy switch from Laya actually changes the placement.
    function applyDecision(d) {
      bot.decision = d;
      if (!d) {
        // No answer at all (sidecar down or timed out): keep the ranked
        // plan, but say so rather than silently looking like a decision.
        bot.stats.offline++;
        if (bot.onDecision) bot.onDecision(null, bot);
        return;
      }
      if (d.strategy && core.PROFILES[d.strategy]) {
        bot.strategyAge = 0;
        if (d.strategy !== bot.strategy) {
          bot.strategy = d.strategy;
          replan();                                // new weights, new shortlist
        }
      }
      if (d.engine === 'laya') bot.stats.laya++;
      else if (d.engine === 'fallback') bot.stats.fallback++;
      else bot.stats.offline++;

      // Risk and strategy are null on a move-only answer; keep the last
      // known values rather than resetting them.
      if (typeof d.risk === 'number') { bot.risk = d.risk; bot.riskLabel = d.riskLabel; }

      if (d.move === null) {
        // A play-style refresh: nothing to apply to this piece's placement.
        if (bot.onDecision) bot.onDecision(bot.decision, bot);
        return;
      }
      const idx = d.move ? KEYS.indexOf(d.move) : -1;
      const conf = typeof d.moveConfidence === 'number' ? d.moveConfidence : 1;
      if (idx >= 0 && idx < bot.candidates.length && conf >= opt.confidenceFloor) {
        bot.plan = bot.candidates[idx];
        bot.chose = d.move;
      } else {
        // Confidence gating, as Laya's own docs recommend: an unsure
        // decision is escalated back to the deterministic ranking.
        if (idx >= 0 && conf < opt.confidenceFloor) bot.stats.overrides++;
        bot.plan = bot.candidates[0] || bot.plan;
        bot.chose = KEYS[0];
      }
      if (bot.onDecision) bot.onDecision(bot.decision, bot);
    }

    // A late answer is useless for the piece that has already locked, but
    // the play style it chose is not piece-specific - keep that part.
    function adoptLateStrategy(d) {
      if (!d) return;
      if (typeof d.risk === 'number') { bot.risk = d.risk; bot.riskLabel = d.riskLabel; }
      if (d.strategy && core.PROFILES[d.strategy]) {
        bot.strategyAge = 0;
        if (d.strategy !== bot.strategy) bot.strategy = d.strategy;
      }
      if (bot.onDecision) bot.onDecision(bot.decision, bot);
    }

    function onPiece() {
      bot.stats.pieces++;
      bot.strategyAge++;
      bot.steps = 0;
      bot.acc = 0;
      bot.chose = null;
      if (bot.mode === 'off') { bot.plan = null; bot.candidates = []; return; }

      const r = replan();
      if (!r || !bot.candidates.length) return;

      if (!bot.decide) { bot.decision = null; return; }

      // One request at a time: queueing a second forward pass behind the
      // first only makes both late, and the model is serialized anyway.
      if (bot.inFlight) { bot.stats.skipped++; return; }

      const snap = snapshot(bot.candidates, r.before);
      // Refresh the play style periodically; ask only for the move otherwise.
      snap.askStrategy = bot.strategyAge >= opt.strategyEvery || bot.decision === null;

      bot.pending = true;
      bot.inFlight = true;
      bot.waitedMs = 0;
      // Wait about as long as answers have actually been taking, capped so a
      // slow model never forfeits the piece to gravity.
      const expected = bot.latencyMs === null ? 600 : bot.latencyMs;
      bot.waitBudget = opt.waitForDecision
        ? opt.waitCapMs
        : Math.min(opt.maxWaitMs, Math.max(150, Math.min(expected * 1.4, T.gravityMs() * 0.8)));
      const piecesAtCall = bot.stats.pieces;

      bot.decide(snap).then(function (d) {
        bot.pending = false;
        bot.inFlight = false;
        if (d && typeof d.ms === 'number') {
          bot.latencyMs = bot.latencyMs === null ? d.ms : bot.latencyMs * 0.7 + d.ms * 0.3;
        }
        if (piecesAtCall !== bot.stats.pieces) { adoptLateStrategy(d); return; }
        applyDecision(d);
      }).catch(function () {
        bot.pending = false;
        bot.inFlight = false;
        bot.stats.offline++;
        if (bot.onDecision) bot.onDecision(null, bot);
      });
    }

    /* ------------------------- execution ------------------------- */

    // Recomputed every step rather than replayed from a fixed script, so
    // gravity, a rotation kick or a blocked slide cannot desync the plan.
    function step() {
      const S = T.S;
      if (!S.cur || !bot.plan) return;

      // Derived from the plan, never a separate flag: a stale flag and a
      // fresh plan used to be able to disagree.
      if (bot.plan.useHold) {
        if (S.canHold) {
          bot.stats.holds++;
          T.holdPiece();        // spawns the swapped piece -> onPiece re-plans
          return;
        }
        replan();               // swap no longer legal; plan for this piece
        return;
      }
      if (++bot.steps > opt.maxSteps) { T.hardDrop(); return; }

      const c = S.cur;
      if (c.r !== bot.plan.r) {
        if (!T.rotate(1)) {
          // Walled in: nudge sideways and try again next step, or commit.
          if (!T.move(-1) && !T.move(1)) T.hardDrop();
        }
        return;
      }
      if (c.x !== bot.plan.x) {
        const dir = bot.plan.x > c.x ? 1 : -1;
        if (!T.move(dir)) T.hardDrop();      // path closed; take what we have
        return;
      }
      T.hardDrop();
    }

    function tick(dt) {
      if (bot.mode !== 'autoplay') return;
      if (!T.S.cur) return;

      if (bot.pending) {
        bot.waitedMs += dt;
        if (bot.waitedMs < bot.waitBudget) return;          // hold for the decision
        bot.pending = false;
        bot.stats.timeouts++;
        if (bot.onDecision) bot.onDecision(bot.decision, bot);
      }

      bot.acc += dt;
      const stepMs = Math.max(0, opt.stepMs);
      if (stepMs === 0) {                                   // instant mode
        let guard = 0;
        const piece = bot.stats.pieces;
        while (bot.stats.pieces === piece && guard++ < opt.maxSteps + 2) step();
        bot.acc = 0;
        return;
      }
      while (bot.acc >= stepMs) { bot.acc -= stepMs; step(); }
    }

    /* -------------------------- plan overlay --------------------- */

    function paint(ctx, CELL) {
      if (bot.mode === 'off' || !bot.plan || !T.S.cur) return;
      if (bot.plan.useHold) return;        // the hint would show the wrong piece
      const cells = bot.plan.cells;
      ctx.save();
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.globalAlpha = 0.9;
      for (let i = 0; i < cells.length; i++) {
        const cx = cells[i][0], cy = cells[i][1];
        if (cy < 0) continue;
        ctx.strokeRect(cx * CELL + 2.5, cy * CELL + 2.5, CELL - 5, CELL - 5);
      }
      ctx.restore();
    }

    bot.replan = replan;
    bot.applyDecision = applyDecision;
    bot.onPiece = onPiece;
    bot.step = step;
    bot.tick = tick;
    bot.paint = paint;
    bot.snapshot = snapshot;
    bot.setMode = function (m) {
      bot.mode = m;
      if (m === 'off') { bot.plan = null; bot.candidates = []; bot.decision = null; bot.strategyAge = 99; }
      else if (T.S.cur) onPiece();
    };
    bot.attach = function () {
      T.hooks.piece = onPiece;
      T.hooks.frame = tick;
      T.setOverlayPainter(paint);
    };
    return bot;
  }

  const api = { makeCore: makeCore, createBot: createBot, PROFILES: PROFILES, STRATEGIES: STRATEGIES, KEYS: KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TetrisBotCore = api;

})(typeof window !== 'undefined' ? window : globalThis);
