
'use strict';

/* ------------------------------------------------------------------ *
 * Tetris game core.
 *
 * Owns the board, the active piece, gravity, scoring and input. Exposes
 * a control surface on window.Tetris so an external agent (bot.js) can
 * drive the same primitives a human keypress drives - there is no
 * separate "AI path" through the rules.
 * ------------------------------------------------------------------ */


const COLS = 10;
const ROWS = 20;
const CELL = 30;

const COLORS = {
  I: '#22d3ee', J: '#4b7bec', L: '#f59e0b',
  O: '#facc15', S: '#22c55e', T: '#a855f7', Z: '#ef4444'
};

// Spawn matrices (row 0 is the top). SRS bounding boxes.
const SHAPES = {
  I: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
  J: [[1,0,0],[1,1,1],[0,0,0]],
  L: [[0,0,1],[1,1,1],[0,0,0]],
  O: [[1,1],[1,1]],
  S: [[0,1,1],[1,1,0],[0,0,0]],
  T: [[0,1,0],[1,1,1],[0,0,0]],
  Z: [[1,1,0],[0,1,1],[0,0,0]]
};
const SPAWN_X = { I: 3, J: 3, L: 3, O: 4, S: 3, T: 3, Z: 3 };

// SRS wall-kick offsets. Source table uses y-up; we store y already
// flipped so it can be applied directly to our y-down grid.
function flip(list) { return list.map(function (o) { return [o[0], -o[1]]; }); }
const KICKS_JLSTZ = {
  '0>1': flip([[0,0],[-1,0],[-1, 1],[0,-2],[-1,-2]]),
  '1>0': flip([[0,0],[ 1,0],[ 1,-1],[0, 2],[ 1, 2]]),
  '1>2': flip([[0,0],[ 1,0],[ 1,-1],[0, 2],[ 1, 2]]),
  '2>1': flip([[0,0],[-1,0],[-1, 1],[0,-2],[-1,-2]]),
  '2>3': flip([[0,0],[ 1,0],[ 1, 1],[0,-2],[ 1,-2]]),
  '3>2': flip([[0,0],[-1,0],[-1,-1],[0, 2],[-1, 2]]),
  '3>0': flip([[0,0],[-1,0],[-1,-1],[0, 2],[-1, 2]]),
  '0>3': flip([[0,0],[ 1,0],[ 1, 1],[0,-2],[ 1,-2]])
};
const KICKS_I = {
  '0>1': flip([[0,0],[-2,0],[ 1,0],[-2,-1],[ 1, 2]]),
  '1>0': flip([[0,0],[ 2,0],[-1,0],[ 2, 1],[-1,-2]]),
  '1>2': flip([[0,0],[-1,0],[ 2,0],[-1, 2],[ 2,-1]]),
  '2>1': flip([[0,0],[ 1,0],[-2,0],[ 1,-2],[-2, 1]]),
  '2>3': flip([[0,0],[ 2,0],[-1,0],[ 2, 1],[-1,-2]]),
  '3>2': flip([[0,0],[-2,0],[ 1,0],[-2,-1],[ 1, 2]]),
  '3>0': flip([[0,0],[ 1,0],[-2,0],[ 1,-2],[-2, 1]]),
  '0>3': flip([[0,0],[-1,0],[ 2,0],[-1, 2],[ 2,-1]])
};

const LINE_SCORE = [0, 100, 300, 500, 800];
const LOCK_DELAY = 500;      // ms a grounded piece waits before locking
const MAX_LOCK_RESETS = 15;  // classic 15-move rule
const DAS_DELAY = 160;       // ms before auto-repeat starts
const DAS_RATE = 45;         // ms between auto-repeat steps
const SOFT_RATE = 40;        // ms per cell while holding down

/* ---------------------------------- DOM --------------------------- */

const boardCv = document.getElementById('board');
const bctx = boardCv.getContext('2d');
const nextCv = document.getElementById('next');
const nctx = nextCv.getContext('2d');
const holdCv = document.getElementById('hold');
const hctx = holdCv.getContext('2d');

