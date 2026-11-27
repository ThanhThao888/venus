/* Test: audit F2 (a renamed Tracker global must be reported, never turned into a fake zero) + regression of Review.
   Run:  cd <repo> && npm i jsdom && node tests/f2-sources.test.js
   Uses the REAL venus-tools.js and venus-review.js. The Tracker is faked by a classic <script> that declares page-level let/const/var,
   exactly like index.html does (verified with an AST scan), so the bare-name lookups behave as in the browser. */
const fs = require('fs'), path = require('path'), assert = require('assert');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Every declaration is listed by name so a test can leave one out (= "index.html renamed it").
const DECLS = {
  studyHours: 'let studyHours = {};',
  dailyStudyBreakdown: 'var dailyStudyBreakdown = {};',
  skillsData: 'const skillsData = {};',
  goals: 'let goals = [];',
  gamification: 'let gamification = { streak: 0 };',
  SLEEP_DEBT_CFG: 'const SLEEP_DEBT_CFG = { tolerance: 0.25, longNightHours: 14 };',
  Wellness: 'const Wellness = { getDaySummary: () => null };',
  getVietnamDateStr: 'function getVietnamDateStr() { return window.__TODAY; }',
  getStudyHoursByLocalDate: 'function getStudyHoursByLocalDate() { return {}; }',
  getSortedSleepSessions: 'function getSortedSleepSessions() { return window.__SESSIONS || []; }',
  buildSleepNightsByWakeDate: 'function buildSleepNightsByWakeDate(s) { return s.map(x => ({ date: getSleepWakeDateVN(x), hours: x.duration / 3.6e6 })); }',
  getSleepGoal: 'function getSleepGoal() { return 8; }',
  getSleepWakeDateVN: 'function getSleepWakeDateVN(s) { return new Date(s.start + s.duration + 7 * 3600e3).toISOString().slice(0, 10); }',
  computeSleepEfficiency: 'function computeSleepEfficiency() { return 95; }',
  computeSleepDebt: 'function computeSleepDebt() { return { ok: false, reason: "not_enough_data", logged: 0, needed: 5 }; }',
  vnMinuteOfDay: 'function vnMinuteOfDay() { return 0; }'
};

// 9 nights, wake dates 2026-11-19 … 2026-11-27
const sessions9 = () => Array.from({ length: 9 }, (_, i) => ({ start: Date.UTC(2026, 10, 19 + i, 0, 0), duration: 7 * 3600e3 }));

async function make({ omit = [], today = '2026-11-27', sessions = sessions9(), localGoals = null, decisions = [] } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://venus.test/' });
  const w = dom.window;
  w.__TODAY = today; w.__SESSIONS = sessions;
  if (localGoals) w.localStorage.setItem('goals', JSON.stringify(localGoals));
  w.VenusAI = { isConfigured: async () => false };                   // ai.js is not fetched by jsdom; "not configured" is enough here
  w.VenusMemory = { listDecisions: async () => decisions };            // enough for the review dialog + reminder
  const run = (code) => { const s = w.document.createElement('script'); s.textContent = code; w.document.head.appendChild(s); };
  run(Object.keys(DECLS).filter((k) => omit.indexOf(k) < 0).map((k) => DECLS[k]).join('\n'));
  run(read('venus-tools.js'));
  run(read('venus-review.js'));
  return w;
}
const J = (v) => JSON.parse(JSON.stringify(v));
const eq = (a, b) => assert.deepStrictEqual(J(a), b);
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const results = []; let failed = 0;
async function t(name, fn) { try { await fn(); results.push('  ok   ' + name); } catch (e) { failed++; results.push('  FAIL ' + name + '\n       ' + (e && e.message || e)); } }

