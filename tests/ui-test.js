/* ------------------------------------------------------------------ *
 * ui-test.js - the page glue in index.html.
 *
 * The glue is the one layer with no module boundary: it reaches into
 * the markup by id and into all three modules by name. A typo there
 * throws only in a real browser, so this checks the ids against the
 * markup and then runs the glue against stubs and a live sidecar.
 * Run with:  node tests/ui-test.js
 * ------------------------------------------------------------------ */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadGame, elStub } = require('./dom-stub.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const glue = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));

console.log('\n== the markup and the glue agree ==');
{
  const declared = new Set();
  const re = /id="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) declared.add(m[1]);

  const used = new Set();
  const re2 = /getElementById\('([^']+)'\)|\bq\('([^']+)'\)/g;
  while ((m = re2.exec(glue))) used.add(m[1] || m[2]);

  const missing = Array.from(used).filter(function (id) { return !declared.has(id); });
  ok('every id the glue looks up exists in the markup (' + used.size + ' ids)',
     missing.length === 0, missing.join(','));

  // Scripts are classic (not modules) and must load in dependency order.
  const order = (html.match(/<script src="([^"]+)"/g) || []).map(function (s) {
    return s.match(/src="([^"]+)"/)[1];
  });
  ok('game.js, bot.js then laya-client.js, in that order',
     order.join(',') === 'game.js,bot.js,laya-client.js', order.join(','));
  ok('no type="module" (the page must work from file:// too)', !/<script[^>]+type="module"/.test(html));
  ok('the engine panel is in the markup', /class="card engine"/.test(html));
  ok('the mode buttons carry their modes',
     ['off', 'assist', 'autoplay'].every(function (mo) { return html.includes('data-mode="' + mo + '"'); }));
}