const el = {
  score: document.getElementById('score'),
  lines: document.getElementById('lines'),
  level: document.getElementById('level'),
  best: document.getElementById('best'),
  overlay: document.getElementById('overlay'),
  ovTitle: document.getElementById('ovTitle'),
  ovText: document.getElementById('ovText'),
  ovFinal: document.getElementById('ovFinal'),
  ovBtn: document.getElementById('ovBtn'),
  toast: document.getElementById('toast')
};

// Crisp rendering on high-DPI screens: scale the backing store, keep
// the CSS size at the logical pixel size.
function setupCanvas(cv, ctx) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = cv.width, h = cv.height;
  cv.style.width = w + 'px';
  cv.style.height = 'auto';
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: w, h: h };
}
const BOARD_SIZE = setupCanvas(boardCv, bctx);
const NEXT_SIZE = setupCanvas(nextCv, nctx);
const HOLD_SIZE = setupCanvas(holdCv, hctx);

/* --------------------------------- state -------------------------- */

// Agent hooks. bot.js sets these; the core never assumes they exist.
const hooks = {
  piece: null,   // called after a new piece becomes active
  frame: null,   // called once per animation frame while play is live
  lock: null     // called after a piece locks, with the lines it cleared
};

const S = {
  board: [],
  cur: null,
  queue: [],
  bag: [],
  hold: null,
  canHold: true,
  score: 0,
  lines: 0,
  level: 1,
  best: 0,
  combo: -1,
  running: false,
  paused: false,
  over: false,
  gravityAcc: 0,
  lockAcc: 0,
  lockResets: 0,
  grounded: false
};

function emptyBoard() {
  const b = [];
  for (let y = 0; y < ROWS; y++) b.push(new Array(COLS).fill(null));
  return b;
}

/* -------------------------------- storage ------------------------- */

function loadBest() {
  try {
    const v = parseInt(localStorage.getItem('tetris.best') || '0', 10);
    return isNaN(v) ? 0 : v;
  } catch (e) { return 0; }
}
function saveBest(v) {
  try { localStorage.setItem('tetris.best', String(v)); } catch (e) { /* ignore */ }
}

/* ------------------------------ piece logic ----------------------- */

function refillBag() {
  const types = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
  for (let i = types.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = types[i]; types[i] = types[j]; types[j] = t;
  }
  S.bag = types;
}
function nextType() {
  if (S.bag.length === 0) refillBag();
  return S.bag.pop();
}
function clone(m) { return m.map(function (r) { return r.slice(); }); }

function makePiece(type) {
  return { type: type, m: clone(SHAPES[type]), x: SPAWN_X[type], y: 0, r: 0 };
}

function rotateMatrix(m, dir) {
  const n = m.length;
  const out = [];
  for (let y = 0; y < n; y++) out.push(new Array(n).fill(0));
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (dir > 0) out[x][n - 1 - y] = m[y][x];   // clockwise
      else out[n - 1 - x][y] = m[y][x];           // counter-clockwise
    }
  }
  return out;
}

// Cells above the board (y < 0) are free so pieces can spawn/kick upward.
// Board-agnostic so the planner can test placements on a hypothetical board.
function collidesOn(board, m, px, py) {
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m[y].length; x++) {
      if (!m[y][x]) continue;
      const bx = px + x, by = py + y;
      if (bx < 0 || bx >= COLS || by >= ROWS) return true;
      if (by >= 0 && board[by][bx]) return true;
    }
  }
  return false;
}

function collides(m, px, py) { return collidesOn(S.board, m, px, py); }

function spawn(type) {
  S.cur = makePiece(type === undefined ? S.queue.shift() : type);
  while (S.queue.length < 3) S.queue.push(nextType());
  S.gravityAcc = 0;
  resetLock();
  if (collides(S.cur.m, S.cur.x, S.cur.y)) {
    gameOver();
    return false;
  }
  if (hooks.piece) hooks.piece();
  return true;
}

