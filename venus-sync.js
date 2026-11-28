/* Venus Hub — Sync engine + Sync Center (venus-sync.js) · VPIS Phase 3B
   Classic <script>, loaded AFTER venus-account.js. Exposes window.VenusSync { syncNow, enable, disable, status, onChange, renderBlock }.

   • Syncs ONLY VenusMemoryDB (profile + decisions) with Supabase through the Phase 3A API of window.VenusMemory (outbox, cursor, conflicts).
     Never copies localStorage, Notes Vault, API keys or tokens. The network client comes from VenusAccount.getClient() (publishable key + the user's own session).
   • OFF by default. Turned on from the "Memory sync" card inside the Account dialog, after an explicit confirmation. The switch lives in VenusMemoryDB.syncMeta (not localStorage).
   • One run = PULL (sync_changes with seq > cursor, 200 per page) → PUSH (outbox via RPC vpis_push, 50 per call) → a short PULL so the cursor passes our own writes.
     First run on a device (sync_initialized = false): pull everything from seq 0, queue the local records the cloud lacks (enqueueSnapshot), then push.
   • Conflicts are never merged silently: the item is held (not pushed), both versions are shown, the user picks "Keep this device's version" or "Take cloud version".
   • Triggers: sign-in, app start (+3 s), tab becomes visible, back online, after a write (debounced 2 s), "Sync now". No Background Sync (not on iOS).
   • At most one run at a time (in this tab by a flag, across tabs by Web Locks when available; the server is idempotent, so a double run is harmless anyway).
   • Offline / Supabase down: outbox untouched, status line only, nothing thrown into the console. Nothing else in the app depends on this file.
   • Text from the server or from memory items is rendered with textContent only. Styles: one <style id="vpis-sync-style">, classes prefixed vpis-sync-. */