(async () => {
  /* ── healthy wiring ── */
  await t('healthy: get_data_sources_status says ok, nothing missing', async () => {
    const w = await make(); const r = await w.VenusTools.run('get_data_sources_status', {}, {});
    assert.ok(r.ok); assert.strictEqual(r.data.ok, true);
    ['study', 'sleep', 'goals'].forEach((g) => eq(r.data.groups[g].missing, []));
  });
  await t('healthy: tool is registered at L0', async () => {
    const w = await make(); const x = w.VenusTools.list().find((o) => o.name === 'get_data_sources_status');
    assert.ok(x && x.level === 'L0_READ');
  });
  await t('healthy: partial packet has 9 nights, no unavailable, not degraded', async () => {
    const w = await make(); const r = await w.VenusReview.buildPacket('2026-11', { partial: true, memory: false });
    assert.strictEqual(r.packet.sleep.nights_logged, 9); eq(r.unavailable, []);
    assert.strictEqual(r.degraded, false); assert.strictEqual(r.empty, false); assert.strictEqual(r.packet.unavailable, undefined);
  });

  /* ── the actual F2 case: a renamed global ── */
  await t('renamed dailyStudyBreakdown: study tool reports it (totals unaffected)', async () => {
    const w = await make({ omit: ['dailyStudyBreakdown'] }); const r = await w.VenusTools.run('get_study_summary', { from: '2026-11-01', to: '2026-11-27' }, {});
    assert.ok(r.ok); eq(r.data.missing_sources, ['dailyStudyBreakdown']); assert.strictEqual(r.data.total_hours, 0);
  });
  await t('renamed dailyStudyBreakdown: Review packet lists study:missing_… and is degraded', async () => {
    const w = await make({ omit: ['dailyStudyBreakdown'] }); const r = await w.VenusReview.buildPacket('2026-11', { partial: true, memory: false });
    assert.ok(r.unavailable.indexOf('study:missing_dailyStudyBreakdown') >= 0); assert.strictEqual(r.degraded, true);
    assert.ok(r.packet.unavailable.indexOf('study:missing_dailyStudyBreakdown') >= 0);
    assert.ok(w.VenusReview._t.digestLines(r.packet).some((l) => /Không đọc được: .*study:missing_dailyStudyBreakdown/.test(l)));
  });
  await t('renamed studyHours: reported', async () => {
    const w = await make({ omit: ['studyHours'] }); const r = await w.VenusTools.run('get_study_summary', { from: '2026-11-01', to: '2026-11-27' }, {});
    eq(r.data.missing_sources, ['studyHours']);
  });
  await t('renamed Wellness / SLEEP_DEBT_CFG: sleep group reports both', async () => {
    const w = await make({ omit: ['Wellness', 'SLEEP_DEBT_CFG'] }); const r = await w.VenusTools.run('get_sleep_wellness_summary', { from: '2026-11-01', to: '2026-11-27', include_text: false }, {});
    assert.ok(r.ok); eq(r.data.missing_sources.sort(), ['SLEEP_DEBT_CFG', 'Wellness']); assert.strictEqual(r.data.sleep.nights_logged, 9);
  });
  await t('missing optional sleep helper (getSleepWakeDateVN) is reported, not silent', async () => {
    const w = await make({ omit: ['getSleepWakeDateVN'] });
    const r = await w.VenusTools.run('get_data_sources_status', {}, {});
    assert.strictEqual(r.data.ok, false); eq(r.data.groups.sleep.missing, ['getSleepWakeDateVN']);
  });
  await t('renamed goals: localStorage fallback still returns data, and the gap is reported', async () => {
    const w = await make({ omit: ['goals'], localGoals: [{ id: 1, title: 'Học ACCA', target: 100, currentProgress: 10 }] });
    const r = await w.VenusTools.run('get_goals_and_deadlines', {}, {});
    assert.ok(r.ok); assert.strictEqual(r.data.goals.length, 1); eq(r.data.missing_sources, ['goals']);
  });
  await t('goals present live: no missing_sources', async () => {
    const w = await make(); const r = await w.VenusTools.run('get_goals_and_deadlines', {}, {});
    eq(r.data.missing_sources, []);
  });

  /* ── empty vs. degraded ── */
  await t('empty + healthy ⇒ empty, NOT degraded (user really has not logged)', async () => {
    const w = await make({ sessions: [] }); const r = await w.VenusReview.buildPacket('2026-10', { memory: false });
    assert.strictEqual(r.empty, true); assert.strictEqual(r.degraded, false);
  });
  await t('empty + study source missing ⇒ empty AND degraded', async () => {
    const w = await make({ sessions: [], omit: ['studyHours'] }); const r = await w.VenusReview.buildPacket('2026-10', { memory: false });
    assert.strictEqual(r.empty, true); assert.strictEqual(r.degraded, true);
  });
  await t('goals-only gap does not mark a really-empty month as degraded', async () => {
    const w = await make({ sessions: [], omit: ['goals'] }); const r = await w.VenusReview.buildPacket('2026-10', { memory: false });
    assert.strictEqual(r.empty, true); assert.strictEqual(r.degraded, false); assert.ok(r.unavailable.indexOf('goals:missing_goals') >= 0);
  });

  /* ── UI ── */
  const open = async (w) => { w.VenusReview.open(); await tick(); };
  const click = (w, text) => { const b = Array.from(w.document.querySelectorAll('button')).find((x) => x.textContent === text); assert.ok(b, 'button not found: ' + text); b.click(); return b; };
  const waitText = async (w, re) => { for (let i = 0; i < 60; i++) { const tx = w.document.querySelector('#vpisReviewDlg').textContent; if (re.test(tx)) return tx; await tick(20); } throw new Error('text never appeared: ' + re); };

  await t('UI: empty + degraded shows the wiring warning and keeps "Gửi cho AI" disabled', async () => {
    const w = await make({ sessions: [], omit: ['studyHours'] }); await open(w); click(w, 'Chuẩn bị số liệu');
    const tx = await waitText(w, /Số liệu đang trống/); assert.ok(/lỗi đấu nối/.test(tx)); assert.ok(!/chưa có dữ liệu học, ngủ hay wellness/.test(tx));
    const send = Array.from(w.document.querySelectorAll('button')).find((x) => /Gửi cho AI/.test(x.textContent)); assert.ok(send && send.disabled);
  });
  await t('UI: empty + healthy still shows the original "chưa có dữ liệu" message', async () => {
    const w = await make({ sessions: [] }); await open(w); click(w, 'Chuẩn bị số liệu');
    const tx = await waitText(w, /chưa có dữ liệu học, ngủ hay wellness/); assert.ok(!/lỗi đấu nối/.test(tx));
  });
  await t('UI: back to setup resets the degraded flag', async () => {
    const w = await make({ sessions: [], omit: ['studyHours'] }); await open(w); click(w, 'Chuẩn bị số liệu'); await waitText(w, /Số liệu đang trống/);
    click(w, 'Quay lại'); await waitText(w, /Chọn tháng/); click(w, 'Chuẩn bị số liệu'); await waitText(w, /Số liệu đang trống/);
  });

  /* ── prompt ── */
  await t('system prompt carries rule (8) about unavailable sources and the schema line is intact', async () => {
    const w = await make(); const r = await w.VenusReview.buildPacket('2026-11', { partial: true, memory: false });
    const m = w.VenusReview._t.buildMessages(r.packet, '2026-11'); assert.ok(/\(8\).*unavailable.*KHÔNG đọc được/.test(m[0].content)); assert.ok(/\(7\)/.test(m[0].content) && /Chỉ trả về MỘT đối tượng JSON/.test(m[0].content));
  });

  /* ── reminder banner (regression + new reason) ── */
  await t('reminder: day 27 ⇒ outside_window (regression)', async () => {
    const w = await make(); eq(await w.VenusReview.checkReminder(), { shown: false, why: 'outside_window' });
  });
  await t('reminder: day 2 with last-month data ⇒ banner shown, review opens on last month', async () => {
    const w = await make({ today: '2026-12-02', sessions: sessions9() }); const r = await w.VenusReview.checkReminder();
    assert.strictEqual(r.shown, true); assert.strictEqual(r.label, '2026-11'); assert.ok(w.document.getElementById('vpisRevBanner'));
    w.document.querySelector('#vpisRevBanner .vpis-rev-btn--pri').click(); await tick();
    assert.ok(w.VenusReview.isOpen()); assert.ok(/Tháng 11\/2026/.test(w.document.querySelector('#vpisReviewDlg select').selectedOptions[0].textContent));
  });
  await t('reminder: day 2, last month empty, healthy ⇒ no_data', async () => {
    const w = await make({ today: '2026-12-02', sessions: [] }); eq(await w.VenusReview.checkReminder(), { shown: false, why: 'no_data' });
  });
  await t('reminder: day 2, last month empty, source missing ⇒ sources_unavailable (no banner)', async () => {
    const w = await make({ today: '2026-12-02', sessions: [], omit: ['studyHours'] }); const r = await w.VenusReview.checkReminder();
    eq(r, { shown: false, why: 'sources_unavailable' }); assert.ok(!w.document.getElementById('vpisRevBanner'));
  });
  await t('reminder: already reviewed ⇒ no banner (regression)', async () => {
    const w = await make({ today: '2026-12-02', decisions: [{ type: 'review_summary', title: 'Review tháng 2026-11', tags: ['review', '2026-11'] }] });
    eq(await w.VenusReview.checkReminder(), { shown: false, why: 'already_reviewed' });
  });
  await t('reminder: a partial review does not count as the full one (regression)', async () => {
    const w = await make({ today: '2026-12-02', decisions: [{ type: 'review_summary', title: 'Review tháng 2026-11 (đến 27/11)', tags: ['review', '2026-11', 'partial'] }] });
    assert.strictEqual((await w.VenusReview.checkReminder()).shown, true);
  });

  /* ── month logic (regression) ── */
  await t('months: options on 27/11 start at 2026-10; partial range compares equal day counts', async () => {
    const w = await make(); const T = w.VenusReview._t;
    assert.strictEqual(T.monthOptions('2026-11-27')[0], '2026-10'); assert.strictEqual(T.monthOptions('2026-01-05')[0], '2025-12');
    const r = await w.VenusReview.buildPacket('2026-11', { partial: true, memory: false });
    eq([r.packet.period.from, r.packet.period.to, r.packet.previous.from, r.packet.previous.to], ['2026-11-01', '2026-11-27', '2026-10-01', '2026-10-27']);
    assert.strictEqual(T.rangeOf('2026-02', 31).to, '2026-02-28');
  });
  await t('partial is refused for a month that is not the current one (regression)', async () => {
    const w = await make(); await assert.rejects(() => w.VenusReview.buildPacket('2026-10', { partial: true, memory: false }), /bad_month/);
  });

  console.log(results.join('\n')); console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