function resetLock() {
  S.lockAcc = 0;
  S.lockResets = 0;
  S.grounded = false;
}

function touchingFloor() {
  return collides(S.cur.m, S.cur.x, S.cur.y + 1);
}

// Any successful move/rotation while grounded restarts the lock timer,
// up to MAX_LOCK_RESETS, then the piece locks regardless.
function noteMove() {
  if (!S.grounded) return;
  if (S.lockResets < MAX_LOCK_RESETS) {
    S.lockResets++;
    S.lockAcc = 0;
  }
}

function move(dx) {
  if (collides(S.cur.m, S.cur.x + dx, S.cur.y)) return false;
  S.cur.x += dx;
  noteMove();
  return true;
}

function softStep(fromPlayer) {
  if (collides(S.cur.m, S.cur.x, S.cur.y + 1)) return false;
  S.cur.y++;
  if (fromPlayer) addScore(1);
  S.lockAcc = 0;
  return true;
}

// Pure SRS rotation: returns the rotated piece (first kick that fits) or
// null if every kick is blocked. The live rotate() and the bot's planner
// both go through this, so a planned rotation is always reproducible.
function rotatedPiece(board, p, dir) {
  if (p.type === 'O') return { type: p.type, m: p.m, x: p.x, y: p.y, r: p.r };
  const from = p.r;
  const to = (from + (dir > 0 ? 1 : 3)) % 4;
  const m = rotateMatrix(p.m, dir);
  const table = p.type === 'I' ? KICKS_I : KICKS_JLSTZ;
  const kicks = table[from + '>' + to];
  for (let i = 0; i < kicks.length; i++) {
    const nx = p.x + kicks[i][0];
    const ny = p.y + kicks[i][1];
    if (!collidesOn(board, m, nx, ny)) {
      return { type: p.type, m: m, x: nx, y: ny, r: to };
    }
  }
  return null;
}

function rotate(dir) {
  if (S.cur.type === 'O') return false;
  const np = rotatedPiece(S.board, S.cur, dir);
  if (!np) return false;
  S.cur.m = np.m; S.cur.x = np.x; S.cur.y = np.y; S.cur.r = np.r;
  noteMove();
  return true;
}

function ghostY() {
  let y = S.cur.y;
  while (!collides(S.cur.m, S.cur.x, y + 1)) y++;
  return y;
}

function hardDrop() {
  const target = ghostY();
  const dist = target - S.cur.y;
  if (dist > 0) addScore(dist * 2);
  S.cur.y = target;
  lockPiece();
}

function holdPiece() {
  if (!S.canHold) return;
  const type = S.cur.type;
  if (S.hold === null) {
    S.hold = type;
    spawn();
  } else {
    const swap = S.hold;
    S.hold = type;
    spawn(swap);
  }
  S.canHold = false;
  drawHold();
  drawNext();
}

function lockPiece() {
  const p = S.cur;
  let topOut = true;
  for (let y = 0; y < p.m.length; y++) {
    for (let x = 0; x < p.m[y].length; x++) {
      if (!p.m[y][x]) continue;
      const by = p.y + y, bx = p.x + x;
      if (by < 0) continue;            // part of the piece is above the field
      S.board[by][bx] = p.type;
      topOut = false;
    }
  }
  if (topOut) { gameOver(); return; }  // locked entirely above the field

  const cleared = clearLines();
  scoreClear(cleared);
  S.canHold = true;
  if (hooks.lock) hooks.lock(cleared);
  if (!S.over) spawn();
  drawNext();
}

function clearLines() {
  let cleared = 0;
  for (let y = ROWS - 1; y >= 0; y--) {
    let full = true;
    for (let x = 0; x < COLS; x++) {
      if (!S.board[y][x]) { full = false; break; }
    }
    if (full) {
      S.board.splice(y, 1);
      S.board.unshift(new Array(COLS).fill(null));
      cleared++;
      y++; // re-test this index, rows shifted down into it
    }
  }
  return cleared;
}

/* -------------------------------- scoring ------------------------- */

