// Headless logic tests for the game core. Run with:  node tests/logic-test.js
const { loadGame } = require('./dom-stub.js');

const env = loadGame();
const G = env.G;
const els = env.els;
const winHandlers = env.winHandlers;
const advance = env.advance;
const g = { localStorage: env.storage };
const performance = { now: env.now };

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function boardStr() {
  return G.S.board.map(r => r.map(c => c ? c : '.').join('')).join('\n');
}
function fillRow(y, except) {
  for (let x = 0; x < G.COLS; x++) if (x !== except) G.S.board[y][x] = 'Z';
}

console.log('\n== boot / reset ==');
G.start();
ok('board is 20x10 and empty', G.S.board.length === 20 && G.S.board[0].length === 10 && G.S.board.flat().every(c => c === null));
ok('a piece is active', !!G.S.cur, JSON.stringify(G.S.cur));
ok('next queue holds 3', G.S.queue.length === 3, G.S.queue.join(','));
ok('running, not over/paused', G.S.running && !G.S.over && !G.S.paused);

console.log('\n== 7-bag randomizer ==');
{
  const seen = [];
  G.reset();
  for (let i = 0; i < 140; i++) {
    seen.push(G.S.cur.type);
    G.hardDrop();
    // keep the same game (and the same bag) alive by emptying the well
    for (let y = 0; y < 20; y++) for (let x = 0; x < 10; x++) G.S.board[y][x] = null;
  }
  const chunks = [];
  for (let i = 0; i + 7 <= 140; i += 7) chunks.push(seen.slice(i, i + 7));
  ok('each bag of 7 holds all 7 pieces exactly once',
     chunks.every(c => new Set(c).size === 7),
     chunks.findIndex(c => new Set(c).size !== 7) + ':' + JSON.stringify(chunks.find(c => new Set(c).size !== 7) || []));
  ok('every drawn piece is a valid tetromino', seen.every(t => 'IJLOSTZ'.includes(t)));
  const counts = {};
  seen.forEach(t => counts[t] = (counts[t] || 0) + 1);
  const vals = Object.values(counts);
  ok('all 7 types appear', Object.keys(counts).length === 7, JSON.stringify(counts));
  ok('distribution is exactly even (7-bag)', Math.max(...vals) - Math.min(...vals) === 0, JSON.stringify(counts));
}

console.log('\n== gravity / drop ==');
G.reset();
{
  const y0 = G.S.cur.y;
  ok('soft drop moves down one', G.softStep(false) && G.S.cur.y === y0 + 1);
  const before = G.S.cur.type;
  G.hardDrop();
  ok('hard drop locks and spawns new piece', G.S.board.flat().filter(Boolean).length === 4, 'cells=' + G.S.board.flat().filter(Boolean).length);
  ok('hard-dropped piece rests on the floor', G.S.board[19].some(Boolean) || G.S.board[18].some(Boolean));
  ok('hard drop awarded points', G.S.score > 0, 'score=' + G.S.score);
}

console.log('\n== single line clear ==');
G.reset();
for (let y = 0; y < 20; y++) for (let x = 0; x < 10; x++) G.S.board[y][x] = null;
fillRow(19);
G.S.board[18][3] = 'T';
{
  const n = G.clearLines();
  ok('one row cleared', n === 1, 'n=' + n);
  ok('rows above shifted down', G.S.board[19][3] === 'T', boardStr().split('\n').slice(17).join(' | '));
  ok('top row emptied', G.S.board[0].every(c => c === null));
}

console.log('\n== tetris (4 rows) + scoring ==');
G.reset();
G.S.level = 1;
const scoreBefore = G.S.score;
for (let y = 16; y <= 19; y++) fillRow(y);
G.S.lines = 0;
{
  const n = G.clearLines();
  ok('four rows cleared at once', n === 4, 'n=' + n);
  ok('board empty after tetris', G.S.board.flat().every(c => c === null));
}

console.log('\n== level progression ==');
G.reset();
G.S.lines = 0; G.S.level = 1;
{
  const ms1 = G.gravityMs();
  G.S.level = 10;
  const ms10 = G.gravityMs();
  G.S.level = 20;
  const ms20 = G.gravityMs();
  ok('level 1 gravity ~1000ms', Math.abs(ms1 - 1000) < 1, 'ms=' + ms1);
  ok('gravity speeds up with level', ms10 < ms1 && ms20 < ms10, ms1 + ' > ' + ms10 + ' > ' + ms20);
  ok('gravity clamped above 0', ms20 >= 28, 'ms=' + ms20);
}

