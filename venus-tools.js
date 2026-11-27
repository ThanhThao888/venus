/* Venus Hub — Tool Registry (venus-tools.js) · VPIS Phase 1A
   Sits next to index.html. Classic <script> (NOT type="module"): it must share the page's global lexical scope so it can
   read studyHours / goals / skillsData … the same way ai-hub.js does.

   • The single doorway for AI (and later workflows) to reach app data: VenusTools.run(name, input, ctx).
   • Phase 1A tools are READ-ONLY: five L0_READ tools that WRAP existing calculators (nothing is re-implemented or moved).
     It never writes localStorage / IndexedDB / the Vault, and it adds no storage of its own.
   • Permission levels:
       L0_READ            runs immediately.
       L1_DRAFT           runs, result is marked draft:true (never persisted by the registry).
       L2_WRITE_APPROVAL  needs ctx.approvedByUser === true AND expected_revision (input or ctx); every attempt is reported
                          to the audit sink (venus-memory.js plugs it into audit_logs; its L2 tools live there).
       L3_DESTRUCTIVE     locked — always refused.
   • Public API: VenusTools.run(name,input,ctx) (alias call) · list() · register(spec) · setAuditSink(fn) · LEVELS · version */
(function () {
  'use strict';
  if (window.VenusTools) return;

  /* ───────── small helpers ───────── */
  const safe = (fn, dflt) => { try { const v = fn(); return v === undefined ? dflt : v; } catch (e) { return dflt; } };
  const hasFn = (n) => typeof window[n] === 'function';
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const avg = (a) => (a.length ? sum(a) / a.length : null);
  const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
  const r1 = (v) => (isNum(v) ? Math.round(v * 10) / 10 : null);
  const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
  const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  // Pure-UTC day arithmetic: never touches the page's patched local-time Date behaviour.
  const dayNum = (ds) => Math.round(Date.UTC(+ds.slice(0, 4), +ds.slice(5, 7) - 1, +ds.slice(8, 10)) / 864e5);
  const dayStr = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
  const todayVN = () => {
    if (hasFn('getVietnamDateStr')) { const s = safe(() => getVietnamDateStr(), null); if (s && ISO_DATE.test(s)) return s; }
    return new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);   // Vietnam = UTC+7, no DST
  };
  const nowIso = () => new Date().toISOString();                            // real UTC (verified in console)

  /* ───────── levels, registry, audit ───────── */
  const LEVELS = Object.freeze({ L0_READ: 'L0_READ', L1_DRAFT: 'L1_DRAFT', L2_WRITE_APPROVAL: 'L2_WRITE_APPROVAL', L3_DESTRUCTIVE: 'L3_DESTRUCTIVE' });
  const registry = new Map();
  let auditSink = null;
  function audit(rec) { if (typeof auditSink !== 'function') return; try { Promise.resolve(auditSink(rec)).catch(() => {}); } catch (e) { /* audit must never break a call */ } }
  function fail(code, message, extra) { return Object.assign({ ok: false, error: { code, message } }, extra || {}); }

  /* Tiny input validator. Schema: { field: { type:'date'|'string'|'int'|'number'|'boolean'|'enum'|'string_array', optional?, min?, max?, maxLen?, values? (enum), maxItems?/itemMaxLen? (string_array), def? } }.
     Unknown fields are dropped. 'number' accepts finite floats and CLAMPS to min/max like 'int'; 'enum' must match one of `values`; 'string_array' is trimmed, de-duplicated and stripped of empties. */
  function validate(input, schema) {
    const src = input && typeof input === 'object' ? input : {}, out = {};
    for (const k of Object.keys(schema || {})) {
      const f = schema[k]; let v = src[k];
      if (v === undefined || v === null || v === '') {
        if (f.def !== undefined) { out[k] = f.def; continue; }
        if (f.optional) continue;
        return { error: 'Thiếu tham số bắt buộc: ' + k };
      }
      if (f.type === 'date') { if (typeof v !== 'string' || !ISO_DATE.test(v) || isNaN(dayNum(v))) return { error: k + ' phải có dạng YYYY-MM-DD' }; }
      else if (f.type === 'string') { if (typeof v !== 'string') return { error: k + ' phải là chuỗi' }; v = v.trim(); if (!v && !f.optional) return { error: k + ' không được rỗng' }; if (f.maxLen && v.length > f.maxLen) return { error: k + ' dài quá ' + f.maxLen + ' ký tự' }; }
      else if (f.type === 'int') { v = Number(v); if (!Number.isInteger(v)) return { error: k + ' phải là số nguyên' }; if (f.min != null && v < f.min) v = f.min; if (f.max != null && v > f.max) v = f.max; }
      else if (f.type === 'number') { if (typeof v === 'string' && v.trim() === '') return { error: k + ' phải là số' }; v = Number(v); if (!isFinite(v)) return { error: k + ' phải là số' }; if (f.min != null && v < f.min) v = f.min; if (f.max != null && v > f.max) v = f.max; }
      else if (f.type === 'boolean') { v = v === true || v === 'true'; }
      else if (f.type === 'enum') { if (!Array.isArray(f.values) || f.values.indexOf(v) < 0) return { error: k + ' phải là một trong: ' + (f.values || []).join(', ') }; }
      else if (f.type === 'string_array') {
        if (!Array.isArray(v)) return { error: k + ' phải là mảng chuỗi' };
        const seen = new Set(), arr = [];
        for (const it of v) {
          if (typeof it !== 'string') return { error: k + ' chỉ được chứa chuỗi' };
          const t = it.trim(); if (!t) continue;
          if (f.itemMaxLen && t.length > f.itemMaxLen) return { error: 'Phần tử của ' + k + ' dài quá ' + f.itemMaxLen + ' ký tự' };
          if (!seen.has(t)) { seen.add(t); arr.push(t); }
        }
        if (f.maxItems && arr.length > f.maxItems) return { error: k + ' tối đa ' + f.maxItems + ' phần tử' };
        v = arr;
      }
      out[k] = v;
    }
    return { value: out };
  }

  function register(spec) {
    if (!spec || typeof spec.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(spec.name)) throw new Error('VenusTools.register: tên tool không hợp lệ');
    if (!LEVELS[spec.level]) throw new Error('VenusTools.register: level không hợp lệ cho ' + spec.name);
    if (typeof spec.handler !== 'function') throw new Error('VenusTools.register: thiếu handler cho ' + spec.name);
    if (registry.has(spec.name)) throw new Error('VenusTools.register: tool đã tồn tại: ' + spec.name);   // never silently replace a tool
    registry.set(spec.name, Object.freeze({ name: spec.name, level: spec.level, description: spec.description || '', input: spec.input || {}, output: spec.output || '', handler: spec.handler }));
    return spec.name;
  }

  function list() {
    return Array.from(registry.values()).map((t) => ({ name: t.name, level: t.level, description: t.description, input: t.input, output: t.output }));
  }

  async function run(name, input, ctx) {
    const t0 = Date.now(); ctx = ctx || {};
    const tool = registry.get(name);
    if (!tool) return fail('unknown_tool', 'Không có tool tên "' + name + '". Dùng VenusTools.list() để xem.');
    const meta = () => ({ tool: name, level: tool.level, ran_at: nowIso(), ms: Date.now() - t0 });

    if (tool.level === LEVELS.L3_DESTRUCTIVE) return Object.assign(fail('locked', 'Tool cấp L3_DESTRUCTIVE đang bị khóa.'), { meta: meta() });

    const v = validate(input, tool.input);
    if (v.error) { if (tool.level === LEVELS.L2_WRITE_APPROVAL) audit({ ts: nowIso(), tool_name: name, target_id: (input && input.id) || null, revision_checked: false, approved_by_user: ctx.approvedByUser === true, status: 'rejected_input' }); return Object.assign(fail('bad_input', v.error), { meta: meta() }); }

    if (tool.level === LEVELS.L2_WRITE_APPROVAL) {
      const exp = (input && input.expected_revision !== undefined) ? input.expected_revision : ctx.expected_revision;
      const target = (input && (input.id || input.target_id)) || null;
      const rec = { ts: nowIso(), tool_name: name, target_id: target, revision_checked: exp !== undefined && exp !== null, approved_by_user: ctx.approvedByUser === true };
      if (ctx.approvedByUser !== true) { audit(Object.assign(rec, { status: 'rejected_no_approval' })); return Object.assign(fail('approval_required', 'Tool ghi cần approvedByUser: true (người dùng đã duyệt đúng hành động này).'), { meta: meta() }); }
      if (exp === undefined || exp === null) { audit(Object.assign(rec, { status: 'rejected_no_revision' })); return Object.assign(fail('revision_required', 'Tool ghi cần expected_revision.'), { meta: meta() }); }
      if (!Number.isInteger(exp) || exp < 0) { audit(Object.assign(rec, { status: 'rejected_bad_revision' })); return Object.assign(fail('bad_input', 'expected_revision phải là số nguyên >= 0 (0 = tạo mới).'), { meta: meta() }); }
      try {
        const data = await tool.handler(v.value, Object.assign({}, ctx, { expected_revision: exp }));
        if (!rec.target_id && data && typeof data === 'object' && data.id) rec.target_id = String(data.id);   // creates have no id until the handler returns
        audit(Object.assign(rec, { status: 'ok' }));
        return { ok: true, data, meta: meta() };
      } catch (e) {
        audit(Object.assign(rec, { status: 'error:' + ((e && e.code) || (e && e.message) || 'unknown') }));
        return Object.assign(fail((e && e.code) || 'tool_error', (e && e.message) || 'Lỗi không rõ'), { meta: meta() });
      }
    }

    try {
      const data = await tool.handler(v.value, ctx);
      const res = { ok: true, data, meta: meta() };
      if (tool.level === LEVELS.L1_DRAFT) res.draft = true;
      return res;
    } catch (e) {
      return Object.assign(fail((e && e.code) || 'tool_error', (e && e.message) || 'Lỗi không rõ'), { meta: meta() });
    }
  }

  function toolErr(code, message) { const e = new Error(message); e.code = code; return e; }

  /* Shared {from,to} window. Defaults to the 30 days ending today (Vietnam). Capped at 400 days. */
  function range(inp) {
    const to = inp.to || todayVN();
    let from = inp.from;
    if (!from) from = dayStr(dayNum(to) - 29);
    if (dayNum(from) > dayNum(to)) throw toolErr('bad_range', 'from phải nhỏ hơn hoặc bằng to');
    const span = dayNum(to) - dayNum(from) + 1;
    if (span > 400) throw toolErr('range_too_long', 'Khoảng thời gian tối đa 400 ngày');
    return { from, to, span, fromNum: dayNum(from), toNum: dayNum(to) };
  }
  const DATE_RANGE_SCHEMA = { from: { type: 'date', optional: true }, to: { type: 'date', optional: true } };

  /* ═════════════════════════ TOOL 1: study ═════════════════════════ */
  register({
    name: 'get_study_summary', level: LEVELS.L0_READ,
    description: 'Giờ học trong khoảng ngày (mặc định 30 ngày gần nhất), đọc từ getStudyHoursByLocalDate() + dailyStudyBreakdown của Tracker.',
    input: DATE_RANGE_SCHEMA,
    output: '{ range, total_hours, span_days, active_days, avg_hours_per_day, avg_hours_per_active_day, best_day, daily[], by_skill[], breakdown_covers_from, all_time_hours, gamification }',
    handler: async (inp) => {
      if (!hasFn('getStudyHoursByLocalDate')) throw toolErr('tracker_missing', 'Không tìm thấy getStudyHoursByLocalDate của Tracker (index.html chưa tải xong?).');
      const rg = range(inp);
      const map = getStudyHoursByLocalDate();
      const daily = [];
      for (let n = rg.fromNum; n <= rg.toNum; n++) { const d = dayStr(n), h = +map[d] || 0; if (h > 0) daily.push({ date: d, hours: r2(h) }); }
      const active = daily.filter((x) => x.hours > 0.05);
      const total = sum(daily.map((x) => x.hours));
      const best = daily.reduce((a, x) => (!a || x.hours > a.hours ? x : a), null);

      const BD = safe(() => dailyStudyBreakdown, {}) || {}, SD = safe(() => skillsData, {}) || {};
      const bdDates = Object.keys(BD).filter((d) => ISO_DATE.test(d)).sort();
      const agg = {};
      bdDates.forEach((d) => { if (d >= rg.from && d <= rg.to) Object.keys(BD[d] || {}).forEach((k) => { const h = +BD[d][k] || 0; if (h > 0) agg[k] = (agg[k] || 0) + h; }); });
      const bySkill = Object.keys(agg).sort((a, b) => agg[b] - agg[a]).slice(0, 15).map((k) => {
        const c = k.split('|')[0];
        return { track: (SD[c] && SD[c].title) || c, skill: clip(k.slice(c.length + 1), 80), hours: r2(agg[k]) };
      });

      const SH = safe(() => studyHours, {}) || {};
      const allTime = sum(Object.keys(SH).map((c) => sum(Object.values(SH[c] || {}).filter(isNum))));
      const G = safe(() => gamification, null);
      return {
        range: { from: rg.from, to: rg.to }, total_hours: r2(total), span_days: rg.span, active_days: active.length,
        avg_hours_per_day: r2(total / rg.span), avg_hours_per_active_day: active.length ? r2(total / active.length) : null,
        best_day: best, daily, by_skill: bySkill,
        breakdown_covers_from: bdDates[0] || null,   // per-skill daily hours only exist from this date on
        all_time_hours: r1(allTime),
        gamification: G ? { streak: G.streak || 0, longest_streak: G.longestStreak || 0, level: G.level || 1, points: G.points || 0 } : null
      };
    }
  });

  /* ═════════════════════════ TOOL 2: sleep + wellness ═════════════════════════ */
  register({
    name: 'get_sleep_wellness_summary', level: LEVELS.L0_READ,
    description: 'Giấc ngủ + wellness trong khoảng ngày (mặc định 30 ngày): số liệu có cấu trúc để so sánh giữa các kỳ, kèm summaryText (gọi lại VenusAIHub.sleepText) khi khoảng kết thúc hôm nay.',
    input: Object.assign({ include_text: { type: 'boolean', optional: true, def: true } }, DATE_RANGE_SCHEMA),
    output: '{ range, sleep:{nights_logged,span_days,effective_span_days,logged_pct,avg_hours,median_hours,min,max,goal_hours,nights_meeting_goal,pct_meeting_goal,nights_under_6h,avg_sol_min,avg_se_pct,avg_quality,excluded_long_nights}, sleep_debt_now, wellness:{…}, summaryText }',
    handler: async (inp) => {
      const need = ['getSortedSleepSessions', 'buildSleepNightsByWakeDate', 'getSleepGoal'];
      const miss = need.filter((n) => !hasFn(n));
      if (miss.length) throw toolErr('tracker_missing', 'Không tìm thấy hàm của Sleep Tracker: ' + miss.join(', '));
      const rg = range(inp), today = todayVN();
      const goal = getSleepGoal();
      const tol = safe(() => SLEEP_DEBT_CFG.tolerance, 0.25), maxNight = safe(() => SLEEP_DEBT_CFG.longNightHours, 14), okLimit = goal - tol;

      const all = getSortedSleepSessions().filter((s) => s && isNum(s.start) && isNum(s.duration) && s.duration > 0);
      const nights = buildSleepNightsByWakeDate(all).filter((n) => n.date >= rg.from && n.date <= rg.to);
      const win = nights.filter((n) => n.hours <= maxNight), dropped = nights.length - win.length;
      // Same denominator as ai-hub.js: days from max(window start, first night ever logged) to the window end; numerator counts every logged night (incl. excluded long ones).
      const allNights = buildSleepNightsByWakeDate(all), firstNum = allNights.length ? Math.min.apply(null, allNights.map((n) => dayNum(n.date))) : rg.fromNum;
      const effSpan = Math.max(1, rg.toNum - Math.max(rg.fromNum, firstNum) + 1);
      // main session of each wake date → SOL / SE / quality (same rule as ai-hub.js)
      const mainBy = new Map();
      if (hasFn('getSleepWakeDateVN')) all.forEach((s) => { const d = getSleepWakeDateVN(s), cur = mainBy.get(d); if (!cur || s.duration > cur.duration) mainBy.set(d, s); });
      const sols = [], ses = [], qs = [];
      win.forEach((n) => {
        const s = mainBy.get(n.date); if (!s) return;
        if (isNum(s.sol)) sols.push(s.sol);
        const se = hasFn('computeSleepEfficiency') ? safe(() => computeSleepEfficiency(s), null) : null; if (isNum(se)) ses.push(se);
        if (isNum(s.quality) && s.quality > 0) qs.push(s.quality);
      });
      const hrs = win.map((n) => n.hours), meet = win.filter((n) => n.hours >= okLimit).length;
      const sleep = {
        nights_logged: win.length, span_days: rg.span, effective_span_days: effSpan, logged_pct: r1(Math.min(100, nights.length / effSpan * 100)),
        avg_hours: r2(avg(hrs)), median_hours: r2(median(hrs)), min_hours: hrs.length ? r2(Math.min.apply(null, hrs)) : null, max_hours: hrs.length ? r2(Math.max.apply(null, hrs)) : null,
        goal_hours: goal, nights_meeting_goal: meet, pct_meeting_goal: win.length ? r1(meet / win.length * 100) : null,
        nights_under_6h: hrs.filter((h) => h < 6).length,
        avg_sol_min: r1(avg(sols)), avg_se_pct: r1(avg(ses)), avg_quality: r2(avg(qs)),
        excluded_long_nights: dropped   // nights > longNightHours (likely a forgotten Stop button) are left out of every average
      };

      // Sleep debt is the app's own rolling 14-night ledger ending TODAY — it does not follow from/to.
      let debt = null;
      if (hasFn('computeSleepDebt')) {
        const d = safe(() => computeSleepDebt(), null);
        if (d) debt = d.ok
          ? { as_of: today, ok: true, debt_hours: r2(d.debt), level: d.level && d.level.label, equiv_nights: r1(d.equivNights), avg_hours: r2(d.avgHours), short_nights: d.shortNights, logged: d.logged, short_streak: d.shortStreak, trend: d.trend || null }
          : { as_of: today, ok: false, reason: d.reason || 'not_enough_data', logged: d.logged, needed: d.needed };
      }

      // Wellness: read-only snapshots through Wellness.getDaySummary (water is read from the stored record; the summary lacks it).
      const W = safe(() => Wellness, null);
      let wellness = null;
      if (W && typeof W.getDaySummary === 'function') {
        let rawDays = {};
        try { rawDays = (JSON.parse(localStorage.getItem('wellnessTrackerData_v1') || 'null') || {}).days || {}; } catch (e) { rawDays = {}; }
        let loggedDays = 0, caff = [], late = 0, workoutDays = 0, workoutMin = 0, foodCounts = [], water = [], cutoff = null;
        for (let n = rg.fromNum; n <= rg.toNum; n++) {
          const key = dayStr(n), s = safe(() => W.getDaySummary(key), null); if (!s) continue;
          cutoff = s.caffeineCutoffHour;
          const mg = sum((s.caffeine || []).map((c) => +c.mg || 0)), w = rawDays[key] && +rawDays[key].water || 0;
          const any = mg > 0 || (s.foods || []).length || s.workout || w > 0; if (!any) continue;
          loggedDays++;
          if (mg > 0) { caff.push(mg); if (hasFn('vnMinuteOfDay') && isNum(cutoff) && (s.caffeine || []).some((c) => isNum(c.t) && vnMinuteOfDay(c.t) / 60 >= cutoff)) late++; }
          if ((s.foods || []).length) foodCounts.push(s.foods.length);
          if (s.workout) { workoutDays++; workoutMin += +s.workout.minutes || 0; }
          if (w > 0) water.push(w);
        }
        wellness = {
          days_with_any_log: loggedDays,
          caffeine: { days_logged: caff.length, avg_mg_per_logged_day: r1(avg(caff)), days_after_cutoff: late, cutoff_hour: cutoff },
          meals: { days_logged: foodCounts.length, avg_items_per_logged_day: r1(avg(foodCounts)) },
          workout: { days: workoutDays, total_minutes: Math.round(workoutMin) },
          water: { days_logged: water.length, avg_per_logged_day: r1(avg(water)) }
        };
      }

      // Optional text pack: ai-hub's windows are "N days ending today", so only offered when `to` is today.
      let summaryText = null, summaryNote = null;
      if (inp.include_text) {
        if (rg.to !== today) summaryNote = 'summaryText chỉ có khi to = hôm nay (VenusAIHub tính cửa sổ N ngày kết thúc hôm nay).';
        else if (!(window.VenusAIHub && typeof window.VenusAIHub.sleepText === 'function')) summaryNote = 'VenusAIHub chưa sẵn sàng.';
        else {
          const days = Math.max(1, dayNum(today) - rg.fromNum + 1);
          const r = safe(() => window.VenusAIHub.sleepText({ range: days, recent: 0, study: true, notes: false }), null);
          if (r && r.text) summaryText = r.text; else summaryNote = 'VenusAIHub.sleepText không trả về nội dung.';
        }
      }
      return { range: { from: rg.from, to: rg.to }, sleep, sleep_debt_now: debt, wellness, summaryText, summaryNote };
    }
  });

  /* ═════════════════════════ TOOL 3: goals + deadlines ═════════════════════════ */
  register({
    name: 'get_goals_and_deadlines', level: LEVELS.L0_READ,
    description: 'Mục tiêu (goals) và deadline thủ công hiện có, kèm số ngày còn lại. Không lọc theo ngày; không trả nội dung ghi chú của deadline.',
    input: {},
    output: '{ today, counts, goals[], deadlines[] }',
    handler: async () => {
      const today = todayVN(), tNum = dayNum(today);
      const left = (d) => (typeof d === 'string' && ISO_DATE.test(d) ? dayNum(d) - tNum : null);
      const readLs = (k) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? null : v; } catch (e) { return null; } };

      // goals: the Tracker's live array first (same source as ai-hub.js), localStorage as fallback
      const gSrc = safe(() => goals, null);
      const goalList = Array.isArray(gSrc) ? gSrc : (Array.isArray(readLs('goals')) ? readLs('goals') : []);
      const SD = safe(() => skillsData, {}) || {};
      const gOut = goalList.filter((g) => g && typeof g === 'object').map((g) => {
        const target = +g.target || 0, prog = +g.currentProgress || 0, dl = left(g.deadline);
        const done = target > 0 && prog >= target;
        return {
          id: g.id != null ? String(g.id) : null, title: clip(g.title, 120), type: g.type || null,
          track: (SD[g.career] && SD[g.career].title) || g.career || null,
          target, progress: r2(prog), pct: target > 0 ? Math.round(prog / target * 100) : null,
          deadline: ISO_DATE.test(g.deadline || '') ? g.deadline : null, days_left: dl,
          status: done ? 'done' : (dl != null && dl < 0 ? 'overdue' : 'active')
        };
      });

      // deadlines (manual list). Done state lives in a separate key (dltDoneIds = array of ids).
      const dRaw = readLs('deadlines'), doneIdsRaw = readLs('dltDoneIds');
      const doneKnown = Array.isArray(doneIdsRaw), doneSet = new Set(doneKnown ? doneIdsRaw.map(String) : []);
      const dOut = (Array.isArray(dRaw) ? dRaw : []).filter((d) => d && typeof d === 'object').map((d) => {
        const dl = left(d.date), done = doneKnown ? doneSet.has(String(d.id)) : null;
        return {
          id: d.id != null ? String(d.id) : null, name: clip(d.name, 120), date: ISO_DATE.test(d.date || '') ? d.date : null, time: d.time || null,
          category: d.category || null, priority: d.priority || null, track: d.roadmapTrack || null,
          checklist_items: Array.isArray(d.checklist) ? d.checklist.length : 0, days_left: dl, done,
          status: done ? 'done' : (dl != null && dl < 0 ? 'overdue' : 'active')
        };
      });
      const cnt = (arr, f) => arr.filter(f).length;
      return {
        today,
        counts: {
          goals_total: gOut.length, goals_active: cnt(gOut, (x) => x.status === 'active'), goals_overdue: cnt(gOut, (x) => x.status === 'overdue'), goals_done: cnt(gOut, (x) => x.status === 'done'),
          deadlines_total: dOut.length, deadlines_active: cnt(dOut, (x) => x.status === 'active'), deadlines_overdue: cnt(dOut, (x) => x.status === 'overdue'),
          deadlines_due_7d: cnt(dOut, (x) => x.status === 'active' && x.days_left != null && x.days_left >= 0 && x.days_left <= 7),
          deadlines_done_state_known: doneKnown
        },
        goals: gOut, deadlines: dOut
      };
    }
  });

  /* ═════════════════════════ TOOL 4: vault search (noai-safe) ═════════════════════════ */
  const VAULT_DB = 'FinanceTrackerVaultDB';
  const tagNorm = (t) => String(t).replace(/^#+/, '').trim().toLowerCase();
  // Read-only lookup of notes by id straight from the Vault's IndexedDB. Never opens with a version number and aborts any
  // upgrade, so it cannot create or alter the database. Resolves a Map(id → {tags, deleted}) or rejects (caller fails closed).
  function readNoteFlags(ids) {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(VAULT_DB); } catch (e) { return reject(e); }
      req.onupgradeneeded = () => { try { req.transaction.abort(); } catch (e) { /* ignore */ } };   // DB did not exist: do not create it
      req.onerror = () => reject(req.error || new Error('open failed'));
      req.onblocked = () => reject(new Error('blocked'));
      req.onsuccess = () => {
        const db = req.result; db.onversionchange = () => { try { db.close(); } catch (e) { /* ignore */ } };
        const done = (fn, v) => { try { db.close(); } catch (e) { /* ignore */ } fn(v); };
        if (!db.objectStoreNames.contains('notes')) return done(reject, new Error('no notes store'));
        const out = new Map();
        try {
          const tx = db.transaction('notes', 'readonly'), st = tx.objectStore('notes');
          ids.forEach((id) => {
            const g = st.get(id);
            g.onsuccess = () => {
              const n = g.result; if (!n) return;
              let tags = n.tags;
              if (typeof tags === 'string') tags = tags.split(/[,\s]+/);          // defensive: the Vault itself only keeps arrays
              out.set(id, { tags: Array.isArray(tags) ? tags.map(tagNorm) : [], deleted: !!(+n.deletedAt) });
            };
          });
          tx.oncomplete = () => done(resolve, out);
          tx.onerror = () => done(reject, tx.error || new Error('read failed'));
          tx.onabort = () => done(reject, tx.error || new Error('aborted'));
        } catch (e) { done(reject, e); }
      };
    });
  }

  register({
    name: 'search_vault_notes', level: LEVELS.L0_READ,
    description: 'Tìm note trong Notes Vault (wrap NotesVault.searchNotesLite). Tuyệt đối không trả note có tag noai hay note đã xóa: tag được kiểm lại từ IndexedDB; không kiểm được thì không trả gì.',
    input: { query: { type: 'string', maxLen: 200 }, limit: { type: 'int', min: 1, max: 20, def: 8 } },
    output: '{ query, count, filtered_out, notes:[{id,title,type,snippet,score}] }',
    handler: async (inp) => {
      if (typeof window.__ensureNotesVault === 'function') {
        try { await window.__ensureNotesVault(); } catch (e) { throw toolErr('vault_unavailable', 'Không tải được Notes Vault (kiểm tra mạng rồi thử lại).'); }
      }
      const NV = window.NotesVault;
      if (!NV || typeof NV.searchNotesLite !== 'function') throw toolErr('vault_unavailable', 'Notes Vault chưa sẵn sàng (không có searchNotesLite).');
      // searchNotesLite returns only {id,title,type,snippet,score} — no tags — so over-fetch, then verify every hit.
      const hits = (await NV.searchNotesLite(inp.query, Math.min(60, inp.limit * 3 + 10))) || [];
      if (!hits.length) return { query: inp.query, count: 0, filtered_out: 0, notes: [] };
      let flags;
      try { flags = await readNoteFlags(hits.map((h) => h.id)); }
      catch (e) { throw toolErr('cannot_verify_tags', 'Không kiểm tra được tag noai nên không trả kết quả nào (an toàn trước).'); }
      const kept = [];
      for (const h of hits) {
        const f = flags.get(h.id);
        if (!f || f.deleted || f.tags.indexOf('noai') >= 0) continue;     // unknown note ⇒ drop (fail closed)
        kept.push({ id: h.id, title: clip(h.title, 140), type: h.type || null, snippet: clip(h.snippet, 240), score: h.score });
        if (kept.length >= inp.limit) break;
      }
      return { query: inp.query, count: kept.length, filtered_out: hits.length - kept.length, notes: kept };
    }
  });

  /* ═════════════════════════ TOOL 5: storage health ═════════════════════════ */
  register({
    name: 'get_storage_health', level: LEVELS.L0_READ,
    description: 'Dung lượng localStorage theo từng khóa (ước tính 2 byte/ký tự, so với ngưỡng 5 MiB mà app đang giả định) + quota thực của trình duyệt qua navigator.storage.estimate(). Không trả giá trị của khóa.',
    input: {},
    output: '{ localStorage:{total_bytes,pct_of_assumed_limit,level,top_keys[],duplicate_backup_bytes}, browser:{usage,quota,usage_details,persisted} }',
    handler: async () => {
      const ASSUMED = 5 * 1024 * 1024;
      const keys = [];
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); keys.push({ key: k, bytes: (k.length + (localStorage.getItem(k) || '').length) * 2 }); } }
      catch (e) { throw toolErr('storage_blocked', 'Không đọc được localStorage.'); }
      keys.sort((a, b) => b.bytes - a.bytes);
      const total = sum(keys.map((k) => k.bytes)), pct = total / ASSUMED * 100;
      const level = pct > 95 ? 'near-full' : pct > 90 ? 'critical' : pct > 80 ? 'warning' : pct > 70 ? 'normal' : 'healthy';
      const dup = sum(keys.filter((k) => k.key === 'autoBackup' || k.key === 'backupHistory').map((k) => k.bytes));
      const ls = {
        key_count: keys.length, total_bytes: total, total_mb: r2(total / 1048576), assumed_limit_bytes: ASSUMED, pct_of_assumed_limit: r1(pct), level,
        top_keys: keys.slice(0, 15).map((k) => ({ key: k.key, kb: r1(k.bytes / 1024) })),
        duplicate_backup_bytes: dup, duplicate_backup_pct_of_total: total ? r1(dup / total * 100) : 0,
        note: 'Ước tính của app (5 MiB, 2 byte/ký tự), không phải quota đo thực của localStorage.'
      };
      let browser = { supported: false };
      try {
        if (navigator.storage && navigator.storage.estimate) {
          const e = await navigator.storage.estimate();
          browser = { supported: true, usage_bytes: e.usage, quota_bytes: e.quota, pct_used: e.quota ? r2(e.usage / e.quota * 100) : null, usage_details: e.usageDetails || null, persisted: null };
        }
        if (navigator.storage && navigator.storage.persisted) { browser.supported = true; browser.persisted = await navigator.storage.persisted(); }
      } catch (e) { browser.error = 'estimate failed'; }
      return { localStorage: ls, browser };
    }
  });

  window.VenusTools = { version: 2, LEVELS, run, call: run, list, register, setAuditSink: (fn) => { auditSink = typeof fn === 'function' ? fn : null; } };
})();