(function () {
  'use strict';
  if (window.VenusSync) return;

  const CFG = { page: 200, pushBatch: 50, maxPullPages: 25, maxPushRounds: 20, netTimeout: 20000, debounce: 2000, startDelay: 3000, visibleGap: 15000, retryDelay: 5000 };
  const VM = () => window.VenusMemory, ACC = () => window.VenusAccount;
  const APPROVED = { approvedByUser: true };

  /* ───────── helpers ───────── */
  function el(tag, props, kids) {
    const n = document.createElement(tag);
    if (props) Object.keys(props).forEach((k) => {
      const v = props[k]; if (v == null || v === false) return;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = String(v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n[k] = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    (Array.isArray(kids) ? kids : kids == null ? [] : [kids]).forEach((c) => { if (c == null || c === false) return; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  const withTimeout = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });
  const clip = (s, n) => { s = String(s == null ? '' : s).replace(/[ \t]+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const isoMs = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(typeof s === 'string' ? s : ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null; };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  function fmt(s) {   // Vietnam time (UTC+7), parsed by hand so the page's patched Date cannot skew it
    const ms = isoMs(s); if (ms == null) return '—';
    const t = new Date(ms + 7 * 3600e3).toISOString(); return +t.slice(8, 10) + ' ' + MONTHS[+t.slice(5, 7) - 1] + ', ' + t.slice(11, 16);
  }
  const lc = (s) => String(s == null ? '' : s).toLowerCase();

  /* One failing request → a small, safe category. Server strings are never shown. */
  function classify(e) {
    const status = e && e.status, code = e && e.code ? String(e.code) : '', msg = String((e && e.message) || '');
    if (status === 401 || status === 403 || code === 'PGRST301' || code === 'PGRST303' || code === '28000' || /jwt|not_authenticated/i.test(msg)) return { kind: 'auth', code: code || String(status || '') };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return { kind: 'offline' };
    if (/failed to fetch|networkerror|network request failed|load failed|timeout|offline|aborted|fetch/i.test(msg) || e instanceof TypeError || (!status && !code)) return { kind: 'offline' };
    return { kind: 'error', code: (code || String(status || '')).slice(0, 20) };
  }
  async function call(p) {   // supabase-js resolves with { data, error, status }; turn error into a throw we can classify
    const r = await withTimeout(p, CFG.netTimeout);
    if (r && r.error) throw Object.assign(new Error(r.error.message || 'request failed'), { code: r.error.code, status: r.status });
    return r;
  }

  /* ───────── state ───────── */
  const S = {
    phase: 'idle',            // idle | syncing | offline | error | auth | needs_update | signed_out
    enabled: false, initialized: false, lastAt: null, lastErrCode: null,
    pending: 0, stuck: 0, conflicts: [], lastRunAt: 0, summary: null,
    confirmEnable: false, armed: null, msg: null, busy: false, counts: null
  };
  let running = null, again = false, writeTimer = null, retryTimer = null, msgTimer = null, armTimer = null;
  const listeners = [];
  const blocks = new Set();

  const isStuck = (o) => typeof o.last_error === 'string' && o.last_error.indexOf('invalid:') === 0;
  async function refreshState() {
    const m = VM(); if (!m) return;
    try {
      const st = await m.getSyncState();
      S.enabled = st.sync_enabled; S.initialized = st.sync_initialized; S.lastAt = st.last_sync_at; S.pending = st.outbox_pending;
      S.conflicts = st.conflicts ? await m.listConflicts() : [];
      const ob = st.outbox_pending ? await m.listOutbox(500) : [];
      S.stuck = ob.filter((o) => isStuck(o)).length;
    } catch (e) { /* memory DB unavailable: keep the old picture */ }
  }
  function emit() { const s = status(); listeners.slice().forEach((f) => { try { f(s); } catch (e) { /* never break the engine */ } }); }
  function setPhase(p) { S.phase = p; paint(); emit(); }

  function status() {
    return { enabled: S.enabled, initialized: S.initialized, phase: S.phase, running: !!running, last_sync_at: S.lastAt, pending: S.pending, stuck: S.stuck, conflicts: S.conflicts.length, error_code: S.lastErrCode };
  }
  function onChange(cb) { if (typeof cb !== 'function') return () => {}; listeners.push(cb); return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; }

  /* ───────── the three phases ───────── */
  const wire = (o) => ({ op_id: o.op_id, entity_type: o.entity_type, entity_id: o.entity_id, op: o.op, revision: o.revision, device_id: o.device_id, payload: o.payload });

  // known !== null ⇒ first run: read from seq 0 and remember the highest revision per entity (applyRemote itself skips what the cursor has already passed).
  async function pullPhase(client, known) {
    const out = { applied: 0, conflicts: 0, key_clash: 0, invalid: 0, halted: null, more: false };
    let after = known ? 0 : (await VM().getSyncState()).last_sync_cursor;
    for (let page = 0; page < CFG.maxPullPages; page++) {
      const r = await call(client.from('sync_changes').select('seq,entity_type,entity_id,revision,op,device_id,payload').gt('seq', after).order('seq', { ascending: true }).limit(CFG.page));
      const rows = Array.isArray(r.data) ? r.data : [];
      if (!rows.length) return out;
      if (known) rows.forEach((x) => { const k = x.entity_type + ':' + x.entity_id; if (!(known[k] >= x.revision)) known[k] = x.revision; });
      const res = await VM().applyRemote(rows);
      out.applied += res.applied; out.conflicts += res.conflicts; out.key_clash += res.key_clash; out.invalid += res.invalid;
      if (res.halted) { out.halted = res.halted; return out; }
      after = rows[rows.length - 1].seq;
      if (rows.length < CFG.page) return out;
    }
    out.more = true; return out;
  }

  async function pushPhase(client) {
    const out = { pushed: 0, conflicts: 0, rejected: 0 }, tried = new Set();
    for (let round = 0; round < CFG.maxPushRounds; round++) {
      const held = new Set();
      (await VM().listConflicts()).forEach((c) => held.add(c.key));
      const ops = (await VM().listOutbox(500)).filter((o) => !held.has(o.entity_type + ':' + o.entity_id) && !isStuck(o) && !tried.has(o.op_id)).slice(0, CFG.pushBatch);
      if (!ops.length) break;
      ops.forEach((o) => tried.add(o.op_id));
      let r;
      try { r = await call(client.rpc('vpis_push', { ops: ops.map(wire) })); }
      catch (e) { await VM().touchOutbox(ops.map((o) => o.op_id), 'network').catch(() => {}); throw e; }
      const results = r.data && r.data.results;
      if (!Array.isArray(results) || results.length !== ops.length) throw Object.assign(new Error('unexpected RPC result'), { code: 'bad_result' });
      const acked = [], conflicts = [], bad = new Map();
      results.forEach((x, i) => {
        const o = ops[i];
        if (!x || lc(x.op_id) !== lc(o.op_id)) { (bad.get('error:mismatch') || bad.set('error:mismatch', []).get('error:mismatch')).push(o.op_id); return; }
        if (x.status === 'ok' || x.status === 'duplicate') acked.push(o.op_id);
        else if (x.status === 'conflict') conflicts.push({ entity_type: o.entity_type, entity_id: o.entity_id, reason: x.reason, server: x.server });
        else if (x.status === 'invalid' || x.status === 'error') { const k = (x.status === 'invalid' ? 'invalid:' : 'error:') + clip(x.reason || x.code || '', 40); (bad.get(k) || bad.set(k, []).get(k)).push(o.op_id); }
        /* 'blocked': belongs to an entity that just conflicted; it stays queued and is held from now on */
      });
      await VM().ackOutbox(acked);
      if (conflicts.length) await VM().addConflicts(conflicts);
      for (const [why, ids] of bad) await VM().touchOutbox(ids, why);
      out.pushed += acked.length; out.conflicts += conflicts.length; out.rejected += Array.from(bad.values()).reduce((a, b) => a + b.length, 0);
    }
    return out;
  }

  async function withLock(fn) {
    if (navigator.locks && typeof navigator.locks.request === 'function') {
      return navigator.locks.request('venus-sync', { ifAvailable: true }, async (lock) => (lock ? fn() : { skipped: 'other_tab' }));
    }
    return fn();
  }

  async function doSync() {
    const client = await ACC().getClient();
    const sess = await withTimeout(client.auth.getSession(), CFG.netTimeout);
    if (!sess || !sess.data || !sess.data.session) return { phase: 'signed_out' };
    const st = await VM().getSyncState(), known = st.sync_initialized ? null : {};
    const sum = { pulled: 0, pushed: 0, conflicts: 0, rejected: 0, changed: false };
    let p = await pullPhase(client, known);
    sum.pulled += p.applied; sum.conflicts += p.conflicts + p.key_clash;
    if (p.halted) return { phase: 'needs_update', sum: Object.assign(sum, { changed: p.applied > 0 }) };
    if (known) await VM().enqueueSnapshot(known);
    const q = await pushPhase(client);
    sum.pushed = q.pushed; sum.conflicts += q.conflicts; sum.rejected = q.rejected;
    if (q.pushed || p.more) { p = await pullPhase(client, null); sum.pulled += p.applied; sum.conflicts += p.conflicts + p.key_clash; if (p.halted) return { phase: 'needs_update', sum: Object.assign(sum, { changed: sum.pulled > 0 }) }; }
    sum.changed = sum.pulled > 0;
    await VM().setSyncMeta('last_sync_at', new Date().toISOString());
    await VM().setSyncMeta('last_sync_error', null);
    try { const id = await VM().getDeviceId(); Promise.resolve(client.from('user_devices').update({ last_sync_at: new Date().toISOString() }).eq('device_id', id)).catch(() => {}); } catch (e) { /* best effort */ }
    return { phase: 'idle', sum };
  }

  async function run(reason) {
    if (!VM() || !ACC() || typeof VM().getSyncState !== 'function') return { skipped: 'no_modules' };
    let st; try { st = await VM().getSyncState(); } catch (e) { return { skipped: 'memory_db' }; }
    S.enabled = st.sync_enabled; S.initialized = st.sync_initialized;
    if (!st.sync_enabled) { await refreshState(); paint(); return { skipped: 'disabled' }; }
    if (!ACC().status().signedIn) { await refreshState(); setPhase('signed_out'); return { skipped: 'signed_out' }; }
    if (navigator.onLine === false) { await refreshState(); setPhase('offline'); return { skipped: 'offline' }; }
    S.lastRunAt = Date.now(); setPhase('syncing');
    let out;
    try { out = await withLock(doSync); }
    catch (e) {
      const c = classify(e); S.lastErrCode = c.code || null;
      try { await VM().setSyncMeta('last_sync_error', c.kind + (c.code ? ':' + c.code : '')); } catch (x) { /* ignore */ }
      await refreshState(); setPhase(c.kind); return { error: c.kind };
    }
    if (out && out.skipped === 'other_tab') {
      await refreshState(); setPhase(S.phase === 'syncing' ? 'idle' : S.phase);
      if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = null; syncNow('retry'); }, CFG.retryDelay);
      return out;
    }
    S.lastErrCode = null; S.summary = out.sum || null;
    await refreshState(); setPhase(out.phase || 'idle');
    if (out.sum && out.sum.changed) dataChanged();
    return out;
  }

  function syncNow(reason) {
    if (running) { again = true; return running; }
    const p = run(reason || 'manual').catch(() => ({ error: 'internal' })).then((r) => { running = null; if (again) { again = false; setTimeout(() => syncNow('again'), 0); } return r; });
    running = p; return p;
  }

  // other modules (and the Memory modal) learn about data that arrived from the cloud
  function dataChanged() {
    try { window.dispatchEvent(new CustomEvent('venus-memory-changed', { detail: { source: 'sync' } })); } catch (e) { /* ignore */ }
    try {
      const ui = window.VenusMemoryUI, dlg = document.getElementById('vpisMemoryDlg');
      // never refresh under an open edit form: it would rebuild the form and drop what is being typed (the list refreshes the next time the modal opens)
      if (ui && ui.isOpen && ui.isOpen() && dlg && !dlg.querySelector('.vpis-form')) ui.refresh();
    } catch (e) { /* ignore */ }
  }

  /* ───────── user actions ───────── */
  function say(text, type) { S.msg = text ? { text, type: type || 'info' } : null; paint(); clearTimeout(msgTimer); if (text) msgTimer = setTimeout(() => { S.msg = null; paint(); }, 9000); }
  const arm = (key) => { S.armed = key; paint(); clearTimeout(armTimer); armTimer = setTimeout(() => { S.armed = null; paint(); }, 4000); };

  async function enable() {
    try { await VM().setSyncMeta('sync_enabled', true); } catch (e) { say('Couldn\'t turn sync on (IndexedDB error).', 'err'); return; }
    S.confirmEnable = false; await refreshState(); say('Sync turned on.', 'ok'); return syncNow('enable');
  }
  async function disable() {
    try { await VM().setSyncMeta('sync_enabled', false); } catch (e) { say('Couldn\'t turn sync off (IndexedDB error).', 'err'); return; }
    await refreshState(); S.phase = 'idle'; say('Sync turned off. Your data on this device and in the cloud is untouched; new changes now stay on this device only.', 'ok'); emit();
  }
  async function resolve(c, how) {
    if (S.busy) return; S.busy = true; paint();
    try {
      if (how === 'local') await VM().keepLocal(c.key, APPROVED); else await VM().takeRemote(c.key, APPROVED);
      S.armed = null; await refreshState(); await withClashLocals(); say(how === 'local' ? 'Kept this device\'s version; uploading it to the cloud.' : 'Took the cloud version.', 'ok'); dataChanged();
      S.busy = false; paint(); syncNow('resolve');
    } catch (e) { S.busy = false; await refreshState(); say('Couldn\'t resolve this conflict (' + clip((e && e.code) || 'error', 30) + '). Try syncing again.', 'err'); }
  }
  async function dropStuck() {
    if (S.busy) return; S.busy = true; paint();
    try { const ids = (await VM().listOutbox(500)).filter(isStuck).map((o) => o.op_id); const n = await VM().ackOutbox(ids); S.armed = null; await refreshState(); say('Discarded ' + plural(n, 'rejected change') + '. Your data on this device was not deleted.', 'ok'); }
    catch (e) { say('Couldn\'t discard the rejected changes.', 'err'); }
    S.busy = false; paint();
  }
  async function manualSync() { if (S.busy) return; say(null); const r = await syncNow('manual'); if (r && r.skipped === 'offline') say('You\'re offline.', 'info'); }

  /* ───────── UI: one block inside the Account dialog ───────── */
  function injectStyle() {
    if (document.getElementById('vpis-sync-style')) return;
    const css = [
      '.vpis-sync-stat{margin:0;font-size:.9rem;font-weight:600;line-height:1.4}',
      '.vpis-sync-stat--ok{color:#2f6a4b}.vpis-sync-stat--bad{color:#a03647}.vpis-sync-stat--warn{color:#8a5517}',
      '.dark-mode .vpis-sync-stat--ok{color:#7fc3a0}.dark-mode .vpis-sync-stat--bad{color:#e58898}.dark-mode .vpis-sync-stat--warn{color:#e0a05f}',
      '.vpis-sync-ver{border:1px solid var(--border-color);border-radius:12px;padding:8px 10px;margin:6px 0 0;background:var(--bg-white)}',
      '.vpis-sync-ver b{display:block;font-size:.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em}',
      '.vpis-sync-txt{margin:3px 0 0;white-space:pre-wrap;word-break:break-word;font-size:.82rem}',
      '.vpis-sync-conf{border-top:1px solid var(--border-color);padding-top:12px;margin-top:12px}',
      '.vpis-sync-title{margin:0 0 2px;font-weight:700;word-break:break-word}'
    ].join('\n');
    const st = document.createElement('style'); st.id = 'vpis-sync-style'; st.textContent = css; document.head.appendChild(st);
  }
  const btn = (text, cls, onclick, disabled) => el('button', { type: 'button', class: 'vpis-acc-btn' + (cls ? ' ' + cls : ''), text, disabled: !!disabled, onclick });

  function describe(rec, type) {
    if (!rec) return null;
    const del = rec.deleted_at ? ' · deleted' : '';
    if (type === 'profile') return { head: clip(rec.key, 60) + ' · ' + (rec.category || 'other') + del, body: clip(rec.content, 400) };
    return { head: clip(rec.title, 80) + ' · ' + (rec.status || '') + del, body: clip(rec.content, 400) + (rec.rationale ? '\n— ' + clip(rec.rationale, 150) : '') };
  }
  function verBox(label, rec, type, rev) {
    const d = describe(rec, type);
    return el('div', { class: 'vpis-sync-ver' }, d ? [
      el('b', { text: label + ' · rev ' + (rev != null ? rev : rec.revision) + ' · ' + fmt(rec.updated_at) }),
      el('p', { class: 'vpis-sync-txt', text: d.head }), el('p', { class: 'vpis-sync-txt vpis-acc-sub', text: d.body })
    ] : [el('b', { text: label }), el('p', { class: 'vpis-sync-txt vpis-acc-sub', text: 'This version can\'t be read.' })]);
  }
  const REASON = { stale_revision: 'Both sides edited this item.', remote_changed_while_pending: 'The cloud has a newer version while this device still has unsent changes.', revision_gap: 'The cloud and this device are several revisions apart.', key_clash: 'The cloud has a different profile item that uses the same key as one on this device.' };

  function conflictView(c) {
    const type = c.entity_type, clash = c.reason === 'key_clash', srv = c.server && c.server.payload;
    const localRec = clash ? (c._clash || null) : c.local;
    const kLocal = c.key + ':local', kRemote = c.key + ':remote';
    return el('div', { class: 'vpis-sync-conf' }, [
      el('p', { class: 'vpis-sync-title', text: (type === 'profile' ? 'Profile' : 'Decision') + ': ' + clip(srv ? (srv.key || srv.title) : (localRec && (localRec.key || localRec.title)) || c.entity_id, 60) }),
      el('p', { class: 'vpis-acc-note', text: REASON[c.reason] || REASON.stale_revision }),
      verBox('This device', localRec, type), verBox('Cloud', srv, type, c.server && c.server.revision),
      el('div', { class: 'vpis-acc-row' }, [
        btn(S.armed === kLocal ? 'Tap again to confirm' : (clash ? 'Keep this device\'s version (removes the cloud duplicate)' : 'Keep this device\'s version'), S.armed === kLocal ? 'vpis-acc-btn--confirm' : '',
          () => { if (!clash) return resolve(c, 'local'); if (S.armed !== kLocal) return arm(kLocal); resolve(c, 'local'); }, S.busy || (!clash && !localRec)),
        btn(S.armed === kRemote ? 'Tap again to confirm' : (clash ? 'Take cloud version (removes the local duplicate)' : 'Take cloud version'), S.armed === kRemote ? 'vpis-acc-btn--confirm' : 'vpis-acc-btn--danger',
          () => { if (S.armed !== kRemote) return arm(kRemote); resolve(c, 'remote'); }, S.busy || !srv)
      ])
    ]);
  }

  function statusLine() {
    if (!S.enabled) return ['Sync is off. Turn it on to share your Profile and Decisions between laptop and iPhone.', ''];
    const done = S.lastAt ? 'Last synced ' + fmt(S.lastAt) + '.' : 'Not synced yet.';
    switch (S.phase) {
      case 'syncing': return ['Syncing…', ''];
      case 'offline': return ['Offline. Changes stay on this device and will be sent when you\'re back online.', 'warn'];
      case 'auth': return ['Your session expired or was rejected. Sign out and sign in again.', 'bad'];
      case 'signed_out': return ['Not signed in, so nothing is syncing.', 'warn'];
      case 'needs_update': return ['The cloud has data from a newer version of the app. Reload the page to update, then sync again. Nothing has been lost.', 'warn'];
      case 'error': return ['Sync failed' + (S.lastErrCode ? ' (code ' + S.lastErrCode + ')' : '') + '. Your data on this device is unaffected; try again later.', 'bad'];
      default: return [S.conflicts.length ? 'There are conflicts for you to resolve below. ' + done : done, S.conflicts.length ? 'warn' : 'ok'];
    }
  }

  async function ensureCounts() {
    try { const st = await VM().stats(); S.counts = { profile: st.profile, decisions: st.decisions.proposed + st.decisions.approved + st.decisions.superseded }; } catch (e) { S.counts = null; }
    paint();
  }

  const chip = (label, n, tone) => el('span', { class: 'vpis-acc-chip' + (tone ? ' vpis-acc-chip--' + tone : '') }, [el('span', { text: label }), el('b', { text: String(n) })]);
  function build(box) {
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!VM() || typeof VM().getSyncState !== 'function') { box.appendChild(el('p', { class: 'vpis-acc-note', text: 'Unavailable: a newer venus-memory.js is required.' })); return; }
    const [line, tone] = statusLine();
    const kids = [
      el('div', { class: 'vpis-acc-cardhead' }, [el('p', { class: 'vpis-acc-h', text: 'Memory sync' }), el('span', { class: 'vpis-acc-pill' + (S.enabled ? ' vpis-acc-pill--on' : ''), text: S.enabled ? 'On' : 'Off' })]),
      el('p', { class: 'vpis-sync-stat' + (tone ? ' vpis-sync-stat--' + tone : ''), role: 'status', text: line })
    ];
    if (S.msg) kids.push(el('div', { class: 'vpis-acc-msg vpis-acc-msg--' + S.msg.type, style: 'margin:8px 0 0', text: S.msg.text }));
    if (S.enabled) kids.push(el('div', { class: 'vpis-acc-chips' }, [chip('Pending', S.pending), chip('Conflicts', S.conflicts.length, S.conflicts.length ? 'warn' : ''), S.stuck ? chip('Rejected', S.stuck, 'bad') : null]));
    if (!S.enabled && S.confirmEnable) {
      const n = S.counts;
      kids.push(el('div', { class: 'vpis-acc-warn', style: 'margin-top:10px', text: 'The memory on this device' + (n ? ' (' + plural(n.profile, 'profile item') + ', ' + plural(n.decisions, 'decision') + ')' : '') + ' will be uploaded to the cloud and shared with every device signed in to this account. Memory content will leave this device. Notes Vault, API keys and tokens are never sent.' }));
      kids.push(el('div', { class: 'vpis-acc-row' }, [btn('Confirm and turn on', 'vpis-acc-btn--pri', () => { enable(); }, S.busy), btn('Cancel', '', () => { S.confirmEnable = false; paint(); })]));
    } else {
      kids.push(el('div', { class: 'vpis-acc-row' }, [
        S.enabled ? btn('Sync now', 'vpis-acc-btn--pri', manualSync, S.phase === 'syncing' || S.busy) : btn('Turn on sync…', 'vpis-acc-btn--pri', () => { S.confirmEnable = true; paint(); ensureCounts(); }),
        S.enabled ? btn('Turn off sync', '', () => { disable(); }, S.phase === 'syncing' || S.busy) : null
      ]));
    }
    if (S.enabled && S.stuck) {
      const k = 'stuck';
      kids.push(el('p', { class: 'vpis-acc-note', style: 'margin-top:12px', text: plural(S.stuck, 'change') + (S.stuck === 1 ? ' was' : ' were') + ' rejected by the server as invalid and will not be retried. Your data on this device is still there.' }));
      kids.push(el('div', { class: 'vpis-acc-row', style: 'margin-top:8px' }, [btn(S.armed === k ? 'Tap again to discard' : 'Discard rejected changes', S.armed === k ? 'vpis-acc-btn--confirm' : 'vpis-acc-btn--danger', () => { if (S.armed !== k) return arm(k); dropStuck(); }, S.busy)]));
    }
    if (S.enabled) S.conflicts.forEach((c) => kids.push(conflictView(c)));
    kids.forEach((k) => box.appendChild(k));
  }

  async function withClashLocals() {   // for key_clash entries the "local" side is the other item that owns the key
    for (const c of S.conflicts) if (c.reason === 'key_clash' && c.clash_with && !c._clash) { try { c._clash = await VM().getItem('profile', c.clash_with); } catch (e) { /* ignore */ } }
  }
  function paint() { blocks.forEach((b) => { if (!b.isConnected) { blocks.delete(b); return; } try { build(b); } catch (e) { /* keep the dialog alive */ } }); }
  function renderBlock() {
    injectStyle();
    const box = el('div', { class: 'vpis-acc-card' }); blocks.add(box); build(box);
    refreshState().then(withClashLocals).then(paint);
    return box;
  }

  /* ───────── triggers ───────── */
  const trigger = (why) => { syncNow(why); };
  function start() {
    if (!VM() || !ACC() || typeof VM().onWrite !== 'function') return;
    VM().onWrite(() => { clearTimeout(writeTimer); writeTimer = setTimeout(() => trigger('write'), CFG.debounce); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - S.lastRunAt > CFG.visibleGap) trigger('visible'); });
    window.addEventListener('online', () => trigger('online'));
    if (typeof ACC().onChange === 'function') ACC().onChange((a) => { if (a && a.signedIn) trigger('signin'); else if (S.enabled) setPhase('signed_out'); });
    setTimeout(() => trigger('start'), CFG.startDelay);
  }

  window.VenusSync = { version: 1, syncNow, enable, disable, status, onChange, renderBlock, _cfg: CFG };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