function startServer() {
  const child = spawn(process.execPath, [path.join(root, 'server', 'server.mjs')], {
    env: Object.assign({}, process.env, { PORT: '0', LAYA: '0' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise(function (resolve, reject) {
    let out = '';
    child.stdout.on('data', function (b) {
      out += b;
      const m = out.match(/http:\/\/localhost:(\d+)\/\n/);
      if (m) resolve({ child: child, port: Number(m[1]) });
    });
    setTimeout(function () { reject(new Error('no port')); }, 8000);
  });
}

(async function () {
  const srv = await startServer();
  try {
    console.log('\n== the glue runs ==');
    const env = loadGame();

    // Panel elements, with the children the glue walks over.
    const panel = {};
    ['eBadge', 'eSpeed', 'eLoop', 'eWait', 'eStrategy', 'eStrategyBar', 'eStrategyWhy',
     'eRiskLabel', 'eCands', 'eWhy', 'eTally', 'eReason'].forEach(function (id) {
      panel[id] = elStub(id);
    });
    panel.eRisk = elStub('eRisk');
    panel.eRisk.children = [elStub('i'), elStub('i'), elStub('i'), elStub('i')];
    panel.eMode = elStub('eMode');
    panel.eMode.children = ['off', 'assist', 'autoplay'].map(function (mo) {
      const b = elStub('b'); b.dataset = { mode: mo }; return b;
    });
    panel.eSpeed.value = '0';
    panel.eLoop.checked = true;
    panel.eWait.checked = false;

    const intervals = [];
    const document = {
      getElementById: function (id) { return panel[id] || env.els[id] || elStub(id); },
      addEventListener: function () {},
      createElement: function () {
        const e = elStub('div');
        e.querySelector = function () { return elStub('txt'); };
        return e;
      }
    };
    const keyHandlers = [];
    const window = {
      Tetris: env.T,
      TetrisBotCore: env.botCore,
      LayaClient: require(path.join(root, 'laya-client.js')),
      addEventListener: function (t, f) { if (t === 'keydown') keyHandlers.push(f); },
      devicePixelRatio: 2
    };
    globalThis.location = { protocol: 'http:', origin: 'http://127.0.0.1:' + srv.port };

    let threw = null;
    try {
      new Function('window', 'document', 'location', 'fetch', 'performance', 'setInterval',
                   'setTimeout', 'clearTimeout', 'AbortController', 'Array', 'Number', 'Math', 'Set',
        glue)(
        window, document, globalThis.location, fetch, performance,
        function (fn, ms) { intervals.push({ fn: fn, ms: ms }); return intervals.length; },
        setTimeout, clearTimeout, AbortController, Array, Number, Math, Set
      );
    } catch (e) { threw = e; }
    ok('the glue executes without throwing', threw === null, threw && threw.message);

    const bot = window.__bot, client = window.__client;
    ok('it exposes the bot and the client for the console', !!bot && !!client);
    ok('it points the client at the sidecar', client.endpoint.endsWith(':' + srv.port), client.endpoint);
    ok('it wired the bot into the game hooks', env.T.hooks.piece !== null && env.T.hooks.frame !== null);
    ok('it installed a decide function', typeof bot.decide === 'function');
    ok('it registered the mode hotkey', keyHandlers.length > 0);
    ok('it started with the engine off', bot.mode === 'off');
    ok('the badge reads idle while off', panel.eBadge.textContent === 'idle', panel.eBadge.textContent);
    ok('it scheduled the health poll and the autoplay loop', intervals.length === 2, String(intervals.length));

    console.log('\n== switching to autoplay renders a decision ==');
    panel.eMode.children[2].dataset.mode = 'autoplay';
    // Click through the same handler the page uses.
    const clickHandler = panel.eMode.handlers.click[0];
    clickHandler({ target: { closest: function () { return panel.eMode.children[2]; } } });
    ok('the mode switched', bot.mode === 'autoplay', bot.mode);
    ok('the game started', env.T.S.running === true);

    // Real frame time: the decisions are real HTTP round trips, and the
    // glue leaves stepMs at 55, so the bot needs wall-clock time to play.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && bot.stats.fallback < 6 && !env.T.S.over) {
      await new Promise(function (r) { setTimeout(r, 16); });
      bot.tick(16);
    }
    ok('decisions came back from the sidecar', bot.stats.fallback >= 6,
       'fallback=' + bot.stats.fallback + ' offline=' + bot.stats.offline);
    ok('the decision object reached the panel', bot.decision && bot.decision.engine === 'fallback',
       JSON.stringify(bot.decision && bot.decision.engine));
    ok('the badge reports the real engine', panel.eBadge.textContent === 'fallback', panel.eBadge.textContent);
    ok('the strategy field was filled in',
       panel.eStrategy.textContent.length > 0 && panel.eStrategy.textContent !== '—',
       panel.eStrategy.textContent);
    ok('the strategy explainer was filled in', panel.eStrategyWhy.textContent.length > 10,
       panel.eStrategyWhy.textContent);
    ok('the risk label was filled in', panel.eRiskLabel.textContent.length > 0, panel.eRiskLabel.textContent);
    ok('the risk meter was lit', panel.eRisk.children.some(function (c) { return /on\d/.test(c.className); }),
       panel.eRisk.children.map(function (c) { return c.className; }).join('|'));
    ok('the candidate rows were rendered', panel.eCands.appended > 0, String(panel.eCands.appended));
    ok('the tally was rendered', /pieces \d+/.test(panel.eTally.textContent), panel.eTally.textContent.split('\n')[0]);
    ok('the latency line mentions the engine', panel.eWhy.textContent.length > 0, panel.eWhy.textContent);
    ok('the fallback reason is shown', panel.eReason.hidden === false && panel.eReason.textContent.length > 0,
       panel.eReason.textContent);
    ok('the game is progressing', env.T.S.score > 0 && bot.stats.pieces > 3,
       'score=' + env.T.S.score + ' pieces=' + bot.stats.pieces);

    console.log('\n== the wait-for-laya toggle is wired ==');
    ok('it starts off', bot.opt.waitForDecision === false);
    panel.eWait.checked = true;
    panel.eWait.handlers.change[0]();
    ok('enabling it makes the bot hold each piece for an answer',
       bot.opt.waitForDecision === true, String(bot.opt.waitForDecision));
    panel.eWait.checked = false;
    panel.eWait.handlers.change[0]();
    ok('and it can be turned back off', bot.opt.waitForDecision === false);

    console.log('\n== the speed control is wired ==');
    panel.eSpeed.value = '140';
    panel.eSpeed.handlers.change[0]();
    ok('changing speed updates the step interval', bot.opt.stepMs === 140, String(bot.opt.stepMs));

    console.log('\n== turning the engine off ==');
    clickHandler({ target: { closest: function () { return panel.eMode.children[0]; } } });
    ok('mode is off', bot.mode === 'off');
    ok('the plan is cleared', bot.plan === null && bot.candidates.length === 0);
    ok('the badge goes back to idle', panel.eBadge.textContent === 'idle', panel.eBadge.textContent);
  } finally {
    srv.child.kill('SIGKILL');
  }

  console.log('\n---------------------------------------');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
