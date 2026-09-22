/* Runs every suite. Usage: node tests/all.js */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

// 'real-model' loads the actual 1.69 GB checkpoint and skips itself, loudly,
// when the bundle is not cached - so this never triggers a download.
const suites = ['logic', 'bot', 'decide', 'ui', 'e2e', 'real-model'];
const results = [];
let failed = 0;

for (const name of suites) {
  const r = spawnSync(process.execPath, [path.join(__dirname, name + '-test.js')], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const line = (out.trim().split('\n').pop() || '').trim();
  const bad = r.status !== 0;
  if (bad) failed++;
  results.push({ name, line, bad, out });
  if (bad) console.log(out);
}

console.log('\n================ summary ================');
for (const r of results) {
  const label = /SKIPPED|is not cached/.test(r.line) ? 'skip' : r.bad ? 'FAIL' : 'ok  ';
  console.log('  ' + label + '  ' + r.name.padEnd(12) + r.line);
}
const total = results.reduce(function (a, r) {
  const m = r.line.match(/(\d+) passed/);
  return a + (m ? Number(m[1]) : 0);
}, 0);
console.log('  ' + total + ' assertions across ' + suites.length + ' suites');
process.exit(failed ? 1 : 0);