function addScore(n) {
  S.score += n;
  if (S.score > S.best) { S.best = S.score; saveBest(S.best); }
  paintStats();
}

function scoreClear(n) {
  if (n === 0) { S.combo = -1; return; }
  S.combo++;
  let gained = LINE_SCORE[n] * S.level;
  if (S.combo > 0) gained += 50 * S.combo * S.level;
  addScore(gained);

  S.lines += n;
  const newLevel = Math.floor(S.lines / 10) + 1;
  if (newLevel > S.level) { S.level = newLevel; toast('Level ' + S.level); }
  else {
    const names = ['', 'Single', 'Double', 'Triple', 'Tetris!'];
    toast(S.combo > 0 ? names[n] + ' x' + (S.combo + 1) : names[n]);
  }
  paintStats();
}

function paintStats() {
  el.score.textContent = S.score.toLocaleString();
  el.lines.textContent = S.lines;
  el.level.textContent = S.level;
  el.best.textContent = S.best.toLocaleString();
}

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.remove('pop');
  void el.toast.offsetWidth; // restart the animation
  el.toast.classList.add('pop');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.toast.classList.remove('pop'); }, 950);
}

// Tetris-guideline style curve: level 1 is ~1s per cell, dropping fast.
function gravityMs() {
  const n = S.level - 1;
  const base = Math.max(0.05, 0.8 - n * 0.007);
  return Math.max(28, Math.pow(base, n) * 1000);
}

/* ------------------------------- rendering ------------------------ */

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (amt > 0) {
    r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt;
  } else {
    r *= (1 + amt); g *= (1 + amt); b *= (1 + amt);
  }
  return 'rgb(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ')';
}

const SHADES = {};
Object.keys(COLORS).forEach(function (t) {
  SHADES[COLORS[t]] = {
    base: COLORS[t],
    light: shade(COLORS[t], 0.34),
    dark: shade(COLORS[t], -0.3)
  };
});
function shadesFor(color) {
  if (!SHADES[color]) {
    SHADES[color] = { base: color, light: shade(color, 0.34), dark: shade(color, -0.3) };
  }
  return SHADES[color];
}

function drawCell(ctx, px, py, size, color, alpha) {
  ctx.globalAlpha = alpha === undefined ? 1 : alpha;
  const sh = shadesFor(color);
  const pad = Math.max(1, Math.round(size * 0.06));
  const x = px + pad, y = py + pad, s = size - pad * 2;
  const lip = Math.max(1, Math.round(s * 0.16));
  ctx.fillStyle = sh.base;
  ctx.fillRect(x, y, s, s);
  ctx.fillStyle = sh.light;
  ctx.fillRect(x, y, s, lip);
  ctx.fillStyle = sh.dark;
  ctx.fillRect(x, y + s - lip, s, lip);
  ctx.strokeStyle = 'rgba(0,0,0,.4)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
  ctx.globalAlpha = 1;
}

function drawGhostCell(ctx, px, py, size, color) {
  const pad = Math.max(1, Math.round(size * 0.06));
  const x = px + pad, y = py + pad, s = size - pad * 2;
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, s, s);
  ctx.globalAlpha = 0.6;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, s - 2, s - 2);
  ctx.globalAlpha = 1;
}

// Optional extra layer drawn after the board (bot plan/hint overlay).
let overlayPainter = null;

