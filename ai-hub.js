/* Venus Hub — AI for Tracker data (ai-hub.js)
   Sits next to index.html. Gives the Sleep tracker and the Skills/study progress an "✨ AI" window.
   • It does NOT send raw history. It re-uses the app's own calculators (sleep debt, efficiency, regularity/SRI,
     social jetlag, SOL/WASO screening…) and sends a compact summary of numbers, so the free models' small memory is enough,
     the numbers match what you see on screen, and less personal data leaves your device.
   • The window itself (key, model, streaming, errors) is ai.js — loaded on demand, shared with Notes Vault.
   • Public API:  VenusAIHub.sleep()   VenusAIHub.skills()
                  VenusAIHub.sleepText(opts) / skillsText(opts)  → returns the exact text that would be sent
                  (sleepText also returns `data`: the same numbers as structured JSON, for charts/tables later)
                  VenusAIHub.sleepData(opts)                      → just that JSON
   • To add another topic later (goals, courses, books…): write a  xxxText(opts)  function and an  openXxx()  like the two below. */
(function () {
  'use strict';
  if (window.VenusAIHub) return;

  /* ───────── loading ai.js on demand ───────── */
  let aiLoading = null;
  function ensureAi() {
    if (window.VenusAI) return Promise.resolve(window.VenusAI);
    if (!aiLoading) aiLoading = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = './ai.js';
      s.onload = () => (window.VenusAI ? res(window.VenusAI) : rej(new Error('ai.js loaded but VenusAI is missing')));
      s.onerror = () => { aiLoading = null; rej(new Error('ai.js not found')); };
      document.head.appendChild(s);
    });
    return aiLoading;
  }
  function say(msg) {
    try { if (typeof showNotification === 'function') { showNotification(msg, 'error'); return; } } catch (e) { /* fall through */ }
    alert(msg);
  }

  /* ───────── small helpers ───────── */
  const pad = (n) => String(n).padStart(2, '0');
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const avg = (a) => (a.length ? sum(a) / a.length : null);
  const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
  const sd = (a) => { if (a.length < 2) return null; const m = avg(a); return Math.sqrt(avg(a.map((v) => (v - m) * (v - m)))); };
  const f1 = (v) => (v == null || !isFinite(v) ? '–' : (Math.round(v * 10) / 10).toFixed(1));
  const f0 = (v) => (v == null || !isFinite(v) ? '–' : String(Math.round(v)));
  const sgn = (v) => (Math.abs(v) < 0.05 ? '±0.0' : (v < 0 ? '−' : '+') + Math.abs(v).toFixed(1));
  const hm = (m) => { const x = ((Math.round(m) % 1440) + 1440) % 1440; return pad(Math.floor(x / 60)) + ':' + pad(x % 60); };
  const dm = (ds) => ds.slice(8, 10) + '/' + ds.slice(5, 7);
  const DOW = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  const dowOf = (ds) => new Date(ds + 'T00:00:00Z').getUTCDay();
  const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const safe = (fn, dflt) => { try { const v = fn(); return v === undefined ? dflt : v; } catch (e) { return dflt; } };
  const hasFn = (n) => typeof window[n] === 'function';
  function pearson(xs, ys) {
    const n = xs.length; if (n < 8) return null;
    const mx = avg(xs), my = avg(ys); let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  }
  const strength = (r) => { const a = Math.abs(r); return a < 0.2 ? 'rất yếu' : a < 0.4 ? 'yếu' : a < 0.6 ? 'vừa' : 'khá mạnh'; };
  // Clock times that wrap past midnight (23:30, 00:40) must not look 24h apart: try every cut point, keep the tightest.
  function clockStats(tsList) {
    if (tsList.length < 3) return null;
    const mins = tsList.map((t) => vnMinuteOfDay(t));
    let best = null;
    for (let p = 0; p < 1440; p += 60) {
      const sh = mins.map((m) => (m - p + 1440) % 1440), s = sd(sh);
      if (best === null || s < best.sd) best = { sd: s, p, sh };
    }
    return { sd: best.sd, med: median(best.sh) + best.p };
  }
  const clockTxt = (tsList) => {
    const c = clockStats(tsList);
    if (c) return hm(c.med) + ' (±' + f0(c.sd) + ' phút)';
    return tsList.length ? tsList.map((t) => hm(vnMinuteOfDay(t))).join(', ') + ' (quá ít để tính độ lệch)' : '–';
  };

  /* ═══════════════════════════ SLEEP ═══════════════════════════ */
  const TAG_LABEL = {
    screen: 'dùng màn hình trên giường', alcohol: 'rượu bia', stress: 'căng thẳng / suy nghĩ dồn dập', late_work: 'làm hoặc học muộn',
    room: 'phòng nóng, ồn hoặc sáng', reading: 'đọc sách', winddown: 'thói quen thư giãn trước ngủ', shower: 'tắm nước ấm',
    caffeineLate: 'caffeine sau giờ cutoff', lateMeal: 'ăn muộn (<3h trước ngủ)', exercise: 'tập thể dục trong ngày'
  };
  const LEGACY_TAGS = ['screen', 'alcohol'];                     // older sessions have these; newer habit chips set habitsV = 2
  const MANUAL_TAGS = ['screen', 'alcohol', 'stress', 'late_work', 'room', 'reading', 'winddown', 'shower'];
  const AUTO_TAGS = ['caffeineLate', 'lateMeal', 'exercise'];

  function sleepText(st) {
    st = st || {};
    const need = ['getSortedSleepSessions', 'buildSleepNightsByWakeDate', 'getSleepWakeDateVN', 'getSleepWakeDateLocal', 'getSleepGoal',
      'sleepDateToDayNum', 'sleepDayNumToDateStr', 'getVietnamDateStr', 'vnMinuteOfDay', 'computeSleepEfficiency'];
    const miss = need.filter((n) => !hasFn(n));
    if (miss.length) throw new Error('Không tìm thấy hàm của Sleep Tracker: ' + miss.join(', '));

    const range = st.range === 'all' ? Infinity : (+st.range || 30);
    const goal = getSleepGoal();
    const tol = safe(() => SLEEP_DEBT_CFG.tolerance, 0.25), okLimit = goal - tol;
    const todayStr = getVietnamDateStr(), todayNum = sleepDateToDayNum(todayStr);
    const all = getSortedSleepSessions().filter((s) => s && isNum(s.start) && isNum(s.duration) && s.duration > 0);
    if (!all.length) return { text: 'Chưa có dữ liệu giấc ngủ nào được ghi.', label: 'Chưa có dữ liệu', details: [], data: null };

    /* one record per night (wake-up date, Vietnam time) */
    const nightsAll = buildSleepNightsByWakeDate(all);
    if (hasFn('attachNapsToNights') && hasFn('getSleepNapsSafe')) { try { attachNapsToNights(nightsAll, getSleepNapsSafe()); } catch (e) { /* naps are optional */ } }
    const mainBy = new Map();
    all.forEach((s) => { const d = getSleepWakeDateVN(s), cur = mainBy.get(d); if (!cur || s.duration > cur.duration) mainBy.set(d, s); });
    const studyMap = st.study ? safe(() => getStudyHoursByLocalDate(), {}) : {};
    const firstStudyKey = Object.keys(studyMap).sort()[0] || null;
    const recs = nightsAll.map((n) => {
      const s = mainBy.get(n.date) || {};
      const tags = {};
      if (s.tags) Object.keys(s.tags).forEach((k) => { if (s.tags[k]) tags[k] = true; });
      const autoOk = !!(s.auto_tags && s.auto_tags.available);
      if (autoOk) AUTO_TAGS.forEach((k) => { if (s.auto_tags[k]) tags[k] = true; });
      const wakeLocal = safe(() => getSleepWakeDateLocal(s), null);
      return {
        date: n.date, dayNum: n.dayNum, hours: n.hours, startTs: n.startTs, endTs: n.endTs, sessions: n.sessions,
        sol: isNum(s.sol) ? s.sol : null, awake: isNum(s.awakenings_min) ? s.awakenings_min : null,
        se: safe(() => computeSleepEfficiency(s), null), quality: isNum(s.quality) && s.quality > 0 ? s.quality : null,
        tags, autoOk, habitsV2: s.habitsV === 2, hasTagObj: !!s.tags, notes: s.notes ? clip(s.notes, 140) : '',
        napMin: n.napMinutes || 0,
        studyNext: firstStudyKey && wakeLocal && wakeLocal >= firstStudyKey ? (studyMap[wakeLocal] || 0) : null
      };
    });

    const startNum = range === Infinity ? recs[0].dayNum : todayNum - range + 1;
    const winAll = recs.filter((r) => r.dayNum >= startNum && r.dayNum <= todayNum + 1);
    // A night longer than this is almost always a forgotten Stop button: keep it out of every average, but report it.
    const maxNight = safe(() => SLEEP_DEBT_CFG.longNightHours, 14);
    const win = winAll.filter((r) => r.hours >= 0.5 && r.hours <= maxNight);
    const dropped = winAll.filter((r) => r.hours > maxNight || r.hours < 0.5);
    const last = recs[recs.length - 1];
    const L = [], sect = [];
    const head = (name) => { L.push(''); L.push('## ' + name); sect.push(name); };
    // Structured twin of the text pack (same numbers, machine-readable) — lets a future chart/table renderer
    // draw from data instead of parsing prose. Filled below, returned as `data`.
    const weekly = []; let debtInfo = null, circadianInfo = null, screeningInfo = null;
    const spanDays = Math.max(1, todayNum - Math.max(startNum, recs[0].dayNum) + 1);

    L.push('DỮ LIỆU GIẤC NGỦ — gói tóm tắt do app tính sẵn (giờ Việt Nam)');
    L.push('Hôm nay: ' + todayStr + ' · cửa sổ phân tích: ' + (range === Infinity ? 'toàn bộ lịch sử' : range + ' ngày gần nhất') + ' · log gần nhất: ' + last.date + ' (' + Math.max(0, todayNum - last.dayNum) + ' ngày trước)');
    L.push('Quy ước: mỗi đêm gán theo NGÀY THỨC DẬY. "Giờ ngủ" = thời gian ngủ thật (đã trừ thời gian chờ vào giấc và số phút thức giữa đêm); nap không tính vào đêm. Giờ lên giường = lúc bấm bắt đầu ngủ.');
    L.push('Mục tiêu của mình: ' + goal + 'h/đêm (đêm dưới ' + f1(okLimit) + 'h tính là thiếu).');
    if (!win.length) {
      L.push(''); L.push(winAll.length ? 'Mọi đêm trong cửa sổ này đều dài bất thường (nghi quên bấm Stop). Đừng phân tích số giờ ngủ; hãy nhắc mình sửa dữ liệu.' : 'Không có đêm nào được log trong cửa sổ này. Đừng phân tích gì thêm — hãy nói rõ là thiếu dữ liệu.');
      return { text: L.join('\n'), label: winAll.length ? 'Chỉ có đêm nghi sai' : 'Không có đêm nào trong cửa sổ', details: [], data: null };
    }

    /* — overview — */
    head('Tổng quan cả giai đoạn');
    const hrs = win.map((r) => r.hours), sols = win.map((r) => r.sol).filter(isNum), awk = win.map((r) => r.awake).filter(isNum);
    const ses = win.map((r) => r.se).filter(isNum), qs = win.map((r) => r.quality).filter(isNum);
    const lo = win.reduce((a, r) => (!a || r.hours < a.hours ? r : a), null), hi = win.reduce((a, r) => (!a || r.hours > a.hours ? r : a), null);
    L.push('• Số đêm có log: ' + winAll.length + '/' + spanDays + ' ngày (' + Math.round(winAll.length / spanDays * 100) + '%) — các ngày không log bị bỏ qua, không phải ngày ngủ thiếu.' + (dropped.length ? ' Đã loại ' + dropped.length + ' đêm dài >' + maxNight + 'h (nghi quên bấm Stop) khỏi mọi thống kê dưới đây.' : ''));
    L.push('• Giờ ngủ thật: trung bình ' + f1(avg(hrs)) + 'h, trung vị ' + f1(median(hrs)) + 'h, độ lệch chuẩn ' + f1(sd(hrs)) + 'h; ngắn nhất ' + f1(lo.hours) + 'h (' + dm(lo.date) + '), dài nhất ' + f1(hi.hours) + 'h (' + dm(hi.date) + ').');
    const reach = win.filter((r) => r.hours >= okLimit).length;
    L.push('• Đạt mục tiêu: ' + reach + '/' + win.length + ' đêm (' + Math.round(reach / win.length * 100) + '%); dưới 6h: ' + hrs.filter((h) => h < 6).length + ' đêm; trên 9h: ' + hrs.filter((h) => h > 9).length + ' đêm.');
    if (sols.length) L.push('• Thời gian chờ vào giấc (SOL): trung bình ' + f0(avg(sols)) + ' phút, trung vị ' + f0(median(sols)) + '; ≥31 phút ở ' + sols.filter((v) => v >= 31).length + '/' + sols.length + ' đêm có ghi SOL.');
    if (awk.length) L.push('• Thức giữa đêm (WASO): trung bình ' + f0(avg(awk)) + ' phút, trung vị ' + f0(median(awk)) + '; ≥31 phút ở ' + awk.filter((v) => v >= 31).length + '/' + awk.length + ' đêm có ghi.');
    if (ses.length) L.push('• Hiệu quả giấc ngủ (SE): trung bình ' + f0(avg(ses)) + '%; dưới 85% ở ' + ses.filter((v) => v < 85).length + '/' + ses.length + ' đêm có SE (≥90 rất tốt, 85–90 tốt, 75–85 trung bình, <75 rời rạc).');
    if (qs.length) L.push('• Chất lượng tự chấm (1–5): trung bình ' + f1(avg(qs)) + ' (' + qs.length + ' đêm có chấm).');
    L.push('• Giờ lên giường (trung vị): ' + clockTxt(win.map((r) => r.startTs).filter(isNum)) + ' · Giờ dậy (trung vị): ' + clockTxt(win.map((r) => r.endTs).filter(isNum)));
    const l7 = win.slice(-7), cb = clockStats(l7.map((r) => r.startTs).filter(isNum)), cw = clockStats(l7.map((r) => r.endTs).filter(isNum));
    if (cb && cw) L.push('• Độ đều đặn (' + l7.length + ' đêm gần nhất): độ lệch chuẩn giờ lên giường ±' + f0(cb.sd) + ' phút, giờ dậy ±' + f0(cw.sd) + ' phút (chỉ số = ±' + f0(Math.max(cb.sd, cw.sd)) + ' phút; ≤30 tốt, 31–60 trung bình, >60 thiếu đều).');

    /* — weekday vs weekend — */
    const wk = win.filter((r) => { const d = dowOf(r.date); return d >= 1 && d <= 5; }), we = win.filter((r) => { const d = dowOf(r.date); return d === 0 || d === 6; });
    if (wk.length >= 3 && we.length >= 2) {
      head('Ngày thường và cuối tuần (theo ngày thức dậy)');
      const wkW = clockStats(wk.map((r) => r.endTs).filter(isNum)), weW = clockStats(we.map((r) => r.endTs).filter(isNum));
      L.push('• T2–T6: ' + wk.length + ' đêm, TB ' + f1(avg(wk.map((r) => r.hours))) + 'h, lên giường ' + clockTxt(wk.map((r) => r.startTs).filter(isNum)) + ', dậy ' + clockTxt(wk.map((r) => r.endTs).filter(isNum)));
      L.push('• T7–CN: ' + we.length + ' đêm, TB ' + f1(avg(we.map((r) => r.hours))) + 'h, lên giường ' + clockTxt(we.map((r) => r.startTs).filter(isNum)) + ', dậy ' + clockTxt(we.map((r) => r.endTs).filter(isNum)));
      if (wkW && weW) { let dlt = weW.med - wkW.med; if (dlt > 720) dlt -= 1440; if (dlt < -720) dlt += 1440; L.push('• Giờ dậy cuối tuần lệch so với ngày thường: ' + (dlt >= 0 ? '+' : '−') + Math.abs(Math.round(dlt)) + ' phút.'); }
    }

    /* — trend — */
    head('Xu hướng theo thời gian');
    const bucket = (rs) => ({ n: rs.length, h: avg(rs.map((r) => r.hours)), sol: avg(rs.map((r) => r.sol).filter(isNum)), se: avg(rs.map((r) => r.se).filter(isNum)), bed: clockTxt(rs.map((r) => r.startTs).filter(isNum)), wake: clockTxt(rs.map((r) => r.endTs).filter(isNum)) });
    const bLine = (label, b) => '• ' + label + ': ' + b.n + ' đêm · TB ' + f1(b.h) + 'h' + (b.sol != null ? ' · SOL ' + f0(b.sol) + 'p' : '') + (b.se != null ? ' · SE ' + f0(b.se) + '%' : '') + ' · lên giường ' + b.bed + ' · dậy ' + b.wake;
    const nWeeks = Math.min(8, Math.max(2, Math.ceil(spanDays / 7)));
    for (let w = nWeeks - 1; w >= 0; w--) {
      const rs = win.filter((r) => Math.floor((todayNum - r.dayNum) / 7) === w);
      if (rs.length) { const b = bucket(rs); weekly.push({ weekEnd: sleepDayNumToDateStr(todayNum - w * 7), nights: b.n, avgHours: b.h, avgSol: b.sol, avgSe: b.se, bed: b.bed, wake: b.wake }); }
      L.push(rs.length ? bLine('Tuần kết thúc ' + dm(sleepDayNumToDateStr(todayNum - w * 7)), bucket(rs)) : '• Tuần kết thúc ' + dm(sleepDayNumToDateStr(todayNum - w * 7)) + ': không có log');
    }
    if (spanDays > 45) {
      const months = new Map(); win.forEach((r) => { const k = r.date.slice(0, 7); if (!months.has(k)) months.set(k, []); months.get(k).push(r); });
      L.push('Theo tháng:');
      Array.from(months.keys()).sort().slice(-12).forEach((k) => L.push(bLine(k, bucket(months.get(k)))));
    }

    /* — sleep debt (same engine as the Sleep debt card) — */
    if (hasFn('computeSleepDebt')) {
      const d = safe(() => computeSleepDebt(), null);
      if (d && d.ok) debtInfo = { debtHours: d.debt, level: d.level && d.level.label, equivNights: d.equivNights, avgHours: d.avgHours, avgGap: d.avgGap, shortNights: d.shortNights, deltaVs7d: d.delta, trend: d.trend, missingDays: d.missing, napCreditMin: d.napCreditMin };
      if (d) {
        head('Nợ ngủ (sổ ' + safe(() => SLEEP_DEBT_CFG.windowNights, 14) + ' đêm gần nhất của app)');
        if (d.ok) {
          L.push('• Nợ hiện tại: ' + f1(d.debt) + 'h — mức ' + d.level.label + ' (≈ ' + f1(d.equivNights) + ' đêm đầy đủ). Trung bình ' + f1(d.avgHours) + 'h/đêm (' + sgn(d.avgGap) + 'h so với mục tiêu); đêm thiếu ' + d.shortNights + '/' + d.logged + '; chuỗi đêm thiếu liên tiếp hiện tại: ' + d.shortStreak + '.');
          if (d.delta !== null) L.push('• Thay đổi so với 7 đêm trước: ' + sgn(d.delta) + 'h (' + (d.trend === 'up' ? 'đang tăng' : d.trend === 'down' ? 'đang giảm' : 'gần như không đổi') + ').');
          if (d.missing > 0) L.push('• Có ' + d.missing + ' ngày chưa log trong sổ — nợ thật có thể khác.');
          if (d.napCount > 0) L.push('• Nap đã trả bớt ' + f0(d.napCreditMin) + ' phút nợ (' + d.napCount + ' nap).');
        } else L.push('• Chưa đủ dữ liệu để tính nợ (' + d.logged + ' đêm log trong sổ, cần ' + d.needed + ').');
      }
    }

    /* — 4-axis sleep science summary: circadian regularity (SRI, SJL, MSFsc, baseline) + evidence-based insomnia screening — */
    if (hasFn('computeSleepScienceSummary')) {
      const sjWin = range === Infinity ? Infinity : Math.max(28, range);
      const sci = safe(() => computeSleepScienceSummary({ windowDays: range, jetlagWindowDays: sjWin }), null);
      if (sci) {
        const c = sci.circadian || {}, cont = sci.continuity || {}, scr = sci.insomniaScreening || {};
        head('Nhịp sinh học & Độ đều đặn (cửa sổ ' + (range === Infinity ? 'toàn bộ' : range + ' ngày') + ' · Social Jetlag ' + (sjWin === Infinity ? 'toàn bộ' : sjWin + ' ngày') + ')');
        if (c.baseline && c.baseline.ok) {
          L.push('• Baseline cá nhân (trung vị ' + c.baseline.sampleSize + ' đêm): lên giường ' + c.baseline.bedtimeClock + ' · dậy ' + c.baseline.wakeClock + ' · thời lượng ' + f1(c.baseline.durationHours) + 'h.');
        }
        if (c.regularity) {
          L.push('• Độ lệch chuẩn lịch ngủ (cả cửa sổ ' + (range === Infinity ? 'toàn bộ' : range + ' ngày') + ', ' + c.regularity.nights + ' đêm): lên giường ±' + c.regularity.sdBedMin + ' phút · dậy ±' + c.regularity.sdWakeMin + ' phút (chỉ số = ±' + c.regularity.scoreMin + ' phút; ≤30 tốt, 31–60 trung bình, >60 thất thường; bên lệch hơn: ' + c.regularity.driver + ').');
        }
        if (c.sri && c.sri.ok) {
          L.push('• Sleep Regularity Index (SRI, thang −100..100): ' + f1(c.sri.sri) + '/100 (' + c.sri.level.label + '; ≥80 đều, 60–79 trung bình, <60 thất thường) — tính trên ' + c.sri.pairedDays + ' cặp ngày liền kề cùng có log (độ tin cậy tăng khi ≥7 cặp).');
        } else if (c.sri) {
          L.push('• Sleep Regularity Index (SRI): chưa đủ cặp ngày liền kề có log (pairedDays = ' + c.sri.pairedDays + ', cần ≥3 cặp).');
        }
        if (c.socialJetlag && c.socialJetlag.ok) {
          const sj = c.socialJetlag;
          L.push('• Social Jetlag (' + (sjWin === Infinity ? 'toàn bộ' : sjWin + ' ngày') + ', phân loại theo ngày thức dậy): lệch ' + f1(sj.jetlagHours) + 'h (' + sj.jetlagMin + ' phút, cuối tuần ' + (sj.weekendLater ? 'muộn hơn' : 'sớm hơn') + '; <1h ổn, 1–2h lệch rõ, ≥2h lệch mạnh). Điểm giữa giấc ngủ ngày thường (MSW) ' + sj.mswClock + ' vs cuối tuần (MSF) ' + sj.msfClock + '; chronotype hiệu chỉnh ngủ bù (MSFsc): ' + sj.msfscClock + '.');
        } else {
          L.push('• Social Jetlag: chưa đủ số đêm ngày thường/cuối tuần trong cửa sổ ' + (sjWin === Infinity ? 'toàn bộ' : sjWin + ' ngày') + ' (cần ≥4 đêm T2–T6 và ≥2 đêm T7–CN).');
        }
        if (c.daytimeMainSleepCount > 0) {
          L.push('• Giấc ngủ chính ban ngày (>3h, bắt đầu 06:00–18:00) trong cửa sổ: ' + c.daytimeMainSleepCount + ' lần.');
        }

        head('Sàng lọc dấu hiệu mất ngủ (dựa trên SOL / WASO / SE — không phải chẩn đoán)');
        L.push('• Trạng thái sàng lọc: ' + scr.status + ' (ngưỡng tham chiếu: SOL ≥31 phút và/hoặc WASO ≥31 phút ở ≥3 đêm/tuần, hoặc SE <85% kéo dài; cần ≥5 đêm có log để kết luận).');
        if (cont.sol && cont.sol.count) L.push('• Khó vào giấc (SOL ≥31p): ' + cont.sol.over30Count + '/' + cont.sol.count + ' đêm (' + cont.sol.over30Pct + '%) · trung vị ' + f0(cont.sol.median) + ' phút.');
        if (cont.waso && cont.waso.count) L.push('• Khó duy trì giấc (WASO ≥31p): ' + cont.waso.over30Count + '/' + cont.waso.count + ' đêm (' + cont.waso.over30Pct + '%) · trung vị ' + f0(cont.waso.median) + ' phút.');
        if (cont.se && cont.se.count) L.push('• Hiệu quả giấc ngủ thấp (SE <85%): ' + cont.se.under85Count + '/' + cont.se.count + ' đêm (' + cont.se.under85Pct + '%) · SE <75%: ' + cont.se.under75Count + ' đêm.');
        if (cont.nonRestorative && cont.nonRestorative.ratedAdequateCount) L.push('• Ngủ đủ ≥7h nhưng chất lượng thấp (≤2/5): ' + cont.nonRestorative.count + '/' + cont.nonRestorative.ratedAdequateCount + ' đêm.');
        if (scr.flags) {
          L.push('• Phân tách 3 nhóm vấn đề độc lập: dấu hiệu mất ngủ (SOL/WASO/SE) = ' + (scr.flags.insomniaSignals ? 'CÓ' : 'không') + ' · lệch/thất thường nhịp sinh học = ' + (scr.flags.circadianIrregularity ? 'CÓ' : 'không') + ' · thiếu ngủ/nợ ngủ = ' + (scr.flags.sleepDebtBurden ? 'CÓ' : 'không') + ' → Tóm tắt: ' + scr.summaryLabel + '.');
        }

        circadianInfo = {
          baseline: (c.baseline && c.baseline.ok) ? { sampleSize: c.baseline.sampleSize, bedtimeClock: c.baseline.bedtimeClock, wakeClock: c.baseline.wakeClock, durationHours: c.baseline.durationHours } : null,
          regularity: c.regularity || null,
          sri: c.sri ? { ok: c.sri.ok, sri: c.sri.sri, matchRate: c.sri.matchRate, pairedDays: c.sri.pairedDays, loggedDays: c.sri.loggedDays, windowDays: c.sri.windowDays === Infinity ? 'all' : c.sri.windowDays, level: c.sri.level && c.sri.level.label } : null,
          socialJetlag: (c.socialJetlag && c.socialJetlag.ok) ? {
            windowDays: sjWin === Infinity ? 'all' : sjWin, weekdayNights: c.socialJetlag.weekdayNights, weekendNights: c.socialJetlag.weekendNights,
            jetlagHours: Math.round(c.socialJetlag.jetlagHours * 100) / 100, jetlagMin: c.socialJetlag.jetlagMin, diffMin: c.socialJetlag.diffMin,
            mswClock: c.socialJetlag.mswClock, msfClock: c.socialJetlag.msfClock, msfscClock: c.socialJetlag.msfscClock
          } : null,
          daytimeMainSleepCount: c.daytimeMainSleepCount || 0
        };
        screeningInfo = {
          status: scr.status || 'insufficient_data',
          windowDays: range === Infinity ? 'all' : range,
          sol: cont.sol || null,
          waso: cont.waso || null,
          se: cont.se || null,
          nonRestorative: cont.nonRestorative || null,
          signals: scr.signals || null,
          flags: scr.flags || null,
          summaryLabel: scr.summaryLabel || null
        };
      }
    }

    /* — habit / tag effects — */
    head('Thói quen và thẻ: đêm có thẻ so với đêm không có');
    L.push('(chỉ so khi mỗi nhóm có ≥3 đêm; đây là tương quan trong dữ liệu của mình, chưa chứng minh nhân quả)');
    let anyTag = false;
    const cmp = (label, a, b) => {
      const m = (rs, k) => { const v = rs.map((r) => r[k]).filter(isNum); return v.length >= 2 ? avg(v) : null; };
      const parts = [], pair = (name, k, fmt, unit) => { const x = m(a, k), y = m(b, k); if (x != null && y != null) parts.push(name + ' ' + fmt(x) + ' so với ' + fmt(y) + unit); };
      const ha = avg(a.map((r) => r.hours)), hb = avg(b.map((r) => r.hours));
      parts.push('giờ ngủ ' + f1(ha) + ' so với ' + f1(hb) + 'h (' + sgn(ha - hb) + ')');
      pair('SOL', 'sol', f0, ' phút'); pair('SE', 'se', f0, '%'); pair('chất lượng', 'quality', f1, '');
      L.push('• ' + label + ': ' + a.length + ' đêm có / ' + b.length + ' đêm không — ' + parts.join(' · '));
    };
    MANUAL_TAGS.concat(AUTO_TAGS).forEach((k) => {
      const isAuto = AUTO_TAGS.indexOf(k) >= 0;
      const pop = win.filter((r) => (isAuto ? r.autoOk : (LEGACY_TAGS.indexOf(k) >= 0 ? (r.habitsV2 || r.hasTagObj) : r.habitsV2)));
      const a = pop.filter((r) => r.tags[k]), b = pop.filter((r) => !r.tags[k]);
      if (!a.length) return;
      anyTag = true;
      if (a.length >= 3 && b.length >= 3) cmp(TAG_LABEL[k], a, b);
      else L.push('• ' + TAG_LABEL[k] + ': ' + a.length + ' đêm có / ' + b.length + ' đêm không — chưa đủ để so sánh.');
    });
    if (!anyTag) L.push('• Chưa có đêm nào gắn thẻ thói quen trong cửa sổ này.');

    /* — sleep vs study the next day — */
    if (st.study) {
      const ws = win.filter((r) => r.studyNext != null);
      head('Giấc ngủ và giờ học trong ngày thức dậy');
      if (ws.length < 6) L.push('• Chưa đủ ngày có dữ liệu học để so (' + ws.length + ' ngày).');
      else {
        const sh = ws.filter((r) => r.hours < okLimit), en = ws.filter((r) => r.hours >= okLimit);
        L.push('• Sau đêm thiếu (<' + f1(okLimit) + 'h): học TB ' + (sh.length ? f1(avg(sh.map((r) => r.studyNext))) + 'h (' + sh.length + ' ngày)' : 'chưa có ngày nào') + ' · sau đêm đủ: ' + (en.length ? f1(avg(en.map((r) => r.studyNext))) + 'h (' + en.length + ' ngày)' : 'chưa có ngày nào') + '.');
        const r = pearson(ws.map((x) => x.hours), ws.map((x) => x.studyNext));
        if (r != null) L.push('• Tương quan giờ ngủ → giờ học cùng ngày: r = ' + r.toFixed(2) + ' (n=' + ws.length + ', ' + strength(r) + '). Ngày không ghi giờ học được tính là 0h.');
        L.push('• Tổng giờ học trong các ngày đó: ' + f1(sum(ws.map((x) => x.studyNext))) + 'h.');
      }
    }

    /* — naps — */
    const naps = safe(() => getSleepNapsSafe(), []).filter((n) => n && isNum(n.start) && hasFn('vnDateStrFromTs') && sleepDateToDayNum(vnDateStrFromTs(n.start)) >= startNum);
    if (naps.length) {
      head('Nap (ngủ ngắn)');
      const mins = naps.map((n) => (isNum(n.durationMin) ? n.durationMin : isNum(n.end) ? (n.end - n.start) / 60000 : null)).filter(isNum);
      L.push('• ' + naps.length + ' nap, TB ' + f0(avg(mins)) + ' phút (tổng ' + f0(sum(mins)) + ' phút); giờ bắt đầu thường gặp: ' + clockTxt(naps.map((n) => n.start)) + '.');
    }

    /* — nights worth looking at — */
    const tagTxt = (r) => Object.keys(r.tags).filter((k) => TAG_LABEL[k]).map((k) => TAG_LABEL[k]).join(', ');
    const nightLine = (r) => {
      const p = [dm(r.date) + ' (' + DOW[dowOf(r.date)] + ') ' + (isNum(r.startTs) ? hm(vnMinuteOfDay(r.startTs)) : '?') + '→' + (isNum(r.endTs) ? hm(vnMinuteOfDay(r.endTs)) : '?') + ' · ' + f1(r.hours) + 'h'];
      if (r.sol != null) p.push('SOL ' + f0(r.sol) + 'p'); if (r.awake != null && r.awake > 0) p.push('thức ' + f0(r.awake) + 'p'); if (r.se != null) p.push('SE ' + f0(r.se) + '%');
      if (r.quality != null) p.push('chất lượng ' + r.quality + '/5'); if (r.napMin > 0) p.push('nap ' + f0(r.napMin) + 'p');
      if (r.studyNext != null && st.study) p.push('học hôm đó ' + f1(r.studyNext) + 'h');
      const t = tagTxt(r); if (t) p.push('thẻ: ' + t);
      let line = '• ' + p.join(' · ');
      if (st.notes && r.notes) line += ' — ghi chú: “' + r.notes + '”';
      return line;
    };
    const byHours = win.slice().sort((a, b) => a.hours - b.hours);
    head('5 đêm ngắn nhất và 3 đêm dài nhất');
    byHours.slice(0, 5).forEach((r) => L.push(nightLine(r)));
    L.push('— dài nhất —');
    byHours.slice(-3).reverse().forEach((r) => L.push(nightLine(r)));
    const nRecent = +st.recent || 0;
    if (nRecent > 0) {
      head(nRecent + ' đêm gần nhất (cũ → mới)');
      win.slice(-nRecent).forEach((r) => L.push(nightLine(r)));
    }

    /* — free-text notes: a dedicated section, so a note is not lost just because its night is not in the lists above — */
    if (st.notes) {
      const withNote = win.filter((r) => r.notes);
      head('Ghi chú tự viết');
      if (!withNote.length) L.push('• Không có đêm nào trong cửa sổ này có ghi chú.');
      else {
        L.push('• ' + withNote.length + '/' + win.length + ' đêm có ghi chú' + (withNote.length > 15 ? ' (hiện 15 đêm gần nhất)' : '') + '. Đây là lời mình tự viết, không phải số đo; dùng để giải thích bối cảnh, đừng coi là sự thật đã kiểm chứng.');
        withNote.slice(-15).forEach((r) => L.push('  - ' + dm(r.date) + ' (' + DOW[dowOf(r.date)] + ', ' + f1(r.hours) + 'h): “' + r.notes + '”'));
      }
    }

    /* — data quality — */
    head('Chất lượng dữ liệu');
    const odd = winAll.filter((r) => r.hours < 3 || r.hours > maxNight);
    L.push('• Đêm bất thường (<3h hoặc >' + maxNight + 'h; dài thường là quên bấm Stop): ' + (odd.length ? odd.map((r) => dm(r.date) + ' ' + f1(r.hours) + 'h' + (r.hours > maxNight ? ' [đã loại khỏi thống kê]' : '')).join('; ') : 'không có') + '.');
    if (dropped.length) L.push('• Lưu ý: các đêm >' + maxNight + 'h đã được loại đồng bộ khỏi cả thống kê tổng quan, nợ ngủ, baseline và SRI.');
    L.push('• Số đêm có ghi SOL: ' + sols.length + '/' + win.length + '; có chấm chất lượng: ' + qs.length + '/' + win.length + '; có gắn thẻ thói quen: ' + win.filter((r) => Object.keys(r.tags).length).length + '/' + win.length + '.');

    const night = (r) => ({
      date: r.date, dow: DOW[dowOf(r.date)],
      bed: isNum(r.startTs) ? hm(vnMinuteOfDay(r.startTs)) : null, wake: isNum(r.endTs) ? hm(vnMinuteOfDay(r.endTs)) : null,
      hours: isNum(r.hours) ? Math.round(r.hours * 100) / 100 : null, solMin: r.sol, awakeMin: r.awake, sePct: isNum(r.se) ? Math.round(r.se * 10) / 10 : null,
      quality: r.quality, napMin: r.napMin || 0, studyHours: r.studyNext, tags: Object.keys(r.tags).filter((k) => TAG_LABEL[k]).map((k) => TAG_LABEL[k]),
      note: st.notes && r.notes ? r.notes : null
    });
    const data = {
      schema: 'venus.sleep.v2', generated: todayStr, tz: 'Asia/Ho_Chi_Minh',
      window: { days: range === Infinity ? 'all' : range, nights: win.length, excluded: dropped.map((r) => r.date) },
      goalHours: goal, okLimitHours: okLimit,
      summary: {
        avgHours: avg(hrs), medianHours: median(hrs), sdHours: sd(hrs), goalReached: reach, shortest: { date: lo.date, hours: lo.hours }, longest: { date: hi.date, hours: hi.hours },
        avgSolMin: avg(sols), avgAwakeMin: avg(awk), avgSePct: avg(ses), avgQuality: avg(qs),
        bedMedian: clockTxt(win.map((r) => r.startTs).filter(isNum)), wakeMedian: clockTxt(win.map((r) => r.endTs).filter(isNum))
      },
      debt: debtInfo, circadian: circadianInfo, insomniaScreening: screeningInfo, weekly,
      nights: win.slice(-365).map(night)
    };

    return { text: L.join('\n'), label: win.length + ' đêm · ' + (range === Infinity ? 'toàn bộ' : range + ' ngày'), details: sect, data };
  }

  /* ═══════════════════════════ SKILLS / STUDY ═══════════════════════════ */
  function skillsText(st) {
    st = st || {};
    const SD = safe(() => skillsData, null);
    if (!SD) throw new Error('Không tìm thấy skillsData của Tracker.');
    if (!hasFn('toLocalDateStr')) throw new Error('Không tìm thấy hàm toLocalDateStr của Tracker.');
    const SH = safe(() => studyHours, {}) || {};
    const BD = safe(() => dailyStudyBreakdown, {}) || {};
    const GOALS = safe(() => goals, []) || [];
    const GAM = safe(() => gamification, null);
    const cur = safe(() => currentCareer, null);
    const days = +st.days || 30;
    const studyMap = hasFn('getStudyHoursByLocalDate') ? safe(() => getStudyHoursByLocalDate(), {}) : {};
    const dkey = (back) => { const d = new Date(); d.setDate(d.getDate() - back); return toLocalDateStr(d); };
    const dayNumOf = (k) => Math.round(Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)) / 86400000);
    const todayKey = dkey(0), todayNum = dayNumOf(todayKey);
    const dayHrs = (back) => studyMap[dkey(back)] || 0;
    const L = [], sect = [];
    const head = (name) => { L.push(''); L.push('## ' + name); sect.push(name); };

    L.push('DỮ LIỆU HỌC KỸ NĂNG — gói tóm tắt do app tính sẵn');
    L.push('Hôm nay: ' + todayKey + '. "Giờ" là giờ học mình tự ghi trong Tracker. Mục tiêu giờ của mỗi skill (targetHours) và mức quan trọng ★1–5 do mình đặt khi lập lộ trình.');

    /* — overall pace — */
    head('Nhịp học tổng thể');
    const wkTotals = []; for (let w = 0; w < 8; w++) { let t = 0; for (let i = w * 7; i < w * 7 + 7; i++) t += dayHrs(i); wkTotals.push(t); }
    const allHours = sum(Object.keys(SH).map((c) => sum(Object.values(SH[c] || {}).filter(isNum))));
    const active30 = Array.from({ length: 30 }, (_, i) => dayHrs(i)).filter((h) => h > 0.05);
    let sinceLast = null; for (let i = 0; i < 400; i++) { if (dayHrs(i) > 0.05) { sinceLast = i; break; } }
    L.push('• Tổng giờ học tích lũy (mọi track): ' + f1(allHours) + 'h.');
    L.push('• 8 tuần gần nhất (mới → cũ, giờ/tuần): ' + wkTotals.map(f1).join(' · '));
    L.push('• 28 ngày gần nhất: ' + f1(sum(wkTotals.slice(0, 4))) + 'h (' + f1(sum(wkTotals.slice(0, 4)) / 4) + 'h/tuần) so với 28 ngày trước đó ' + f1(sum(wkTotals.slice(4, 8))) + 'h.');
    L.push('• Số ngày có học trong 30 ngày qua: ' + active30.length + '/30' + (active30.length ? ' (TB ' + f1(avg(active30)) + 'h mỗi ngày có học)' : '') + '; ' + (sinceLast === null ? 'chưa thấy ngày học nào gần đây' : sinceLast === 0 ? 'hôm nay đã có học' : 'lần học gần nhất cách đây ' + sinceLast + ' ngày') + '.');
    if (GAM) L.push('• Chuỗi ngày học hiện tại: ' + (GAM.streak || 0) + ' (kỷ lục ' + (GAM.longestStreak || 0) + ') · cấp ' + (GAM.level || 1) + '.');

    /* — per-skill dated history only exists since the breakdown feature was added — */
    const bdDates = Object.keys(BD).sort();
    const covStart = bdDates[0] || null, covDays = covStart ? Math.min(28, todayNum - dayNumOf(covStart) + 1) : 0;
    const lastOf = {};                                                  // 'career|skill' → latest date with hours
    bdDates.forEach((d) => Object.keys(BD[d] || {}).forEach((k) => { if ((BD[d][k] || 0) > 0 && (!lastOf[k] || d > lastOf[k])) lastOf[k] = d; }));
    const inLast = (d, n) => todayNum - dayNumOf(d) < n && todayNum - dayNumOf(d) >= 0;
    const careerPace = (c) => { if (covDays < 7) return null; let t = 0; bdDates.forEach((d) => { if (inLast(d, 28)) Object.keys(BD[d] || {}).forEach((k) => { if (k.indexOf(c + '|') === 0) t += BD[d][k] || 0; }); }); return t / (covDays / 7); };
    L.push('• ' + (covStart ? 'Giờ theo từng skill theo từng ngày chỉ có từ ' + covStart + ' trở đi (trước đó chỉ có tổng cộng dồn), nên "lần học cuối" và tốc độ từng track chỉ đáng tin từ mốc đó.' : 'Chưa có dữ liệu giờ-theo-ngày-theo-skill, nên không biết skill nào học lần cuối khi nào.'));

    /* — which tracks — */
    const keys = Object.keys(SD).filter((c) => SD[c] && SD[c].categories);
    const scope = st.scope === 'current' && cur && SD[cur] ? [cur] : keys;
    const flat = (c) => { const out = []; Object.keys(SD[c].categories).forEach((cat) => (SD[c].categories[cat].skills || []).forEach((s) => out.push({ cat, s }))); return out; };
    const importanceHours = {}; let impTotal = 0;
    const notStarted = [], blocks = [];
    // many active tracks → fewer lines each, so the whole pack still fits the character limit
    const activeN = scope.filter((c) => sum(Object.values(SH[c] || {}).filter(isNum)) > 0).length;
    const topN = activeN > 8 ? 4 : activeN > 5 ? 6 : activeN > 3 ? 8 : 10, gapN = activeN > 8 ? 3 : 6;

    scope.forEach((c) => {
      const hoursObj = SH[c] || {}, list = flat(c);
      const total = sum(Object.values(hoursObj).filter(isNum));
      if (total <= 0) { notStarted.push(SD[c].title || c); return; }
      const tgtTotal = sum(list.map((x) => x.s.targetHours || 0));
      const doneCapped = sum(list.map((x) => Math.min(hoursObj[x.s.name] || 0, x.s.targetHours || Infinity)));
      const started = list.filter((x) => (hoursObj[x.s.name] || 0) > 0), complete = list.filter((x) => x.s.targetHours && (hoursObj[x.s.name] || 0) >= x.s.targetHours);
      const B = ['▸ ' + (SD[c].title || c) + ' — ' + f1(total) + 'h đã học · ' + (tgtTotal ? Math.round(doneCapped / tgtTotal * 100) + '% tổng mục tiêu (' + f0(doneCapped) + '/' + f0(tgtTotal) + 'h, đã giới hạn từng skill ở mục tiêu của nó)' : 'chưa đặt mục tiêu giờ') + ' · bắt đầu ' + started.length + '/' + list.length + ' skill · đủ mục tiêu giờ: ' + complete.length];
      const pace = careerPace(c);
      if (pace != null) {
        const remain = Math.max(0, tgtTotal - doneCapped);
        const wks = pace > 0.2 ? remain / pace : null;
        B.push('   Tốc độ 28 ngày gần nhất: ' + f1(pace) + 'h/tuần' + (wks != null && remain > 0 ? ' → còn ' + f0(remain) + 'h mục tiêu, tức ' + (wks > 104 ? '~' + f1(wks / 52) + ' năm' : '~' + f0(wks) + ' tuần') + ' nếu giữ nguyên nhịp (ước tính thô; mục tiêu cả track là dài hạn)' : pace <= 0.2 ? ' (gần như dừng)' : ''));
      }
      const rows = started.slice().sort((a, b) => (hoursObj[b.s.name] || 0) - (hoursObj[a.s.name] || 0));
      B.push('   Đang học (nhiều giờ nhất' + (rows.length > topN ? ', top ' + topN + '/' + rows.length : '') + '):');
      rows.slice(0, topN).forEach((x) => {
        const h = hoursObj[x.s.name] || 0, t = x.s.targetHours, ld = lastOf[c + '|' + x.s.name];
        B.push('     - ' + clip(x.s.name, 60) + ' — ' + f1(h) + (t ? '/' + t + 'h (' + Math.round(h / t * 100) + '%)' : 'h') + ' · ★' + (x.s.importance || '?') + (ld ? ' · học lần cuối ' + dm(ld) : ''));
      });
      const stale = started.filter((x) => { const ld = lastOf[c + '|' + x.s.name]; return ld && todayNum - dayNumOf(ld) > 14 && !(x.s.targetHours && (hoursObj[x.s.name] || 0) >= x.s.targetHours); });
      if (stale.length) B.push('   Đã bắt đầu nhưng >14 ngày chưa đụng tới: ' + stale.slice(0, 6).map((x) => clip(x.s.name, 44) + ' (' + f1(hoursObj[x.s.name]) + 'h, ' + (todayNum - dayNumOf(lastOf[c + '|' + x.s.name])) + ' ngày)').join('; ') + (stale.length > 6 ? '; …' : ''));
      if (st.gaps) {
        const gaps = list.filter((x) => (x.s.importance || 0) >= 4 && !(hoursObj[x.s.name] > 0)).sort((a, b) => (b.s.importance || 0) - (a.s.importance || 0) || (b.s.targetHours || 0) - (a.s.targetHours || 0));
        if (gaps.length) B.push('   Quan trọng (★4–5) nhưng chưa học giờ nào (' + gaps.length + '): ' + gaps.slice(0, gapN).map((x) => clip(x.s.name, 44) + ' ★' + x.s.importance + (x.s.targetHours ? ' ' + x.s.targetHours + 'h' : '')).join('; ') + (gaps.length > gapN ? '; …' : ''));
      }
      const known = new Set(list.map((x) => x.s.name)), stray = Object.keys(hoursObj).filter((n) => !known.has(n) && hoursObj[n] > 0);
      if (stray.length) B.push('   Giờ ghi cho ' + stray.length + ' mục không còn trong danh sách skill (tên đã đổi hoặc mục tự thêm): ' + f1(sum(stray.map((n) => hoursObj[n]))) + 'h.');
      list.forEach((x) => { const h = hoursObj[x.s.name] || 0; if (h > 0) { const k = x.s.importance || 0; importanceHours[k] = (importanceHours[k] || 0) + h; impTotal += h; } });
      blocks.push({ c, total, B });
    });
    /* — effort alignment — */
    if (impTotal > 0) {
      head('Giờ học có dồn vào thứ quan trọng không');
      const ks = Object.keys(importanceHours).map(Number).sort((a, b) => b - a);
      L.push('• Phân bố giờ theo mức quan trọng (các skill đã có giờ): ' + ks.map((k) => (k ? '★' + k : 'chưa gán') + ' ' + f0(importanceHours[k]) + 'h (' + Math.round(importanceHours[k] / impTotal * 100) + '%)').join(' · '));
      const hiShare = sum(ks.filter((k) => k >= 4).map((k) => importanceHours[k])) / impTotal;
      L.push('• ' + Math.round(hiShare * 100) + '% giờ học nằm ở skill ★4–5.');
    }

    /* — recent activity by skill — */
    const recent = {};
    bdDates.forEach((d) => { if (inLast(d, days)) Object.keys(BD[d] || {}).forEach((k) => { const o = recent[k] || (recent[k] = { h: 0, days: new Set() }); o.h += BD[d][k] || 0; o.days.add(d); }); });
    const rk = Object.keys(recent).filter((k) => (scope.length === keys.length) || scope.indexOf(k.split('|')[0]) >= 0).sort((a, b) => recent[b].h - recent[a].h);
    head(days + ' ngày gần nhất: học những gì');
    if (!rk.length) L.push('• Không có giờ-theo-skill nào trong ' + days + ' ngày qua' + (covStart ? ' (dữ liệu theo ngày bắt đầu từ ' + covStart + ')' : '') + '.');
    else {
      const byCareer = {}; rk.forEach((k) => { const c = k.split('|')[0]; byCareer[c] = (byCareer[c] || 0) + recent[k].h; });
      L.push('• Giờ theo track: ' + Object.keys(byCareer).sort((a, b) => byCareer[b] - byCareer[a]).map((c) => ((SD[c] && SD[c].title) || c) + ' ' + f1(byCareer[c]) + 'h').join(' · ') + ' → ' + Object.keys(byCareer).length + ' track được đụng tới.');
      rk.slice(0, 12).forEach((k) => { const c = k.split('|')[0], n = k.slice(c.length + 1); L.push('  - ' + clip(n, 56) + ' [' + ((SD[c] && SD[c].title) || c) + '] — ' + f1(recent[k].h) + 'h trong ' + recent[k].days.size + ' ngày'); });
      if (rk.length > 12) L.push('  … và ' + (rk.length - 12) + ' skill khác (' + f1(sum(rk.slice(12).map((k) => recent[k].h))) + 'h).');
    }

    /* — goals — */
    if (st.goals && GOALS.length) {
      head('Mục tiêu (Goals)');
      const act = GOALS.filter((g) => !(g.target > 0 && (g.currentProgress || 0) >= g.target));
      const doneN = GOALS.length - act.length;
      act.slice(0, 12).forEach((g) => {
        const p = g.target > 0 ? Math.round((g.currentProgress || 0) / g.target * 100) : 0;
        const left = g.deadline && /^\d{4}-\d{2}-\d{2}$/.test(g.deadline) ? dayNumOf(g.deadline) - todayNum : null;
        let extra = left == null ? '' : left < 0 ? ' · QUÁ HẠN ' + (-left) + ' ngày' : ' · hạn ' + dm(g.deadline) + ' (còn ' + left + ' ngày)';
        if (left != null && left > 0 && g.type === 'study_hours' && g.target > 0) extra += ' → cần ~' + f1(Math.max(0, g.target - (g.currentProgress || 0)) / (left / 7)) + 'h/tuần';
        L.push('• ' + clip(g.title, 70) + ' [' + ((SD[g.career] && SD[g.career].title) || g.career || '?') + '] — ' + f1(g.currentProgress || 0) + '/' + g.target + ' (' + p + '%)' + extra);
      });
      if (act.length > 12) L.push('… và ' + (act.length - 12) + ' mục tiêu đang chạy khác.');
      if (!act.length) L.push('• Không có mục tiêu nào đang chạy.');
      L.push('• Đã hoàn thành: ' + doneN + '.');
    }

    head('Tiến độ từng track (nhiều giờ nhất trước)');
    blocks.sort((a, b) => b.total - a.total).forEach((b) => b.B.forEach((l) => L.push(l)));
    if (!blocks.length) L.push('• Chưa có giờ học nào được ghi trong phạm vi này.');
    if (notStarted.length) L.push('Track chưa có giờ nào: ' + notStarted.join(', ') + '.');
    const other = Object.keys(SH).filter((c) => !SD[c] && SH[c] && sum(Object.values(SH[c]).filter(isNum)) > 0);
    if (st.scope !== 'current') other.forEach((c) => {
      const o = SH[c], names = Object.keys(o).filter((n) => o[n] > 0).sort((a, b) => o[b] - o[a]);
      L.push('▸ Track "' + c + '" (không có danh sách skill/mục tiêu trong skillsData): ' + f1(sum(Object.values(o))) + 'h; nhiều nhất: ' + names.slice(0, 5).map((n) => clip(n, 40) + ' ' + f1(o[n]) + 'h').join('; '));
    });


    return { text: L.join('\n'), label: (blocks.length) + ' track có giờ · ' + f0(allHours) + 'h tổng', details: sect };
  }

  /* ═══════════════════════════ the two windows ═══════════════════════════ */
  const SLEEP_SYSTEM = 'Bạn đang đọc dữ liệu giấc ngủ cá nhân của người dùng (đã được app tính sẵn theo 4 trục khoa học) trong <context>. Quy tắc: (1) chỉ dựa vào số liệu trong đó và trích số cụ thể khi nhận xét; (2) phân biệt rạch ròi 3 nhóm vấn đề khác nhau: dấu hiệu mất ngủ thật (dựa trên SOL ≥31p, WASO ≥31p, SE <85% dù đủ cơ hội ngủ), lệch/thất thường nhịp sinh học (SRI, SD giờ ngủ/dậy, Social Jetlag), và thiếu ngủ/nợ ngủ — không gán nhãn mất ngủ nếu SOL/WASO bình thường; (3) phân biệt tương quan với nhân quả, nói rõ độ tin cậy khi mẫu nhỏ (ít đêm, nhóm <5 đêm, hoặc SRI có ít cặp ngày liền kề pairedDays <7); (4) không chẩn đoán y khoa — nếu số liệu gợi ý vấn đề kéo dài nghiêm trọng thì khuyên gặp bác sĩ hoặc chuyên gia giấc ngủ; (5) khi đề xuất thay đổi, chỉ chọn tối đa 3 thay đổi cụ thể kèm cách tự kiểm tra trong chính app; (6) nếu thiếu dữ liệu để kết luận thì nói rõ cần log thêm gì. Mặc định trả lời gọn (khoảng 300–400 từ) với tiêu đề ngắn, trừ khi được yêu cầu chi tiết.';
  const SLEEP_PRESETS = [
    { label: 'Bức tranh tổng thể', prompt: 'Tóm tắt tình trạng giấc ngủ của mình: (1) 3 phát hiện quan trọng nhất kèm số liệu cụ thể; (2) điều đang ổn; (3) điều đáng lo nhất, và mức chắc chắn của nhận định này dựa trên bao nhiêu đêm dữ liệu.' },
    { label: 'Vì sao ngủ thiếu?', prompt: 'Tìm nguyên nhân khiến mình ngủ thiếu hoặc ngủ kém: so sánh các thói quen (thẻ), ngày thường với cuối tuần, giờ lên giường với giờ dậy. Chỉ nêu điều có số liệu hỗ trợ, nói rõ chỗ nào mẫu quá nhỏ. Xếp hạng tối đa 3 nguyên nhân theo mức ảnh hưởng và nói mình tự kiểm chứng từng cái bằng cách nào.' },
    { label: 'Ngủ ↔ học', prompt: 'Giấc ngủ có đang ảnh hưởng tới số giờ mình học trong ngày thức dậy không? Dùng các số so sánh sau đêm thiếu với sau đêm đủ và hệ số tương quan, nói rõ độ tin cậy và các yếu tố có thể gây nhiễu (vd ngày nghỉ, ngày đi làm). Cuối cùng đề xuất một quy tắc đơn giản mỗi sáng: ngủ như vậy thì nên học loại việc gì.' },
    { label: 'Kế hoạch 7 ngày', prompt: 'Lập kế hoạch 7 ngày để cải thiện giấc ngủ dựa trên đúng dữ liệu của mình. Giữ giờ dậy hiện tại làm mốc, chỉ thay đổi tối đa 3 thứ cùng lúc. Với mỗi ngày ghi: giờ tắt màn hình, giờ lên giường, giờ báo thức và đúng 1 việc cần làm. Cuối kế hoạch nêu chỉ số nào trong app cho biết kế hoạch đang hiệu quả và ngưỡng để coi là thành công.' },
    { label: 'Kiểm tra dữ liệu', prompt: 'Rà dữ liệu giấc ngủ của mình: đêm nào có vẻ nhập sai hoặc bất thường, mục nào đang thiếu (SOL, chất lượng, thẻ…) khiến phân tích kém tin cậy, và mình nên bắt đầu ghi thêm gì để lần phân tích sau chính xác hơn.' }
  ];
  const SKILLS_SYSTEM = 'Bạn đang đọc dữ liệu tiến độ học kỹ năng cá nhân của người dùng (đã được app tính sẵn) trong <context>. Người dùng đang xây sự nghiệp tài chính/đầu tư và học song song nhiều track. Quy tắc: (1) chỉ dựa vào số liệu trong đó, trích số cụ thể; (2) giờ-theo-skill theo ngày chỉ có từ mốc ghi trong dữ liệu, nên đừng kết luận skill bị bỏ quên khi không có ngày; (3) tốc độ và ngày hoàn thành chỉ là ước tính thô, hãy nói như vậy; (4) khi đề xuất, ưu tiên ít việc nhưng rõ: tối đa 3 ưu tiên, mỗi ưu tiên nêu skill cụ thể, số giờ mỗi tuần và vì sao; (5) nếu dữ liệu không đủ thì nói rõ. Mặc định trả lời gọn (khoảng 300–400 từ) với tiêu đề ngắn, trừ khi được yêu cầu chi tiết.';
  const SKILLS_PRESETS = [
    { label: 'Tiến độ tổng thể', prompt: 'Đánh giá tiến độ học của mình: đang ở đâu so với mục tiêu từng track, nhịp học 8 tuần qua đang tăng hay giảm, và 3 điều đáng chú ý nhất kèm số liệu. Cuối cùng nói thẳng: với nhịp hiện tại, track nào hợp lý sẽ về đích và track nào gần như không.' },
    { label: 'Có học đúng thứ quan trọng?', prompt: 'Giờ học của mình có dồn vào đúng skill quan trọng không? So phân bố giờ theo mức ★ với danh sách skill ★4–5 chưa học, chỉ ra chỗ mình đang đầu tư lệch (quá nhiều vào thứ ít quan trọng hoặc đã đủ mục tiêu, quá ít vào thứ then chốt) và nên chuyển bao nhiêu giờ mỗi tuần.' },
    { label: 'Skill bị bỏ quên', prompt: 'Skill nào mình đã bắt đầu nhưng đang bị bỏ quên? Xếp theo mức nên quay lại trước (cân nhắc độ quan trọng, đã đầu tư bao nhiêu giờ, bao lâu chưa đụng). Với mỗi skill đáng quay lại, nêu 1 hành động đầu tiên nhỏ làm được trong 25 phút.' },
    { label: 'Kế hoạch 2 tuần', prompt: 'Lập kế hoạch học 2 tuần thực tế dựa trên số giờ mình thật sự học mỗi tuần (không phải số mình mong muốn). Tối đa 3 ưu tiên; mỗi ưu tiên ghi skill, số giờ mỗi tuần, ngày/giờ gợi ý theo khung sáng-chiều-tối nếu có, và dấu hiệu hoàn thành sau 2 tuần. Nếu mình đang học quá nhiều track song song thì đề xuất tạm dừng cái nào.' },
    { label: 'Chia giờ giữa các track', prompt: 'Mình đang học nhiều track song song. Dựa vào số giờ 28 ngày gần nhất, mục tiêu và deadline của các goal, đánh giá việc chia giờ giữa các track có hợp lý không, track nào đáng tập trung trước, track nào nên giảm xuống mức duy trì, và nêu cái giá phải trả của lựa chọn đó.' }
  ];

  async function openSleep() {
    let ai; try { ai = await ensureAi(); } catch (e) { say('Không tải được ai.js — hãy chắc chắn file ai.js nằm cạnh index.html.'); return; }
    ai.openPanel({
      title: 'Giấc ngủ — phân tích bằng AI', system: SLEEP_SYSTEM, presets: SLEEP_PRESETS,
      options: [
        { id: 'range', type: 'select', label: 'Phạm vi', value: '30', choices: [{ v: '14', l: '14 ngày' }, { v: '30', l: '30 ngày' }, { v: '90', l: '90 ngày' }, { v: '180', l: '180 ngày' }, { v: 'all', l: 'Toàn bộ lịch sử' }] },
        { id: 'recent', type: 'select', label: 'Chi tiết từng đêm', value: '14', choices: [{ v: '0', l: 'không' }, { v: '7', l: '7 đêm gần nhất' }, { v: '14', l: '14 đêm gần nhất' }, { v: '30', l: '30 đêm gần nhất' }] },
        { id: 'study', label: 'Kèm giờ học', checked: true },
        { id: 'notes', label: 'Kèm ghi chú tự viết của từng đêm', checked: false }
      ],
      build: async (st) => sleepText(st)
    });
  }
  async function openSkills() {
    let ai; try { ai = await ensureAi(); } catch (e) { say('Không tải được ai.js — hãy chắc chắn file ai.js nằm cạnh index.html.'); return; }
    const cur = safe(() => currentCareer, null), SD = safe(() => skillsData, {}) || {};
    const scopeChoices = [{ v: 'all', l: 'Tất cả track' }];
    if (cur && SD[cur]) scopeChoices.push({ v: 'current', l: 'Chỉ track đang mở: ' + (SD[cur].title || cur) });
    ai.openPanel({
      title: 'Tiến độ học — phân tích bằng AI', system: SKILLS_SYSTEM, presets: SKILLS_PRESETS,
      options: [
        { id: 'scope', type: 'select', label: 'Phạm vi', value: 'all', choices: scopeChoices },
        { id: 'days', type: 'select', label: 'Hoạt động gần đây', value: '30', choices: [{ v: '14', l: '14 ngày' }, { v: '30', l: '30 ngày' }, { v: '90', l: '90 ngày' }] },
        { id: 'gaps', label: 'Kèm skill quan trọng chưa học', checked: true },
        { id: 'goals', label: 'Kèm mục tiêu (Goals)', checked: true }
      ],
      build: async (st) => skillsText(st)
    });
  }

  window.VenusAIHub = { version: 1, sleep: openSleep, skills: openSkills, sleepText, skillsText,
    // structured twin of sleepText(): the same numbers as plain JSON (null when there is nothing to analyse)
    sleepData: (opts) => { const r = sleepText(opts); return r && r.data ? r.data : null; } };
})();