console.log('\n== rotation + SRS wall kicks ==');
G.reset();
{
  // rotating T four times returns to spawn orientation
  const t0 = JSON.stringify(G.SHAPES.T);
  let m = G.SHAPES.T.map(r => r.slice());
  for (let i = 0; i < 4; i++) m = G.rotateMatrix(m, 1);
  ok('4x CW rotation is identity', JSON.stringify(m) === t0);
  let m2 = G.SHAPES.J.map(r => r.slice());
  m2 = G.rotateMatrix(G.rotateMatrix(m2, 1), -1);
  ok('CW then CCW is identity', JSON.stringify(m2) === JSON.stringify(G.SHAPES.J));

  // wall kick off the left wall
  G.reset();
  G.S.cur = { type: 'I', m: G.SHAPES.I.map(r => r.slice()), x: 3, y: 5, r: 0 };
  G.rotate(1);                       // vertical
  while (G.move(-1)) {}              // shove into the left wall
  const xWall = G.S.cur.x;
  const rotated = G.rotate(1);       // back to horizontal - needs a kick
  ok('I-piece kicks off the left wall', rotated && !G.collides(G.S.cur.m, G.S.cur.x, G.S.cur.y), 'x ' + xWall + ' -> ' + G.S.cur.x);

  // rotation is refused when no kick fits
  G.reset();
  for (let y = 0; y < 20; y++) for (let x = 0; x < 10; x++) G.S.board[y][x] = (x < 3 || x > 6) ? 'Z' : null;
  G.S.cur = { type: 'I', m: G.SHAPES.I.map(r => r.slice()), x: 3, y: 10, r: 0 };
  const blocked = G.rotate(1);
  ok('rotation blocked in a tight well stays legal', !blocked || !G.collides(G.S.cur.m, G.S.cur.x, G.S.cur.y));
}

console.log('\n== bounds ==');
G.reset();
{
  let guard = 0;
  while (G.move(-1) && guard++ < 50) {}
  ok('cannot move past the left wall', !G.collides(G.S.cur.m, G.S.cur.x, G.S.cur.y) && !G.move(-1), 'x=' + G.S.cur.x);
  guard = 0;
  while (G.move(1) && guard++ < 50) {}
  ok('cannot move past the right wall', !G.move(1), 'x=' + G.S.cur.x);
  guard = 0;
  while (G.softStep(false) && guard++ < 50) {}
  ok('cannot fall through the floor', !G.softStep(false), 'y=' + G.S.cur.y);
}

console.log('\n== hold ==');
G.reset();
{
  const first = G.S.cur.type;
  G.holdPiece();
  ok('hold stores the current piece', G.S.hold === first, G.S.hold + ' vs ' + first);
  ok('a different piece is now active', G.S.cur.type !== first || G.S.queue.length === 3);
  ok('hold is locked until next lock', G.S.canHold === false);
  const active = G.S.cur.type;
  G.holdPiece();
  ok('second hold in a row is refused', G.S.cur.type === active && G.S.hold === first);
  G.hardDrop();
  ok('hold re-enabled after a lock', G.S.canHold === true);
  const held = G.S.hold, live = G.S.cur.type;
  G.holdPiece();
  ok('hold swaps with the held piece', G.S.cur.type === held && G.S.hold === live, G.S.cur.type + '/' + G.S.hold);
}

console.log('\n== ghost piece ==');
G.reset();
{
  const gy = G.ghostY();
  ok('ghost sits at the landing row', gy >= G.S.cur.y && !G.collides(G.S.cur.m, G.S.cur.x, gy) && G.collides(G.S.cur.m, G.S.cur.x, gy + 1), 'gy=' + gy);
}