function drawBoard() {
  bctx.clearRect(0, 0, BOARD_SIZE.w, BOARD_SIZE.h);
  bctx.fillStyle = '#121a2e';
  bctx.fillRect(0, 0, BOARD_SIZE.w, BOARD_SIZE.h);

  // grid
  bctx.strokeStyle = 'rgba(255,255,255,.045)';
  bctx.lineWidth = 1;
  for (let x = 1; x < COLS; x++) {
    bctx.beginPath();
    bctx.moveTo(x * CELL + 0.5, 0);
    bctx.lineTo(x * CELL + 0.5, ROWS * CELL);
    bctx.stroke();
  }
  for (let y = 1; y < ROWS; y++) {
    bctx.beginPath();
    bctx.moveTo(0, y * CELL + 0.5);
    bctx.lineTo(COLS * CELL, y * CELL + 0.5);
    bctx.stroke();
  }

  // settled blocks
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const t = S.board[y][x];
      if (t) drawCell(bctx, x * CELL, y * CELL, CELL, COLORS[t]);
    }
  }

  if (!S.cur || S.over) return;

  // ghost, then the live piece
  const gy = ghostY();
  const p = S.cur;
  for (let y = 0; y < p.m.length; y++) {
    for (let x = 0; x < p.m[y].length; x++) {
      if (!p.m[y][x]) continue;
      const by = gy + y;
      if (by >= 0 && by !== p.y + y) drawGhostCell(bctx, (p.x + x) * CELL, by * CELL, CELL, COLORS[p.type]);
    }
  }
  for (let y = 0; y < p.m.length; y++) {
    for (let x = 0; x < p.m[y].length; x++) {
      if (!p.m[y][x]) continue;
      const by = p.y + y;
      if (by >= 0) drawCell(bctx, (p.x + x) * CELL, by * CELL, CELL, COLORS[p.type]);
    }
  }

  if (overlayPainter) overlayPainter(bctx, CELL);
}

