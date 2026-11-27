/* Dev-time guard for audit F2: does index.html still declare, at script level, every name venus-tools.js reads?
   Run:  npm i acorn && node tests/check-index-globals.js path/to/index.html     (exit 1 if anything is missing)
   Keep the list in sync with SOURCE_NEEDS in venus-tools.js. */
const fs = require('fs'), acorn = require('acorn');
const NEED = ['studyHours', 'dailyStudyBreakdown', 'skillsData', 'goals', 'gamification', 'SLEEP_DEBT_CFG', 'Wellness',
  'getStudyHoursByLocalDate', 'getSortedSleepSessions', 'buildSleepNightsByWakeDate', 'getSleepGoal', 'getSleepWakeDateVN',
  'computeSleepEfficiency', 'computeSleepDebt', 'vnMinuteOfDay', 'getVietnamDateStr'];
const file = process.argv[2]; if (!file) { console.error('usage: node tests/check-index-globals.js index.html'); process.exit(2); }
const html = fs.readFileSync(file, 'utf8'), found = new Map(), re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi; let m, parsed = 0;
while ((m = re.exec(html))) {
  const attrs = m[1] || ''; if (/\ssrc\s*=/.test(attrs) || /type\s*=\s*["']?(module|application|text\/(template|x-))/i.test(attrs) || !m[2].trim()) continue;
  let ast; try { ast = acorn.parse(m[2], { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); parsed++; }
  catch (e) { console.warn('warning: an inline script did not parse (' + e.message + ') — names inside it cannot be verified'); continue; }
  const line = (pos) => html.slice(0, m.index).split('\n').length + m[2].slice(0, pos).split('\n').length - 1;
  for (const n of ast.body) {
    if (n.type === 'VariableDeclaration') n.declarations.forEach((d) => { if (d.id.type === 'Identifier') found.set(d.id.name, n.kind + ' @ line ' + line(n.start)); });
    else if (n.type === 'FunctionDeclaration') found.set(n.id.name, 'function @ line ' + line(n.start));
  }
}
const missing = NEED.filter((n) => !found.has(n));
NEED.forEach((n) => console.log((found.has(n) ? '  ok   ' : '  MISSING ') + n + (found.has(n) ? '  (' + found.get(n) + ')' : '')));
console.log('\n' + (NEED.length - missing.length) + '/' + NEED.length + ' declared at script level (' + parsed + ' inline scripts parsed)');
process.exit(missing.length ? 1 : 0);
