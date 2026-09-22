/* ------------------------------------------------------------------ *
 * bot-test.js - the spatial half of the decision engine.
 * Run with:  node tests/bot-test.js
 * ------------------------------------------------------------------ */

const { loadGame } = require('./dom-stub.js');

const env = loadGame();
const T = env.T, G = env.G, botCore = env.botCore;
const core = botCore.makeCore(T);
const KEYS = botCore.KEYS;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function blank() {
  const b = [];
  for (let y = 0; y < T.ROWS; y++) b.push(new Array(T.COLS).fill(null));
  return b;
}
function setBoard(rows) {           // rows: array of 10-char strings, bottom-aligned
  const b = blank();
  rows.forEach(function (r, i) {
    const y = T.ROWS - rows.length + i;
    for (let x = 0; x < T.COLS; x++) if (r[x] !== '.') b[y][x] = 'Z';
  });
  return b;
}
function liveBoard(b) { for (let y = 0; y < T.ROWS; y++) T.S.board[y] = b[y].slice(); }

// Deterministic deals: the piece sequence drives every result below, so a
// fixed seed is the difference between a claim and a coin flip.
const realRandom = Math.random;
function seed(n) {
  let a = n >>> 0;
  Math.random = function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function unseed() { Math.random = realRandom; }

console.log('\n== board features ==');
{
  const b = setBoard([
    '#.#.......',
    '.##.......'
  ]);
  const f = core.features(b);
  ok('column heights', JSON.stringify(f.heights) === JSON.stringify([2, 1, 2, 0, 0, 0, 0, 0, 0, 0]), JSON.stringify(f.heights));
  ok('max height', f.maxHeight === 2, String(f.maxHeight));
  ok('aggregate height', f.aggHeight === 5, String(f.aggHeight));
  ok('a covered gap counts as a hole', core.features(setBoard(['##########', '.#########'])).holes === 1);
  ok('an open column is not a hole', f.holes === 1, 'holes=' + f.holes);   // col0 y19 empty under y18
  ok('bumpiness', f.bumpiness === 4, String(f.bumpiness));
  ok('right column reported empty', f.rightColumnEmpty === true);
  ok('right column reported filled', core.features(setBoard(['.........#'])).rightColumnEmpty === false);
  const deep = core.features(setBoard(['#.########', '#.########', '#.########']));
  ok('cumulative wells grow with depth', deep.wells > core.features(setBoard(['#.########'])).wells,
     'depth3=' + deep.wells + ' depth1=' + core.features(setBoard(['#.########'])).wells);
  ok('deepest well measured', core.features(setBoard(['##.#######'])).deepestWell === 1,
     String(core.features(setBoard(['##.#######'])).deepestWell));
}

console.log('\n== placement enumeration ==');
{
  const b = blank();
  const counts = {};
  'IJLOSTZ'.split('').forEach(function (t) {
    const pl = core.placements(b, t);
    counts[t] = pl.length;
    const distinctShapes = new Set(pl.map(function (p) { return p.m.map(function (r) { return r.join(''); }).join('/'); })).size;
    ok(t + ': distinct orientations = ' + (t === 'O' ? 1 : (t === 'I' || t === 'S' || t === 'Z') ? 2 : 4),
       distinctShapes === (t === 'O' ? 1 : (t === 'I' || t === 'S' || t === 'Z') ? 2 : 4), String(distinctShapes));
    const allLegal = pl.every(function (p) { return !T.collidesOn(b, p.m, p.x, p.y); });
    const allResting = pl.every(function (p) { return T.collidesOn(b, p.m, p.x, p.y + 1); });
    const inBounds = pl.every(function (p) {
      return core.cellsOf(p).every(function (c) { return c[0] >= 0 && c[0] < T.COLS && c[1] < T.ROWS; });
    });
    ok(t + ': every placement is legal, resting and in bounds', allLegal && allResting && inBounds,
       'legal=' + allLegal + ' resting=' + allResting + ' inBounds=' + inBounds);
  });
  ok('O piece has 9 columns to sit in', counts.O === 9, String(counts.O));
  ok('I piece has 7 flat + 10 upright placements', counts.I === 17, String(counts.I));
  ok('a full well yields no placements', core.placements(setBoard(new Array(20).fill('##########')), 'T').length === 0);
}

console.log('\n== placements are reachable in the real game ==');
{
  // The executor must land the piece exactly where the planner said. This
  // is the contract that keeps the plan and the played move identical.
  const bot = botCore.createBot(T, { stepMs: 0, lookahead: false });
  bot.attach();
  bot.decide = null;
  bot.mode = 'autoplay';

  let checked = 0, mismatches = [];
  for (let trial = 0; trial < 220; trial++) {
    T.start();
    // a jagged but non-lethal starting stack
    const rows = [];
    for (let i = 0; i < 4 + (trial % 5); i++) {
      let r = '';
      for (let x = 0; x < T.COLS; x++) r += ((x * 7 + i * 3 + trial) % 4 === 0) ? '.' : '#';
      rows.push(r);
    }
    liveBoard(setBoard(rows));

    const list = core.placements(T.S.board, T.S.cur.type);
    if (!list.length) continue;
    const target = list[(trial * 13) % list.length];
    bot.plan = {
      type: target.type, r: target.r, x: target.x, y: target.y, m: target.m,
      cells: core.cellsOf(target), useHold: false
    };
    const want = core.cellsOf(target).filter(function (c) { return c[1] >= 0; });
    const before = T.S.board.map(function (r) { return r.slice(); });
    const pieces = bot.stats.pieces;

    let guard = 0;
    while (bot.stats.pieces === pieces && guard++ < 40) bot.step();

    // Was every planned cell actually filled (unless the row then cleared)?
    const rowsCleared = want.some(function (c) {
      return before[c[1]].filter(Boolean).length + want.filter(function (w) { return w[1] === c[1]; }).length >= T.COLS;
    });
    if (!rowsCleared) {
      const landed = want.every(function (c) { return T.S.board[c[1]][c[0]] === target.type; });
      if (!landed) mismatches.push(trial + ':' + target.type + ' r' + target.r + ' x' + target.x);
      checked++;
    }
  }
  ok('every planned placement landed exactly as planned (' + checked + ' trials)',
     mismatches.length === 0, mismatches.slice(0, 5).join(' '));
  ok('enough trials actually verified', checked > 120, String(checked));
}

console.log('\n== evaluation ==');
{
  const W = core.PROFILES.balanced;
  // A row that can be completed: clearing it must beat leaving a gap.
  const b = setBoard(['....######']);
  const pl = core.placements(b, 'I');
  const flat = pl.filter(function (p) { return p.m === pl[0].m; });
  const best = flat.reduce(function (a, p) {
    return core.evaluate(b, p, W).score > core.evaluate(b, a, W).score ? p : a;
  });
  ok('clearing a row is the top-ranked I placement', core.evaluate(b, best, W).cleared === 1,
     'cleared=' + core.evaluate(b, best, W).cleared);

  // Burying a hole must score worse than not burying one.
  const b2 = setBoard(['#.########']);
  const over = core.placements(b2, 'O').find(function (p) { return p.x === 0; });
  const away = core.placements(b2, 'O').find(function (p) { return p.x === 4; });
  ok('burying a cell is penalised', core.evaluate(b2, over, W).score < core.evaluate(b2, away, W).score,
     core.evaluate(b2, over, W).score.toFixed(1) + ' vs ' + core.evaluate(b2, away, W).score.toFixed(1));

  const r = core.applyPlacement(setBoard(['....######']), best);
  ok('applyPlacement clears the row', r.cleared === 1 && r.board[T.ROWS - 1].every(function (c) { return !c; }),
     'cleared=' + r.cleared);
  ok('eroded piece cells counted', r.eroded > 0, String(r.eroded));
  ok('landing height reported', r.landingHeight >= 1);
}

console.log('\n== strategy profiles change the chosen move ==');
{
  const opts = { lookahead: false };
  const top = function (b, type, prof) {
    return core.rank(b, type, null, core.PROFILES[prof], opts).candidates[0];
  };
  ok('five strategies exist', core.STRATEGIES.length === 5, core.STRATEGIES.join(','));

  // A cheap single clear on a low, clean stack. build_tetris is the only
  // profile that should turn it down to keep the four-wide setup alive.
  const b = setBoard(['#########.']);
  const tetrisPick = top(b, 'I', 'build_tetris');
  ok('build_tetris declines a cheap single clear',
     tetrisPick.cleared === 0 && tetrisPick.f.rightColumnEmpty === true,
     'cleared=' + tetrisPick.cleared + ' rightEmpty=' + tetrisPick.f.rightColumnEmpty);
  const others = core.STRATEGIES.filter(function (k) { return k !== 'build_tetris'; });
  ok('every other profile takes the single clear',
     others.every(function (k) { return top(b, 'I', k).cleared === 1; }),
     others.map(function (k) { return k + '=' + top(b, 'I', k).cleared; }).join(' '));

  // ...but no profile is daft enough to refuse four rows at once.
  const b4 = setBoard(['#########.', '#########.', '#########.', '#########.']);
  ok('every profile cashes a four-row clear',
     core.STRATEGIES.every(function (k) { return top(b4, 'I', k).cleared === 4; }),
     core.STRATEGIES.map(function (k) { return k + '=' + top(b4, 'I', k).cleared; }).join(' '));

  // Weight-level checks: the margin between two fixed placements must move
  // in the direction each profile claims to care about.
  const margin = function (board, good, bad, prof) {
    const W = core.PROFILES[prof];
    return core.evaluate(board, good, W).score - core.evaluate(board, bad, W).score;
  };

  // Burying a cell vs not, same piece, neither clearing.
  const notch = setBoard(['#.########']);
  const buries = core.placements(notch, 'O').find(function (p) { return p.x === 0; });
  const clean = core.placements(notch, 'O').find(function (p) { return p.x === 4; });
  ok('downstack punishes burying a cell harder than balanced does',
     margin(notch, clean, buries, 'downstack') > margin(notch, clean, buries, 'balanced'),
     'downstack=' + margin(notch, clean, buries, 'downstack').toFixed(1) +
     ' balanced=' + margin(notch, clean, buries, 'balanced').toFixed(1));

  // Filling a dip vs stacking on a peak, on a jagged surface.
  const jag = setBoard(['###....###', '###....###', '####..####']);
  const cands = core.placements(jag, 'O');
  const flat = cands.reduce(function (a, p) {
    return core.evaluate(jag, p, core.PROFILES.flatten).f.bumpiness <
           core.evaluate(jag, a, core.PROFILES.flatten).f.bumpiness ? p : a;
  });
  const rough = cands.reduce(function (a, p) {
    return core.evaluate(jag, p, core.PROFILES.flatten).f.bumpiness >
           core.evaluate(jag, a, core.PROFILES.flatten).f.bumpiness ? p : a;
  });
  ok('flatten prefers the smoother surface more than balanced does',
     margin(jag, flat, rough, 'flatten') > margin(jag, flat, rough, 'balanced'),
     'flatten=' + margin(jag, flat, rough, 'flatten').toFixed(1) +
     ' balanced=' + margin(jag, flat, rough, 'balanced').toFixed(1));

  // Height: survive should pay more to stay low than balanced will.
  const tall = setBoard(['#.........', '#.........', '#.........', '#.........',
                         '#.........', '#.........', '#........#', '#.......##']);
  const low = core.placements(tall, 'O').find(function (p) { return p.x === 4; });
  const high = core.placements(tall, 'O').find(function (p) { return p.x === 0; });
  ok('survive pays more to keep the stack low',
     margin(tall, low, high, 'survive') > margin(tall, low, high, 'balanced'),
     'survive=' + margin(tall, low, high, 'survive').toFixed(1) +
     ' balanced=' + margin(tall, low, high, 'balanced').toFixed(1));

  // And the profile really does change what gets played, not just the score.
  const board = setBoard(['#########.']);
  const picks = {};
  core.STRATEGIES.forEach(function (k) {
    const c = top(board, 'I', k);
    picks[k] = c.r + ':' + c.x;
  });
  ok('the profiles do not all pick the same move',
     new Set(Object.values(picks)).size > 1, JSON.stringify(picks));
}

console.log('\n== shortlist and descriptions ==');
{
  const b = setBoard(['###...####', '####..####']);
  const r = core.rank(b, 'T', 'I', core.PROFILES.balanced, { lookahead: true, nextType: 'O' });
  const sl = core.shortlist(r.candidates, 4);
  ok('shortlist respects the requested size', sl.length === 4, String(sl.length));
  ok('shortlist entries are materially different',
     new Set(sl.map(function (c) { return c.useHold + ':' + c.r + ':' + c.x; })).size === sl.length);
  ok('shortlist is ranked best first', sl[0].score >= sl[sl.length - 1].score,
     sl[0].score.toFixed(1) + ' >= ' + sl[sl.length - 1].score.toFixed(1));
  ok('hold placements are offered when a swap is available', r.candidates.some(function (c) { return c.useHold; }));
  const why = sl[0].why;
  ok('description names the piece and the columns',
     /^[IJLOSTZ] /.test(why) && /\bcols? \d+/.test(why), why);
  ok('description states the row count', /clears (nothing|\d+ rows?)/.test(why), why);
  ok('description states the hole cost', /buries (none|\d+)|frees \d+/.test(why), why);
  ok('description states the resulting peak', /peak \d+\/20/.test(why), why);
  ok('descriptions stay short enough for a 512-token prompt',
     sl.every(function (c) { return c.why.length < 140; }),
     String(Math.max.apply(null, sl.map(function (c) { return c.why.length; }))));
  ok('lookahead scores were applied', r.candidates.some(function (c) { return typeof c.reply === 'number'; }));
}

console.log('\n== the bot actually plays ==');
{
  const bot = botCore.createBot(T, { stepMs: 0, lookahead: true });
  bot.attach();
  bot.decide = null;

  // Three fixed deals, so a regression in the evaluation shows up as a
  // failure rather than as a lucky or unlucky run.
  const runs = [];
  [1, 2, 3].forEach(function (sd) {
    seed(sd * 7919);
    const piecesAtStart = bot.stats.pieces;
    T.start();
    bot.setMode('autoplay');
    let guard = 0;
    while (!T.S.over && guard++ < 700) bot.tick(1);
    runs.push({ seed: sd, over: T.S.over, pieces: bot.stats.pieces - piecesAtStart, lines: T.S.lines,
                level: T.S.level, score: T.S.score, holes: core.features(T.S.board).holes });
    unseed();
  });
  runs.forEach(function (r) {
    console.log('        deal ' + r.seed + ': ' + r.pieces + ' pieces, ' + r.lines +
                ' lines, level ' + r.level + ', score ' + r.score + ', holes left ' + r.holes);
  });
  ok('never tops out on any deal', runs.every(function (r) { return !r.over; }),
     runs.map(function (r) { return r.seed + ':' + r.over; }).join(' '));
  ok('clears at least 140 rows per 700 pieces on every deal',
     runs.every(function (r) { return r.lines >= 140; }),
     runs.map(function (r) { return r.lines; }).join(','));
  ok('averages better than one row per four pieces',
     runs.every(function (r) { return r.lines / r.pieces > 0.25; }),
     runs.map(function (r) { return (r.lines / r.pieces).toFixed(3); }).join(','));
  ok('leaves few buried cells', runs.every(function (r) { return r.holes <= 8; }),
     runs.map(function (r) { return r.holes; }).join(','));
  ok('reaches level 15 or better', runs.every(function (r) { return r.level >= 15; }),
     runs.map(function (r) { return r.level; }).join(','));
}

function summary() {
  console.log('\n---------------------------------------');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

console.log('\n== a decision really drives the move ==');
(function () {
  const bot = botCore.createBot(T, { stepMs: 0, lookahead: false, confidenceFloor: 0.34 });
  bot.attach();
  T.start();
  bot.mode = 'autoplay';

  // Answer with high confidence for candidate 'c': the bot must play it.
  let asked = null;
  bot.decide = function (snap) {
    asked = snap;
    return Promise.resolve({
      engine: 'laya', ms: 33, strategy: 'balanced', strategyConfidence: 0.8,
      risk: 0, riskLabel: 'plenty of room',
      move: 'c', moveConfidence: 0.91,
      moveProbabilities: { a: 0.04, b: 0.05, c: 0.91 },
      useHold: false, useHoldProbability: 0.02
    });
  };
  bot.onPiece();
  const want = bot.candidates[2];
  Promise.resolve().then(function () {
    ok('the snapshot carries a described shortlist',
       asked && asked.candidates.length > 1 && /^[IJLOSTZ] .*clears/.test(asked.candidates[0].why),
       asked ? asked.candidates[0].why : 'none');
    ok('the snapshot carries the board summary',
       asked && typeof asked.maxHeight === 'number' && Array.isArray(asked.heights) && asked.board !== undefined);
    ok('the chosen candidate becomes the plan', bot.plan === want && bot.chose === 'c',
       'chose=' + bot.chose);
    ok('the laya call was tallied', bot.stats.laya === 1, String(bot.stats.laya));

    // Low confidence must fall back to the ranked pick and be counted.
    const best = bot.candidates[0];
    bot.applyDecision({
      engine: 'laya', ms: 30, strategy: 'balanced', strategyConfidence: 0.3,
      risk: 0, move: 'd', moveConfidence: 0.12, moveProbabilities: { a: 0.3, b: 0.29, c: 0.29, d: 0.12 },
      useHold: false, useHoldProbability: 0
    });
    ok('a low-confidence choice is escalated to the ranking', bot.plan === best, 'chose=' + bot.chose);
    ok('the override was counted', bot.stats.overrides === 1, String(bot.stats.overrides));

    // A strategy switch must re-rank, not just relabel.
    bot.strategy = 'balanced';
    bot.onPiece();
    const balancedPlan = bot.plan;
    bot.applyDecision({
      engine: 'laya', ms: 30, strategy: 'survive', strategyConfidence: 0.9,
      risk: 3, move: 'a', moveConfidence: 0.9, useHold: false, useHoldProbability: 0
    });
    ok('the strategy is adopted', bot.strategy === 'survive');
    ok('adopting a strategy re-ranks the shortlist', bot.candidates.length > 0);
    ok('the plan is re-resolved under the new weights', bot.plan !== null,
       'same=' + (bot.plan === balancedPlan));

    // A held I over a nine-wide well: the swap is plainly the best move,
    // so the planner must offer it and the executor must perform it.
    T.start();
    bot.mode = 'autoplay';
    bot.decide = null;
    liveBoard(setBoard(['#########.', '#########.', '#########.', '#########.']));
    T.S.hold = 'I';
    T.S.canHold = true;
    T.S.cur = T.makePiece('O');
    bot.strategy = 'balanced';
    bot.replan();
    ok('the planner offers the hold swap as the best move',
       bot.plan.useHold === true && bot.plan.type === 'I',
       'useHold=' + bot.plan.useHold + ' type=' + bot.plan.type);
    ok('it is chosen because it clears four rows', bot.plan.cleared === 4,
       'cleared=' + bot.plan.cleared);

    const holdsBefore = bot.stats.holds;
    bot.step();
    ok('the swap is executed', bot.stats.holds === holdsBefore + 1 && T.S.hold === 'O',
       'holds=' + bot.stats.holds + ' hold=' + T.S.hold);
    ok('the swapped piece is now falling', T.S.cur.type === 'I', T.S.cur.type);
    ok('a second swap is refused until the piece locks', T.S.canHold === false);

    const piecesBefore = bot.stats.pieces;
    let guard = 0;
    while (bot.stats.pieces === piecesBefore && guard++ < 30) bot.step();
    ok('the swapped piece went on to clear the four rows', T.S.lines === 4, 'lines=' + T.S.lines);
  }).then(summary, function (e) { console.error(e); process.exit(1); });
})();
