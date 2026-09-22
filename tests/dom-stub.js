/* ------------------------------------------------------------------ *
 * dom-stub.js - loads the real game.js (and optionally bot.js) in Node
 * behind a minimal document/canvas stub, so the tests exercise the same
 * code the browser runs instead of a reimplementation.
 * ------------------------------------------------------------------ */

const fs = require('fs');
const path = require('path');

function ctxStub() {
  const store = {};
  return new Proxy(store, {
    get(t, k) { return k in t ? t[k] : function () {}; },
    set(t, k, v) { t[k] = v; return true; }
  });
}

function elStub(id) {
  return {
    id, width: 300, height: 600, style: {}, dataset: {}, textContent: '',
    hidden: false, offsetWidth: 1, innerHTML: '', title: '', children: [],
    value: '', checked: false, className: '',
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }
    },
    handlers: {},
    addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); },
    getContext() { return ctxStub(); },
    setPointerCapture() {},
    appended: 0,
    querySelector() { return elStub('q'); },
    appendChild() { this.appended++; },
    closest() { return null; }
  };
}

const IDS = ['board','next','hold','score','lines','level','best','overlay','ovTitle',
             'ovText','ovFinal','ovBtn','toast','touch'];

function loadGame(opts) {
  const o = opts || {};
  const root = path.join(__dirname, '..');
  const els = {};
  IDS.forEach(i => { els[i] = elStub(i); });
  els.next.width = 120; els.next.height = 216;
  els.hold.width = 120; els.hold.height = 72;

  const winHandlers = {}, docHandlers = {};
  let clock = 1000;

  const storage = {
    _d: {},
    getItem(k) { return k in this._d ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); }
  };

  const document = {
    getElementById: id => els[id],
    addEventListener: (t, f) => { (docHandlers[t] = docHandlers[t] || []).push(f); },
    createElement: () => elStub('new')
  };
  const window = {
    devicePixelRatio: o.dpr || 2,
    addEventListener: (t, f) => { (winHandlers[t] = winHandlers[t] || []).push(f); }
  };
  const performance = { now: () => clock };

  // game.js: run it with the internals returned so tests can poke at them.
  const src = fs.readFileSync(path.join(root, 'game.js'), 'utf8');
  const exposed = `;return {S,spawn,lockPiece,hardDrop,rotate,move,softStep,ghostY,holdPiece,
    clearLines,collides,collidesOn,rotatedPiece,start,reset,frame,gravityMs,act,SHAPES,
    COLS,ROWS,rotateMatrix,hooks};`;
  const fn = new Function('document', 'window', 'performance', 'requestAnimationFrame',
                          'localStorage', 'navigator', src + exposed);
  const G = fn(document, window, performance, () => 0, storage, {});
  const T = window.Tetris;

  // bot.js is written to run in Node too (module.exports), so require it.
  const botCore = o.bot === false ? null : require(path.join(root, 'bot.js'));

  function advance(ms, step) {
    const s = step || 16;
    const end = clock + ms;
    while (clock < end) { clock = Math.min(clock + s, end); G.frame(clock); }
  }

  return {
    G, T, els, winHandlers, docHandlers, storage, botCore,
    advance,
    now: () => clock,
    tick: (ms) => { clock += ms; G.frame(clock); }
  };
}

module.exports = { loadGame, elStub, ctxStub };