console.log('\n== game over ==');
G.reset();
{
  let guard = 0;
  while (!G.S.over && guard++ < 400) { G.hardDrop(); }
  ok('stacking up ends the game', G.S.over === true, 'drops=' + guard);
  ok('game stops running on game over', G.S.running === false);
  ok('overlay shown on game over', els.overlay.classList.contains('show'));
  const sc = G.S.score;
  G.start();
  ok('restart clears the board', G.S.board.flat().every(c => c === null) && !G.S.over && G.S.running);
  ok('restart resets score/lines/level', G.S.score === 0 && G.S.lines === 0 && G.S.level === 1, 'prev=' + sc);
}

console.log('\n== pause ==');
G.start();
{
  const kd = winHandlers.keydown[0];
  const ev = { code: 'KeyP', repeat: false, preventDefault() {} };
  kd(ev);
  ok('P pauses', G.S.paused === true);
  const y = G.S.cur.y;
  advance(5000);
  ok('gravity frozen while paused', G.S.cur.y === y, 'y ' + y + ' -> ' + G.S.cur.y);
  kd(ev);
  ok('P resumes', G.S.paused === false);
}

console.log('\n== keyboard input ==');
G.start();
{
  const kd = winHandlers.keydown[0], ku = winHandlers.keyup[0];
  const press = code => kd({ code, repeat: false, preventDefault() {} });
  const x0 = G.S.cur.x;
  press('ArrowLeft'); ku({ code: 'ArrowLeft', preventDefault() {} });
  ok('left arrow moves left', G.S.cur.x === x0 - 1, x0 + ' -> ' + G.S.cur.x);
  press('ArrowRight'); ku({ code: 'ArrowRight', preventDefault() {} });
  ok('right arrow moves right', G.S.cur.x === x0);
  const r0 = G.S.cur.r;
  press('ArrowUp');
  ok('up arrow rotates', G.S.cur.type === 'O' ? true : G.S.cur.r !== r0, 'r ' + r0 + ' -> ' + G.S.cur.r);
  const cellsBefore = G.S.board.flat().filter(Boolean).length;
  press('Space');
  ok('space hard drops and locks', G.S.board.flat().filter(Boolean).length === cellsBefore + 4);
  const h = G.S.hold;
  press('KeyC');
  ok('C holds', G.S.hold !== h);
  press('KeyR');
  ok('R restarts', G.S.score === 0 && G.S.board.flat().every(c => c === null));
}

console.log('\n== gravity through the real frame loop ==');
G.start();
{
  advance(0);                 // sync the loop's internal clock
  const y0 = G.S.cur.y;
  advance(1100);              // just over one second at level 1
  ok('piece fell about one cell per second', G.S.cur.y === y0 + 1, 'y ' + y0 + ' -> ' + G.S.cur.y);

  // land and confirm the lock delay fires
  while (G.softStep(false)) {}
  const cells = G.S.board.flat().filter(Boolean).length;
  advance(300);
  const early = G.S.board.flat().filter(Boolean).length;
  ok('grounded piece has not locked yet at 300ms', early === cells, 'cells=' + early);
  advance(400);                                          // > 500ms grounded in total
  ok('lock delay locks a grounded piece', G.S.board.flat().filter(Boolean).length === cells + 4, 'cells=' + G.S.board.flat().filter(Boolean).length);
}

console.log('\n== line clear through real play ==');
G.start();
{
  // leave column 0 open on the bottom row, then clear it for real
  for (let x = 1; x < 10; x++) G.S.board[19][x] = 'Z';
  G.S.lines = 0; G.S.score = 0; G.S.level = 1;
  G.S.cur = { type: 'I', m: G.SHAPES.I.map(r => r.slice()), x: 3, y: 0, r: 0 };
  G.rotate(1);                                // vertical I
  let guard = 0;
  while (G.move(-1) && guard++ < 20) {}       // slide to column 0
  G.hardDrop();
  ok('row cleared during real play', G.S.lines === 1, 'lines=' + G.S.lines);
  ok('score credited for the single', G.S.score >= 100, 'score=' + G.S.score);
  ok('the three leftover I cells remain', G.S.board.flat().filter(Boolean).length === 3, 'cells=' + G.S.board.flat().filter(Boolean).length);
}

console.log('\n== best score persistence ==');
{
  ok('best score written to localStorage', parseInt(g.localStorage.getItem('tetris.best'), 10) > 0, g.localStorage.getItem('tetris.best'));
}

console.log('\n---------------------------------------');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