// Trim a shape matrix to the rows/cols that actually hold blocks so the
// preview boxes stay visually centred.
function bounds(m) {
  let minX = 99, maxX = -1, minY = 99, maxY = -1;
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m[y].length; x++) {
      if (!m[y][x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX: minX, maxX: maxX, minY: minY, maxY: maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function drawPreview(ctx, type, boxX, boxY, boxW, boxH, size) {
  const m = SHAPES[type];
  const b = bounds(m);
  const ox = boxX + (boxW - b.w * size) / 2;
  const oy = boxY + (boxH - b.h * size) / 2;
  for (let y = b.minY; y <= b.maxY; y++) {
    for (let x = b.minX; x <= b.maxX; x++) {
      if (!m[y][x]) continue;
      drawCell(ctx, ox + (x - b.minX) * size, oy + (y - b.minY) * size, size, COLORS[type]);
    }
  }
}

function drawNext() {
  nctx.clearRect(0, 0, NEXT_SIZE.w, NEXT_SIZE.h);
  const slot = NEXT_SIZE.h / 3;
  for (let i = 0; i < 3 && i < S.queue.length; i++) {
    const size = i === 0 ? 22 : 18;
    drawPreview(nctx, S.queue[i], 0, i * slot, NEXT_SIZE.w, slot, size);
  }
}

function drawHold() {
  hctx.clearRect(0, 0, HOLD_SIZE.w, HOLD_SIZE.h);
  if (!S.hold) {
    hctx.fillStyle = 'rgba(138,150,184,.55)';
    hctx.font = '600 11px ui-sans-serif, sans-serif';
    hctx.textAlign = 'center';
    hctx.textBaseline = 'middle';
    hctx.fillText('empty', HOLD_SIZE.w / 2, HOLD_SIZE.h / 2);
    return;
  }
  hctx.globalAlpha = S.canHold ? 1 : 0.45;
  drawPreview(hctx, S.hold, 0, 0, HOLD_SIZE.w, HOLD_SIZE.h, 22);
  hctx.globalAlpha = 1;
}

/* --------------------------------- input -------------------------- */

const held = { left: false, right: false, down: false };
const dasTimer = { left: 0, right: 0 };
let softAcc = 0;

function startHold(dir) {
  if (!S.running || S.paused || S.over) return;
  if (dir === 'left') { held.left = true; dasTimer.left = -DAS_DELAY; move(-1); }
  else { held.right = true; dasTimer.right = -DAS_DELAY; move(1); }
}

function act(name) {
  if (name === 'pause') { togglePause(); return; }
  if (name === 'restart') { restart(); return; }
  if (!S.running || S.paused || S.over) return;
  switch (name) {
    case 'left': startHold('left'); break;
    case 'right': startHold('right'); break;
    case 'cw': rotate(1); break;
    case 'ccw': rotate(-1); break;
    case 'soft': held.down = true; softAcc = SOFT_RATE; break;
    case 'hard': hardDrop(); break;
    case 'hold': holdPiece(); break;
  }
}

const KEYMAP = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'soft',
  ArrowUp: 'cw', KeyX: 'cw', KeyZ: 'ccw',
  Space: 'hard', KeyC: 'hold', ShiftLeft: 'hold', ShiftRight: 'hold',
  KeyP: 'pause', Escape: 'pause', KeyR: 'restart'
};

window.addEventListener('keydown', function (e) {
  const action = KEYMAP[e.code];
  if (!action) return;
  e.preventDefault();
  if (e.repeat) return;  // we run our own auto-repeat
  if (!S.running && !S.over && action !== 'pause') { start(); return; }
  if (S.over && (action === 'hard' || action === 'restart')) { restart(); return; }
  act(action);
});

window.addEventListener('keyup', function (e) {
  const action = KEYMAP[e.code];
  if (!action) return;
  e.preventDefault();
  if (action === 'left') held.left = false;
  if (action === 'right') held.right = false;
  if (action === 'soft') held.down = false;
});

window.addEventListener('blur', function () {
  held.left = held.right = held.down = false;
  if (S.running && !S.over && !S.paused) togglePause();
});

// On-screen buttons: press-and-hold repeats for the movement keys.
document.getElementById('touch').addEventListener('pointerdown', function (e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  e.preventDefault();
  const name = btn.dataset.act;
  if (!S.running && !S.over && name !== 'pause') { start(); return; }
  if (S.over) { restart(); return; }
  act(name);
});
document.addEventListener('pointerup', function () {
  held.left = held.right = held.down = false;
});
document.addEventListener('pointercancel', function () {
  held.left = held.right = held.down = false;
});

// Swipe/tap on the board itself.
(function () {
  let sx = 0, sy = 0, st = 0, moved = false;
  boardCv.addEventListener('pointerdown', function (e) {
    sx = e.clientX; sy = e.clientY; st = performance.now(); moved = false;
    boardCv.setPointerCapture(e.pointerId);
  });
  boardCv.addEventListener('pointermove', function (e) {
    if (!st) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy)) {
      act(dx > 0 ? 'right' : 'left');
      held.left = held.right = false;
      sx = e.clientX; moved = true;
    } else if (dy > 28 && Math.abs(dy) > Math.abs(dx)) {
      act('soft'); held.down = false; softStep(true);
      sy = e.clientY; moved = true;
    }
  });
  boardCv.addEventListener('pointerup', function (e) {
    const dt = performance.now() - st;
    const dy = e.clientY - sy;
    st = 0;
    if (!S.running && !S.over) { start(); return; }
    if (S.over) { restart(); return; }
    if (moved) { if (dy > 90 && dt < 320) act('hard'); return; }
    if (dt < 260) act('cw');
  });
})();

el.ovBtn.addEventListener('click', function () {
  if (S.over) restart();
  else if (S.paused) togglePause();
  else start();
});

/* ------------------------------- game flow ------------------------ */

function showOverlay(title, text, finalLine) {
  el.ovTitle.textContent = title;
  el.ovText.textContent = text;
  if (finalLine) { el.ovFinal.textContent = finalLine; el.ovFinal.hidden = false; }
  else el.ovFinal.hidden = true;
  el.overlay.classList.add('show');
}
function hideOverlay() { el.overlay.classList.remove('show'); }

function reset() {
  S.board = emptyBoard();
  S.bag = [];
  S.queue = [];
  S.hold = null;
  S.canHold = true;
  S.score = 0;
  S.lines = 0;
  S.level = 1;
  S.combo = -1;
  S.over = false;
  S.paused = false;
  S.gravityAcc = 0;
  resetLock();
  held.left = held.right = held.down = false;
  refillBag();
  for (let i = 0; i < 3; i++) S.queue.push(nextType());
  spawn();
  paintStats();
  drawNext();
  drawHold();
  drawBoard();
}

function start() {
  reset();
  S.running = true;
  hideOverlay();
  el.ovBtn.textContent = 'Play';
}

function restart() { start(); }

function togglePause() {
  if (!S.running || S.over) return;
  S.paused = !S.paused;
  if (S.paused) {
    held.left = held.right = held.down = false;
    el.ovBtn.textContent = 'Resume';
    showOverlay('Paused', 'Press P to resume');
  } else {
    hideOverlay();
    el.ovBtn.textContent = 'Play';
  }
}

function gameOver() {
  S.over = true;
  S.running = false;
  held.left = held.right = held.down = false;
  el.ovBtn.textContent = 'Play again';
  showOverlay(
    'Game Over',
    'Press R or Space to play again',
    'Score ' + S.score.toLocaleString() + '  ·  Lines ' + S.lines + '  ·  Level ' + S.level
  );
  drawBoard();
}

/* -------------------------------- main loop ----------------------- */

let last = performance.now();

function frame(now) {
  let dt = now - last;
  last = now;
  if (dt > 100) dt = 100;  // a backgrounded tab must not fast-forward the game
  if (dt < 0) dt = 0;      // never run the clock backwards

  if (S.running && !S.paused && !S.over) {
    if (hooks.frame) hooks.frame(dt);

    // horizontal auto-repeat
    ['left', 'right'].forEach(function (dir) {
      if (!held[dir]) { dasTimer[dir] = 0; return; }
      dasTimer[dir] += dt;
      while (dasTimer[dir] >= DAS_RATE) {
        dasTimer[dir] -= DAS_RATE;
        move(dir === 'left' ? -1 : 1);
      }
    });

    // gravity / soft drop
    if (held.down) {
      softAcc += dt;
      while (softAcc >= SOFT_RATE) { softAcc -= SOFT_RATE; if (!softStep(true)) break; }
    } else {
      softAcc = 0;
    }
    S.gravityAcc += dt;
    const step = gravityMs();
    while (S.gravityAcc >= step) {
      S.gravityAcc -= step;
      if (!softStep(false)) break;
    }

    // lock delay
    if (S.cur && touchingFloor()) {
      if (!S.grounded) { S.grounded = true; S.lockAcc = 0; }
      S.lockAcc += dt;
      if (S.lockAcc >= LOCK_DELAY) lockPiece();
    } else if (S.grounded) {
      S.grounded = false;   // walked off a ledge; timer restarts on landing
      S.lockAcc = 0;
    }
  }

  drawBoard();
  requestAnimationFrame(frame);
}


/* ------------------------------ public API ------------------------ */

// Everything an agent needs: read the state, issue the same primitives
// a keypress issues, and hook into the piece/frame/lock lifecycle.
window.Tetris = {
  S: S,
  hooks: hooks,
  COLS: COLS, ROWS: ROWS, SHAPES: SHAPES, COLORS: COLORS, SPAWN_X: SPAWN_X,
  // primitives
  move: move, rotate: rotate, softStep: softStep, hardDrop: hardDrop,
  holdPiece: holdPiece, lockPiece: lockPiece,
  // queries
  collides: collides, collidesOn: collidesOn, rotatedPiece: rotatedPiece,
  ghostY: ghostY, rotateMatrix: rotateMatrix,
  makePiece: makePiece, clone: clone, touchingFloor: touchingFloor,
  // flow
  start: start, restart: restart, togglePause: togglePause, reset: reset,
  spawn: spawn, clearLines: clearLines, gravityMs: gravityMs, act: act,
  toast: toast, frame: frame,
  // rendering hook for overlays drawn on top of the board
  setOverlayPainter: function (fn) { overlayPainter = fn; },
  boardCtx: function () { return bctx; },
  cellSize: CELL
};

/* --------------------------------- boot --------------------------- */

S.best = loadBest();
reset();
S.running = false;
showOverlay('Ready?', 'Arrows to move · Up to rotate · Space to hard drop');
requestAnimationFrame(frame);
