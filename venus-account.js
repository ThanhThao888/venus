/* Venus Hub — Venus Account (venus-account.js) · VPIS Phase 2B
   Classic <script>, loaded AFTER venus-memory-ui.js. Exposes window.VenusAccount { open, close, status, getClient, signOut, checkHealth }.

   • Sign-in with Email + Password (Supabase Auth). Sign-ups are switched OFF in the Supabase dashboard: the only account is the one created by the owner.
   • supabase-js (pinned, jsDelivr UMD) is loaded lazily: only when the Account dialog is opened, or when a saved session already exists. Nobody signed in ⇒ nothing extra is downloaded.
   • The session lives in its own IndexedDB "VenusAuthDB" (store kv). Never localStorage (it is ~95% full and is swept into backups). If IndexedDB fails, the session is kept in memory only
     and the dialog says so. Tokens are never logged and never written anywhere else. Storage key starts with "sb-" so even a stray localStorage copy would be excluded from backups.
   • Only the publishable key is used here. A secret / service_role key is refused at load time.
   • On sign-in (and on app start with a valid session) this device is upserted into public.user_devices; device_id comes from VenusMemory.getDeviceId().
   • "Your devices": every row except THIS device has a Remove button (two taps, no window.confirm). It deletes only the row (user_id, device_id) in public.user_devices with the user's own session
     (RLS policy from supabase/migrations/004). It never signs the other device out; a device that is still signed in registers itself again the next time it opens the app.
   • Offline / Supabase down: only a status line in the dialog. Nothing throws into the console and no other part of the app depends on this file.
   • All text from the server (email, device labels, errors) is rendered with textContent only. Styles: one <style id="vpis-acc-style">, every class prefixed vpis-acc-. */
(function () {
  'use strict';
  if (window.VenusAccount) return;

  /* ───────── configuration (public by design: Project URL + publishable key) ───────── */
  const SUPABASE_URL = 'https://fduosoknqohcwrbleqwg.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_GuE8-0HvkWmajti7yw2Jiw_ZS1v3zYj';
  const LIB_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/dist/umd/supabase.js';   // keep in sync with sw.js CDN_PRECACHE
  const STORAGE_KEY = 'sb-venus-auth';
  const AUTH_DB = 'VenusAuthDB', AUTH_STORE = 'kv';
  const NET_TIMEOUT = 12000, LIB_TIMEOUT = 20000;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /* Refuse anything that is not a publishable key. Pure function, also exposed for testing. */
  function keyProblem(k) {
    if (typeof k !== 'string' || !k.trim()) return 'empty';
    if (/^sb_secret_/i.test(k)) return 'secret';
    const parts = k.split('.');
    if (parts.length === 3) {
      try {
        const p = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (p && p.role === 'service_role') return 'secret';
      } catch (e) { /* not a JWT we can read: fall through */ }
    }
    return null;
  }
  const urlOk = (u) => /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(u || '');
  function configProblem() {
    const kp = keyProblem(SUPABASE_KEY);
    if (kp === 'secret') return 'The Supabase key in venus-account.js is a SECRET key (secret / service_role). Blocked: only the publishable key (sb_publishable_…) may be used here.';
    if (kp || !urlOk(SUPABASE_URL)) return 'Not configured: set the Project URL and publishable key at the top of venus-account.js.';
    return null;
  }

  /* ───────── tiny helpers ───────── */
  function el(tag, props, kids) {
    const n = document.createElement(tag);
    if (props) Object.keys(props).forEach((k) => {
      const v = props[k]; if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = String(v);
      else if (k === 'value') n.value = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n[k] = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    });
    (Array.isArray(kids) ? kids : kids == null ? [] : [kids]).forEach((c) => { if (c == null || c === false) return; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  const withTimeout = (p, ms, msg) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(msg || 'timeout')), ms); Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });
  const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const isoMs = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(typeof s === 'string' ? s : ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null; };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  function fmtDateTime(s) {   // Vietnam time (UTC+7), parsed by hand so the page's patched Date cannot skew it
    const ms = isoMs(s); if (ms == null) return '—';
    const t = new Date(ms + 7 * 3600e3).toISOString();
    return +t.slice(8, 10) + ' ' + MONTHS[+t.slice(5, 7) - 1] + ', ' + t.slice(11, 16);
  }

  /* Human error text. Never echoes server strings that could be long or odd; codes first, then a safe generic line. */
  function authErrText(e) {
    const code = e && (e.code || e.error_code), status = e && e.status, msg = String((e && e.message) || '');
    if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
    if (code === 'email_not_confirmed') return 'This account is not confirmed yet (in Supabase, tick "Auto Confirm User" or confirm the user).';
    if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || status === 429) return 'Too many attempts. Wait a few minutes and try again.';
    if (code === 'user_banned') return 'This account has been blocked.';
    if (/timeout|failed to fetch|networkerror|network request failed|load failed|offline/i.test(msg) || e instanceof TypeError) return 'Can\'t connect. The app keeps working normally; try again when you\'re online.';
    return 'Couldn\'t sign in' + (status ? ' (code ' + status + ')' : '') + '. Try again later.';
  }

  /* ───────── VenusAuthDB: the only place the session is stored ───────── */
  let authDbp = null, memMode = false;
  const memKv = new Map();
  const idbReq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error || new Error('idb request failed')); });
  function openAuthDb() {
    if (!authDbp) {
      authDbp = new Promise((resolve, reject) => {
        let r; try { r = indexedDB.open(AUTH_DB, 1); } catch (e) { return reject(e); }
        r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains(AUTH_STORE)) db.createObjectStore(AUTH_STORE, { keyPath: 'k' }); };
        r.onerror = () => reject(r.error || new Error('open failed'));
        r.onblocked = () => { /* an older version is open elsewhere: stays pending */ };
        r.onsuccess = () => { const db = r.result; db.onversionchange = () => { try { db.close(); } catch (e) { /* ignore */ } authDbp = null; }; resolve(db); };
      }).catch((e) => { authDbp = null; throw e; });
    }
    return authDbp;
  }
  const kv = {
    async get(k) {
      if (memMode) return memKv.has(k) ? memKv.get(k) : null;
      try { const db = await openAuthDb(); const row = await idbReq(db.transaction(AUTH_STORE, 'readonly').objectStore(AUTH_STORE).get(k)); return row && typeof row.v === 'string' ? row.v : null; }
      catch (e) { memMode = true; return memKv.has(k) ? memKv.get(k) : null; }
    },
    async set(k, v) {
      if (memMode) { memKv.set(k, String(v)); return; }
      try {
        const db = await openAuthDb(), tx = db.transaction(AUTH_STORE, 'readwrite');
        const done = new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error || new Error('tx error')); tx.onabort = () => rej(tx.error || new Error('tx aborted')); });
        tx.objectStore(AUTH_STORE).put({ k, v: String(v) }); await done;
      } catch (e) { memMode = true; memKv.set(k, String(v)); }
    },
    async del(k) {
      memKv.delete(k);
      if (memMode) return;
      try {
        const db = await openAuthDb(), tx = db.transaction(AUTH_STORE, 'readwrite');
        const done = new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error || new Error('tx error')); tx.onabort = () => rej(tx.error || new Error('tx aborted')); });
        tx.objectStore(AUTH_STORE).delete(k); await done;
      } catch (e) { memMode = true; }
    }
  };
  // supabase-js storage interface (all methods may be async)
  const authStorage = { getItem: (k) => kv.get(k), setItem: (k, v) => kv.set(k, v), removeItem: (k) => kv.del(k) };

  /* ───────── supabase-js, loaded on demand ───────── */
  let libP = null, clientP = null, client = null;
  function loadLib() {
    if (window.supabase && typeof window.supabase.createClient === 'function') return Promise.resolve(window.supabase);
    if (!libP) libP = new Promise((resolve, reject) => {
      const s = document.createElement('script'); s.src = LIB_URL; s.async = true; s.crossOrigin = 'anonymous';
      const t = setTimeout(() => { libP = null; s.remove(); reject(new Error('timeout')); }, LIB_TIMEOUT);
      s.onload = () => { clearTimeout(t); (window.supabase && typeof window.supabase.createClient === 'function') ? resolve(window.supabase) : (libP = null, reject(new Error('supabase-js loaded but createClient is missing'))); };
      s.onerror = () => { clearTimeout(t); libP = null; s.remove(); reject(new Error('Failed to fetch')); };
      document.head.appendChild(s);
    });
    return libP;
  }
  function getClient() {
    if (client) return Promise.resolve(client);
    if (!clientP) clientP = (async () => {
      const bad = configProblem(); if (bad) throw Object.assign(new Error(bad), { code: 'not_configured' });
      const lib = await loadLib();
      const c = lib.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { storage: authStorage, storageKey: STORAGE_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
      c.auth.onAuthStateChange((evt, session) => {   // never call supabase from inside this callback synchronously (deadlock): defer
        setTimeout(() => onAuth(evt, session), 0);
      });
      client = c; return c;
    })().catch((e) => { clientP = null; throw e; });
    return clientP;
  }

  /* ───────── state ───────── */
  const S = { user: null, email: null, devices: null, devicesErr: null, health: null, msg: null, busy: false, confirmOut: false, lib: 'idle', phase: 'idle', deviceNote: null, rmArmed: null, rmBusy: null };
  let dlg = null, box = null, msgTimer = null, confirmTimer = null, rmTimer = null, lastReg = { uid: null, at: 0 };

  // other modules (venus-sync.js) learn when the signed-in state really changes (restored session, sign-in, sign-out)
  const authListeners = []; let lastAuthKey = null;
  function emitAuth() {
    const key = S.user ? S.user.id : '';
    if (key === lastAuthKey) return; lastAuthKey = key;
    const st = { signedIn: !!S.user, email: S.email };
    authListeners.slice().forEach((f) => { try { f(st); } catch (e) { /* a listener must never break sign-in */ } });
  }
  function onChange(cb) { if (typeof cb !== 'function') return () => {}; authListeners.push(cb); return () => { const i = authListeners.indexOf(cb); if (i >= 0) authListeners.splice(i, 1); }; }

  function onAuth(evt, session) {
    const u = session && session.user ? session.user : null;
    const changed = (u && u.id) !== (S.user && S.user.id);
    S.user = u ? { id: u.id, email: u.email || '' } : null; S.email = S.user ? S.user.email : null;
    if (!u) { S.devices = null; S.health = null; S.confirmOut = false; S.rmArmed = null; }
    if (u && (evt === 'SIGNED_IN' || evt === 'INITIAL_SESSION' || changed)) registerDevice().then(() => { if (isOpen()) loadDevices(); });
    refreshMemoryUiButton(); emitAuth();
    if (isOpen()) render();
  }

  /* ───────── device registration ───────── */
  function deviceLabel() {
    const ua = navigator.userAgent || '', touch = navigator.maxTouchPoints > 1;
    const dev = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? (touch ? 'iPad' : 'Mac') : /Windows/.test(ua) ? 'Windows' : /Linux|X11/.test(ua) ? 'Linux' : 'Device';
    const br = /Edg\//.test(ua) ? 'Edge' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    let pwa = false; try { pwa = navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches); } catch (e) { /* ignore */ }
    return clip(dev + ' · ' + br + (pwa ? ' (PWA)' : ''), 80);
  }
  async function registerDevice() {
    const uid = S.user && S.user.id; if (!uid) return;
    if (lastReg.uid === uid && Date.now() - lastReg.at < 60000) return;   // SIGNED_IN can fire again on tab focus
    lastReg = { uid, at: Date.now() };
    try {
      if (!window.VenusMemory || typeof window.VenusMemory.getDeviceId !== 'function') { S.deviceNote = 'Device not registered yet (venus-memory.js is not loaded).'; return; }
      const id = await window.VenusMemory.getDeviceId();
      if (!UUID_RE.test(id || '')) { S.deviceNote = 'device_id is not a UUID, so this device was not registered.'; return; }
      const c = await getClient();
      const row = { user_id: uid, device_id: id, label: deviceLabel(), platform: clip(navigator.userAgent || '', 120), last_seen_at: new Date().toISOString() };
      const r = await withTimeout(c.from('user_devices').upsert(row, { onConflict: 'user_id,device_id' }), NET_TIMEOUT);
      S.deviceNote = r && r.error ? 'Couldn\'t register this device in the cloud.' : null;
      if (r && r.error) lastReg.at = 0;   // allow a retry sooner
    } catch (e) { S.deviceNote = 'Couldn\'t register this device in the cloud (offline?).'; lastReg.at = 0; }
  }
  async function loadDevices(manual) {   // manual === true only from the "Refresh" button (the button passes a wrapper, never the click event)
    if (!S.user) return;
    try {
      const c = await getClient();
      const r = await withTimeout(c.from('user_devices').select('device_id,label,platform,last_seen_at,created_at').order('last_seen_at', { ascending: false }).limit(20), NET_TIMEOUT);
      if (r.error) { S.devices = null; S.devicesErr = 'Couldn\'t load the device list.'; }
      else { S.devices = r.data || []; S.devicesErr = null; if (manual === true) say('Refreshed: ' + plural(S.devices.length, 'device') + '.', 'ok'); }
    } catch (e) { S.devices = null; S.devicesErr = 'Couldn\'t load the device list (offline?).'; }
    if (isOpen()) render();
  }

  /* ───────── actions ───────── */
  function say(text, type) {
    S.msg = text ? { text, type: type || 'info' } : null; paintMsg();
    clearTimeout(msgTimer); if (text) msgTimer = setTimeout(() => { S.msg = null; paintMsg(); }, 9000);
  }
  function paintMsg() {
    if (!box) return; const m = box.querySelector('.vpis-acc-msg'); if (!m) return;
    if (!S.msg) { m.hidden = true; m.textContent = ''; return; }
    m.hidden = false; m.className = 'vpis-acc-msg vpis-acc-msg--' + S.msg.type; m.textContent = S.msg.text;
  }

  /* Remove one OTHER device from the list. Guards: never the current device (checked again here from VenusMemory, not only from the UI),
     never while another removal is running, never offline. Server errors are mapped to short fixed texts (no server strings shown). */
  function rmErrText(e) {
    const code = e && e.code ? String(e.code) : '', status = e && e.status, msg = String((e && e.message) || '');
    if (code === '42501' || /permission denied|row-level security/i.test(msg)) return 'The server doesn\'t allow removing devices yet. Run supabase/migrations/004_user_devices_delete.sql in the Supabase SQL Editor, then try again.';
    if (status === 401 || status === 403 || code === 'PGRST301' || code === 'PGRST303' || /jwt|not_authenticated/i.test(msg)) return 'Your session expired. Sign out and sign in again, then retry.';
    if (/timeout|failed to fetch|networkerror|network request failed|load failed|offline|aborted/i.test(msg) || e instanceof TypeError || (!status && !code)) return 'Can\'t connect. The device was not removed; try again when you\'re online.';
    return 'Couldn\'t remove the device' + (code || status ? ' (code ' + clip(code || status, 20) + ')' : '') + '. Try again later.';
  }
  function armRemove(id) {
    if (S.rmBusy) return;
    S.rmArmed = id; clearTimeout(rmTimer);
    rmTimer = setTimeout(() => { S.rmArmed = null; render(); }, 4000); render();
  }
  async function removeDevice(d) {
    if (S.rmBusy || !S.user || !d || !UUID_RE.test(d.device_id || '')) return;
    clearTimeout(rmTimer); S.rmArmed = null;
    const target = String(d.device_id).toLowerCase();
    let me = null;
    try { me = window.VenusMemory && typeof window.VenusMemory.getDeviceId === 'function' ? await window.VenusMemory.getDeviceId() : null; } catch (e) { me = null; }
    if (!UUID_RE.test(me || '')) { say('Can\'t tell which device this is, so nothing was removed.', 'err'); render(); return; }
    if (String(me).toLowerCase() === target) { S._myDevice = me; say('This is the device you\'re using now; it can\'t be removed.', 'err'); render(); return; }
    if (navigator.onLine === false) { say('You\'re offline. The device was not removed.', 'err'); render(); return; }
    const uid = S.user.id;
    S.rmBusy = target; render();
    try {
      const c = await getClient();
      const ss = await withTimeout(c.auth.getSession(), NET_TIMEOUT);
      if (!(ss && ss.data && ss.data.session)) throw Object.assign(new Error('no session'), { status: 401 });
      const r = await withTimeout(c.from('user_devices').delete().eq('user_id', uid).eq('device_id', d.device_id).select('device_id'), NET_TIMEOUT);
      if (r && r.error) throw Object.assign(new Error(r.error.message || 'request failed'), { code: r.error.code, status: r.status });
      const gone = Array.isArray(r && r.data) ? r.data.length : 0;
      if (S.devices) S.devices = S.devices.filter((x) => String(x.device_id || '').toLowerCase() !== target);   // list updates at once
      say(gone ? 'Device removed.' : 'That device was already gone. List updated.', 'ok');
    } catch (e) { say(rmErrText(e), 'err'); }
    S.rmBusy = null; render();
    if (isOpen()) loadDevices();   // quiet re-read so the list matches the server
  }

  async function ensureSession() {   // restores a saved session (if any) and fills S.user
    S.phase = 'loading'; if (isOpen()) render();
    try {
      const c = await getClient();
      const r = await withTimeout(c.auth.getSession(), NET_TIMEOUT);
      const u = r && r.data && r.data.session && r.data.session.user;
      S.user = u ? { id: u.id, email: u.email || '' } : null; S.email = S.user ? S.user.email : null;
      S.lib = 'ok'; S.phase = 'ready';
      if (S.user) { await registerDevice(); }
    } catch (e) {
      S.lib = e && e.code === 'not_configured' ? 'config' : 'fail'; S.phase = 'ready';
      if (S.lib === 'config') S.fatal = e.message;
    }
    refreshMemoryUiButton(); emitAuth();
    if (isOpen()) { render(); if (S.user) loadDevices(); }
  }

  async function signIn(email, password) {
    if (S.busy) return;
    email = String(email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return say('Enter a valid email address.', 'err');
    if (!password) return say('Enter your password.', 'err');
    S.busy = true; render();
    try {
      const c = await getClient();
      const r = await withTimeout(c.auth.signInWithPassword({ email, password }), NET_TIMEOUT);
      if (r.error) throw r.error;
      const u = r.data && r.data.user; S.user = u ? { id: u.id, email: u.email || email } : null; S.email = S.user && S.user.email;
      S.lib = 'ok'; S.busy = false; say('Signed in.', 'ok');
      await registerDevice(); refreshMemoryUiButton(); emitAuth(); render(); loadDevices();
      return;
    } catch (e) {
      S.busy = false; if (e && (e.code === 'not_configured')) S.lib = 'config'; else if (!(e && e.status) && !(e && e.code)) S.lib = S.lib === 'ok' ? 'ok' : 'fail';
      say(e && e.code === 'not_configured' ? e.message : authErrText(e), 'err');
    }
    render();
  }

  async function signOut() {
    if (S.busy) return;
    S.busy = true; render();
    try { const c = await getClient(); await withTimeout(c.auth.signOut({ scope: 'local' }), NET_TIMEOUT); }
    catch (e) { /* even if the call fails, wipe the local copy below */ }
    await kv.del(STORAGE_KEY);   // make sure no token stays behind
    S.user = null; S.email = null; S.devices = null; S.health = null; S.confirmOut = false; S.rmArmed = null; S.rmBusy = null; S.busy = false; lastReg = { uid: null, at: 0 };
    say('Signed out on this device. Your Memory and Vault data were not touched.', 'ok');
    refreshMemoryUiButton(); emitAuth(); render();
  }

  async function checkHealth() {
    if (S.busy) return; S.busy = true; S.health = { state: 'running' }; render();
    try {
      const c = await getClient();
      const r = await withTimeout(c.auth.getSession(), NET_TIMEOUT);
      const tok = r && r.data && r.data.session && r.data.session.access_token;
      if (!tok) throw Object.assign(new Error('no session'), { code: 'no_session' });
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), NET_TIMEOUT);
      let res; try { res = await fetch(SUPABASE_URL + '/functions/v1/health', { headers: { Authorization: 'Bearer ' + tok, apikey: SUPABASE_KEY }, signal: ctl.signal }); } finally { clearTimeout(t); }
      let j = null; try { j = await res.json(); } catch (e) { /* not JSON */ }
      S.health = { state: 'done', http: res.status, ok: !!(j && j.ok), authenticated: !!(j && j.authenticated), db: j && j.db != null ? String(j.db) : null, error: j && j.error ? String(j.error) : null, at: Date.now() };
    } catch (e) {
      S.health = { state: 'fail', text: e && e.code === 'no_session' ? 'No active session.' : 'Can\'t reach Supabase (offline, or the project is paused). The app keeps working normally.' };
    }
    S.busy = false; render();
  }

  /* ───────── styles ───────── */
  function injectStyle() {
    if (document.getElementById('vpis-acc-style')) return;
    const css = [
      'body.ft-clean-on #vpisAccountDlg{display:none!important}',
      'html:has(dialog[open][id^="vpis"]),body:has(dialog[open][id^="vpis"]){overflow:hidden}',
      /* dialog shell */
      '.vpis-acc-dlg{border:0;padding:0;background:transparent;color:var(--text-dark);width:min(480px,94vw);max-width:none;max-height:none;margin:auto;overflow:hidden;border-radius:22px;overscroll-behavior:contain}',
      '.vpis-acc-dlg:focus,.vpis-acc-dlg:focus-visible{outline:none}',
      '.vpis-acc-dlg::backdrop{background:rgba(24,10,18,.58);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}',
      '.vpis-acc-dlg[open]{animation:vpis-acc-pop .2s cubic-bezier(.2,.8,.2,1)}',
      '@keyframes vpis-acc-pop{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion:reduce){.vpis-acc-dlg[open]{animation:none}}',
      '.vpis-acc-box{display:flex;flex-direction:column;box-sizing:border-box;max-height:min(86vh,820px);max-height:min(86dvh,820px);background:var(--bg-white);color:var(--text-dark);border:1px solid var(--border-color);border-radius:22px;overflow:hidden;box-shadow:var(--shadow-lg,0 12px 28px rgba(0,0,0,.3)),0 24px 60px rgba(24,10,18,.28),0 0 0 1px rgba(var(--primary-rgb,209,123,150),0.06);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color-scheme:light}',
      '.dark-mode .vpis-acc-box{color-scheme:dark}',
      '.vpis-acc-box>*{flex:0 0 auto;min-width:0}',
      '.vpis-acc-box>.vpis-acc-body{flex:1 1 auto;min-height:0}',
      '.vpis-acc-head{display:flex;align-items:center;gap:8px;padding:16px 16px 6px 22px;background:linear-gradient(180deg,rgba(var(--primary-rgb,209,123,150),0.1),transparent)}',
      '.vpis-acc-title{flex:1 1 auto;margin:0;font-size:1.15rem;font-weight:700;letter-spacing:-.01em;line-height:1.3}',
      '.vpis-acc-x{flex:0 0 auto;display:inline-grid;place-items:center;width:34px;height:34px;border:0;border-radius:50%;background:transparent;color:var(--text-muted);font-size:1.4rem;line-height:1;cursor:pointer;transition:background .15s,color .15s}',
      '.vpis-acc-x:hover{background:rgba(var(--primary-rgb,209,123,150),0.14);color:var(--text-dark)}',
      /* body = one vertical stack of cards */
      '.vpis-acc-body{overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:8px 20px 20px}',
      '.vpis-acc-stack{display:flex;flex-direction:column;gap:12px}',
      '.vpis-acc-body::-webkit-scrollbar,.vpis-acc-pre::-webkit-scrollbar,textarea.vpis-acc-in::-webkit-scrollbar{width:12px;height:12px}',
      '.vpis-acc-body::-webkit-scrollbar-track,.vpis-acc-pre::-webkit-scrollbar-track,textarea.vpis-acc-in::-webkit-scrollbar-track{background:transparent}',
      '.vpis-acc-body::-webkit-scrollbar-thumb,.vpis-acc-pre::-webkit-scrollbar-thumb,textarea.vpis-acc-in::-webkit-scrollbar-thumb{background:rgba(var(--primary-rgb,209,123,150),0.38);border-radius:99px;border:3px solid transparent;background-clip:padding-box}',
      '.vpis-acc-body::-webkit-scrollbar-thumb:hover,.vpis-acc-pre::-webkit-scrollbar-thumb:hover,textarea.vpis-acc-in::-webkit-scrollbar-thumb:hover{background:rgba(var(--primary-rgb,209,123,150),0.7);background-clip:padding-box}',
      '.vpis-acc-body::-webkit-scrollbar-button,.vpis-acc-pre::-webkit-scrollbar-button,textarea.vpis-acc-in::-webkit-scrollbar-button{display:none;width:0;height:0}',
      '.vpis-acc-body::-webkit-scrollbar-corner,.vpis-acc-pre::-webkit-scrollbar-corner,textarea.vpis-acc-in::-webkit-scrollbar-corner{background:transparent}',
      '@supports not selector(::-webkit-scrollbar){.vpis-acc-body,.vpis-acc-pre,textarea.vpis-acc-in{scrollbar-width:thin;scrollbar-color:rgba(var(--primary-rgb,209,123,150),0.5) transparent}}',
      /* text blocks */
      '.vpis-acc-note{font-size:.82rem;color:var(--text-muted);margin:0;white-space:pre-wrap;word-break:break-word}',
      '.vpis-acc-warn{font-size:.82rem;margin:0;padding:9px 12px;border-radius:12px;background:#fdf1e3;color:#8a5517;border:1px solid #e8c79a;white-space:pre-wrap;word-break:break-word}',
      '.dark-mode .vpis-acc-warn{background:#3a2d1c;color:#e0a05f;border-color:#6b4f2a}',
      '.vpis-acc-sub{color:var(--text-muted);font-size:.78rem}',
      /* buttons */
      '.vpis-acc-btn{border:1px solid var(--border-color);background:var(--bg-white);color:var(--text-dark);border-radius:12px;padding:6px 16px;font:inherit;font-size:.85rem;font-weight:600;cursor:pointer;min-height:38px;transition:background .15s,border-color .15s,filter .15s,box-shadow .15s}',
      '.vpis-acc-btn:hover:not(:disabled){border-color:var(--primary);background:rgba(var(--primary-rgb,209,123,150),0.1)}',
      '.vpis-acc-btn:disabled{opacity:.5;cursor:default}',
      '.vpis-acc-btn--pri{background:var(--primary);border-color:var(--primary);color:var(--bg-white);box-shadow:0 2px 8px rgba(var(--primary-rgb,209,123,150),0.3)}',
      '.vpis-acc-btn--pri:hover:not(:disabled){background:var(--primary);filter:brightness(1.07)}',
      '.vpis-acc-btn--danger{border-color:#d9a3ac;color:#a03647}.dark-mode .vpis-acc-btn--danger{border-color:#7a4650;color:#e58898}',
      '.vpis-acc-btn--danger:hover:not(:disabled){border-color:#b94a5a;background:rgba(185,74,90,.1)}',
      '.vpis-acc-btn--confirm{background:#b94a5a;border-color:#b94a5a;color:#fff}',
      '.vpis-acc-btn--confirm:hover:not(:disabled){background:#b94a5a;filter:brightness(1.08)}',
      '.vpis-acc-btn--sm{min-height:30px;padding:2px 12px;font-size:.78rem;border-radius:10px}',
      '.vpis-acc-btn--ghost{background:transparent;border-color:transparent;color:var(--text-muted)}',
      '.vpis-acc-btn--ghost:hover:not(:disabled){background:rgba(var(--primary-rgb,209,123,150),0.1);border-color:transparent;color:var(--text-dark)}',
      /* inputs (sign-in form) */
      '.vpis-acc-in{width:100%;box-sizing:border-box;border:1px solid var(--border-color);background:var(--bg-light);color:var(--text-dark);border-radius:12px;padding:9px 12px;font:inherit;font-size:16px;min-height:42px;transition:border-color .15s,box-shadow .15s}',
      'textarea.vpis-acc-in{resize:vertical;min-height:84px}',
      '.vpis-acc-in:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(var(--primary-rgb,209,123,150),0.22)}',
      '.vpis-acc-box :focus-visible{outline:2px solid var(--primary);outline-offset:2px}',
      '.vpis-acc-box input[type="checkbox"]{accent-color:var(--primary);width:16px;height:16px;margin:0}',
      '.vpis-acc-field{display:block;margin:0 0 12px}.vpis-acc-field>span{display:block;font-size:.78rem;color:var(--text-muted);margin-bottom:4px;font-weight:600}',
      '.vpis-acc-check{display:flex;align-items:center;gap:8px;font-size:.82rem;color:var(--text-muted);margin:-2px 0 14px;cursor:pointer}',
      /* cards */
      '.vpis-acc-card{border:1px solid var(--border-color);border-radius:16px;padding:14px 16px;margin:0;background:var(--bg-light);background:color-mix(in srgb,var(--primary) 4%,var(--bg-light))}',
      '.vpis-acc-cardhead{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:26px;margin:0 0 8px}',
      '.vpis-acc-h{margin:0;font-size:.72rem;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.06em}',
      '.vpis-acc-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}',
      '.vpis-acc-row--foot{margin-top:-2px;justify-content:center}',
      '.vpis-acc-row--full .vpis-acc-btn{flex:1 1 auto}',
      /* account card */
      '.vpis-acc-who{display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
      '.vpis-acc-avatar{flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:50%;background:var(--primary);color:var(--bg-white);font-weight:700;font-size:1.05rem;box-shadow:0 2px 8px rgba(var(--primary-rgb,209,123,150),0.3)}',
      '.vpis-acc-who-t{flex:1 1 140px;min-width:0}',
      '.vpis-acc-who .vpis-acc-btn{margin-left:auto}',
      '.vpis-acc-big{margin:0;font-weight:700;font-size:.95rem;overflow-wrap:anywhere;line-height:1.3}',
      '.vpis-acc-live{display:flex;align-items:center;gap:6px;margin:2px 0 0}',
      '.vpis-acc-live::before{content:"";width:7px;height:7px;border-radius:50%;background:#4f8a6b}',
      /* status pill + chips */
      '.vpis-acc-pill{display:inline-block;padding:1px 10px;border-radius:99px;font-size:.7rem;font-weight:700;letter-spacing:.03em;border:1px solid var(--border-color);background:var(--bg-white);color:var(--text-muted)}',
      '.vpis-acc-pill--on{background:rgba(79,138,107,.14);border-color:rgba(79,138,107,.45);color:#2f6a4b}.dark-mode .vpis-acc-pill--on{color:#7fc3a0}',
      '.vpis-acc-chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0}',
      '.vpis-acc-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 10px;border-radius:99px;font-size:.74rem;border:1px solid var(--border-color);background:var(--bg-white);color:var(--text-muted)}',
      '.vpis-acc-chip b{color:var(--text-dark);font-weight:700}',
      '.vpis-acc-chip--warn{background:#fdf1e3;border-color:#e8c79a;color:#8a5517}.vpis-acc-chip--warn b{color:inherit}',
      '.dark-mode .vpis-acc-chip--warn{background:#3a2d1c;border-color:#6b4f2a;color:#e0a05f}',
      '.vpis-acc-chip--bad{background:rgba(185,74,90,.1);border-color:rgba(185,74,90,.45);color:#a03647}.vpis-acc-chip--bad b{color:inherit}',
      '.dark-mode .vpis-acc-chip--bad{color:#e58898}',
      /* devices */
      '.vpis-acc-devs{display:flex;flex-direction:column}',
      '.vpis-acc-dev{padding:9px 0;border-top:1px solid var(--border-color)}.vpis-acc-dev:first-child{border-top:0;padding-top:2px}.vpis-acc-dev:last-child{padding-bottom:0}',
      '.vpis-acc-dev-n{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-weight:600}',
      '.vpis-acc-badge{display:inline-block;padding:0 9px;border-radius:99px;font-size:.68rem;font-weight:700;background:rgba(var(--primary-rgb,209,123,150),0.16);color:var(--text-dark);border:1px solid rgba(var(--primary-rgb,209,123,150),0.4)}',
      '.vpis-acc-dev--row{display:flex;align-items:center;gap:10px}.vpis-acc-dev-t{flex:1 1 auto;min-width:0}.vpis-acc-dev-t .vpis-acc-sub{overflow-wrap:anywhere}.vpis-acc-dev--row .vpis-acc-btn{flex:0 0 auto;margin-left:auto;white-space:nowrap}',
      '.vpis-acc-dev:first-child .vpis-acc-btn{margin-top:-2px}',
      /* messages */
      '.vpis-acc-msg{margin:2px 20px 0;padding:9px 12px;border-radius:12px;font-size:.85rem;border:1px solid var(--border-color);background:var(--bg-light)}',
      '.vpis-acc-msg--ok{border-color:#4f8a6b;color:#2f6a4b}.vpis-acc-msg--err{border-color:#b94a5a;color:#a03647}',
      '.dark-mode .vpis-acc-msg--ok{color:#7fc3a0}.dark-mode .vpis-acc-msg--err{color:#e58898}',
      '@media (max-width:640px){.vpis-acc-dlg{width:100vw;height:100vh;height:100dvh;margin:0;border-radius:0}.vpis-acc-box{height:100%;max-height:none;border-radius:0;border:0;padding-top:env(safe-area-inset-top,0px)}.vpis-acc-btn{min-height:44px}.vpis-acc-btn--sm{min-height:36px}.vpis-acc-head{padding:12px 12px 4px 16px}.vpis-acc-x{width:40px;height:40px}.vpis-acc-body{padding:8px 16px calc(18px + env(safe-area-inset-bottom,0px))}.vpis-acc-msg{margin-left:16px;margin-right:16px}}'
    ].join('\n');
    const st = document.createElement('style'); st.id = 'vpis-acc-style'; st.textContent = css; document.head.appendChild(st);
  }

  /* ───────── render ───────── */
  const btn = (text, cls, onclick, disabled) => el('button', { type: 'button', class: 'vpis-acc-btn' + (cls ? ' ' + cls : ''), text, disabled: !!disabled, onclick });

  function signInView() {
    const email = el('input', { class: 'vpis-acc-in', type: 'email', name: 'email', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', inputmode: 'email', placeholder: 'Your email', disabled: S.busy });
    const pw = el('input', { class: 'vpis-acc-in', type: 'password', name: 'password', autocomplete: 'current-password', placeholder: 'Your password', disabled: S.busy });
    const show = el('input', { type: 'checkbox', onchange: () => { pw.type = show.checked ? 'text' : 'password'; } });
    const form = el('form', { novalidate: true, onsubmit: (ev) => { ev.preventDefault(); const p = pw.value; signIn(email.value, p).then(() => { try { pw.value = ''; } catch (e) { /* ignore */ } }); } }, [
      el('label', { class: 'vpis-acc-field' }, [el('span', { text: 'Email' }), email]),
      el('label', { class: 'vpis-acc-field' }, [el('span', { text: 'Password' }), pw]),
      el('label', { class: 'vpis-acc-check' }, [show, el('span', { text: 'Show password' })]),
      el('div', { class: 'vpis-acc-row vpis-acc-row--full', style: 'margin-top:0' }, [el('button', { type: 'submit', class: 'vpis-acc-btn vpis-acc-btn--pri', text: S.busy ? 'Signing in…' : 'Sign in', disabled: S.busy })])
    ]);
    return el('div', { class: 'vpis-acc-stack' }, [
      el('p', { class: 'vpis-acc-note', text: 'Signing in is optional: until you do, everything works exactly as before. This is your own private account; there is no sign-up.' }),
      S.lib === 'fail' ? el('div', { class: 'vpis-acc-warn', text: 'Couldn\'t load the sign-in library (offline or blocked). Try again when you\'re online; the app keeps working normally.' }) : null,
      form
    ]);
  }
  function healthView() {
    const h = S.health; if (!h) return null;
    if (h.state === 'running') return el('p', { class: 'vpis-acc-note', text: 'Checking…' });
    if (h.state === 'fail') return el('p', { class: 'vpis-acc-note', text: h.text });
    const good = h.ok && h.authenticated && h.db === 'ok';
    const t = good ? 'Connection OK: authenticated, and the database is reachable.' : 'Problem: HTTP ' + h.http + ', authenticated=' + h.authenticated + ', db=' + (h.db || '—') + (h.error ? ', error=' + clip(h.error, 60) : '') + '.';
    return el('div', { class: good ? 'vpis-acc-msg vpis-acc-msg--ok' : 'vpis-acc-msg vpis-acc-msg--err', style: 'margin:0', text: t });
  }
  function syncBlock() {   // the "Memory sync" card lives in venus-sync.js; the account dialog works without it
    try { return window.VenusSync && typeof window.VenusSync.renderBlock === 'function' ? window.VenusSync.renderBlock() : null; } catch (e) { return null; }
  }
  function signedInView() {
    const myId = S._myDevice || null;
    const canRm = !!(myId && UUID_RE.test(myId));   // unknown own id ⇒ no Remove button anywhere
    const isMe = (d) => !!(myId && String(d.device_id || '').toLowerCase() === String(myId).toLowerCase());
    const devRow = (d) => {
      const mine = isMe(d), id = String(d.device_id || '').toLowerCase(), armedRm = S.rmArmed === id, busyRm = S.rmBusy === id;
      const info = el('div', { class: 'vpis-acc-dev-t' }, [
        el('div', { class: 'vpis-acc-dev-n' }, [el('span', { text: clip(d.label, 80) || 'Device' }), mine ? el('span', { class: 'vpis-acc-badge', text: 'This device' }) : null]),
        el('div', { class: 'vpis-acc-sub', text: 'Last seen ' + fmtDateTime(d.last_seen_at) + ' · ' + String(d.device_id || '').slice(0, 6) })
      ]);
      if (!canRm || mine || !UUID_RE.test(id)) return el('div', { class: 'vpis-acc-dev' }, info);
      return el('div', { class: 'vpis-acc-dev vpis-acc-dev--row' }, [info,
        btn(busyRm ? 'Removing…' : armedRm ? 'Confirm?' : 'Remove', 'vpis-acc-btn--sm ' + (armedRm ? 'vpis-acc-btn--confirm' : 'vpis-acc-btn--danger'),
          () => { if (!armedRm) return armRemove(id); removeDevice(d); }, !!S.rmBusy || S.busy)]);
    };
    const hasOthers = !!(S.devices && canRm && S.devices.some((d) => !isMe(d)));
    const devs = S.devices ? (S.devices.length ? S.devices.map(devRow) : [el('p', { class: 'vpis-acc-sub', text: 'No devices yet.' })]) : [el('p', { class: 'vpis-acc-sub', text: S.devicesErr || 'Loading…' })];
    const armed = S.confirmOut;
    return el('div', { class: 'vpis-acc-stack' }, [
      el('div', { class: 'vpis-acc-card' }, el('div', { class: 'vpis-acc-who' }, [
        el('span', { class: 'vpis-acc-avatar', 'aria-hidden': 'true', text: (S.email || '?').trim().charAt(0).toUpperCase() || '?' }),
        el('div', { class: 'vpis-acc-who-t' }, [el('p', { class: 'vpis-acc-big', text: S.email || '(no email)' }), el('p', { class: 'vpis-acc-sub vpis-acc-live', text: 'Signed in' })]),
        btn(armed ? 'Confirm sign out' : 'Sign out', 'vpis-acc-btn--sm ' + (armed ? 'vpis-acc-btn--confirm' : 'vpis-acc-btn--danger'), () => {
          if (!armed) { S.confirmOut = true; clearTimeout(confirmTimer); confirmTimer = setTimeout(() => { S.confirmOut = false; render(); }, 4000); render(); return; }
          clearTimeout(confirmTimer); signOut();
        }, S.busy)
      ])),
      memMode ? el('div', { class: 'vpis-acc-warn', text: 'Couldn\'t write to the browser\'s IndexedDB: the session is kept in memory only and will be lost when the page reloads.' }) : null,
      S.deviceNote ? el('p', { class: 'vpis-acc-note', text: S.deviceNote }) : null,
      syncBlock(),
      el('div', { class: 'vpis-acc-card' }, [
        el('div', { class: 'vpis-acc-cardhead' }, [el('p', { class: 'vpis-acc-h', text: 'Your devices' }), btn('Refresh', 'vpis-acc-btn--sm vpis-acc-btn--ghost', () => loadDevices(true), S.busy)]),
        el('div', { class: 'vpis-acc-devs' }, devs),
        hasOthers ? el('p', { class: 'vpis-acc-note', style: 'margin-top:10px', text: 'Remove only deletes a device from this list. A device that is still signed in will appear again the next time it opens the app.' }) : null
      ]),
      healthView(),
      el('div', { class: 'vpis-acc-row vpis-acc-row--foot' }, [btn('Check connection', 'vpis-acc-btn--sm vpis-acc-btn--ghost', checkHealth, S.busy)])
    ]);
  }
  function render() {
    if (!box) return;
    const prev = box.querySelector('.vpis-acc-body'), scroll = prev ? prev.scrollTop : 0;
    // keep what is being typed if we re-render while the form is showing
    const typed = {}; box.querySelectorAll('input[name]').forEach((i) => { if (i.name === 'email') typed.email = i.value; });
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(el('div', { class: 'vpis-acc-head' }, [el('h2', { class: 'vpis-acc-title', id: 'vpisAccTitle', text: 'Venus Account' }), el('button', { type: 'button', class: 'vpis-acc-x', 'aria-label': 'Close', text: '×', onclick: close })]));
    box.appendChild(el('div', { class: 'vpis-acc-msg', role: 'status', 'aria-live': 'polite', hidden: true }));
    const body = el('div', { class: 'vpis-acc-body' });
    const bad = configProblem();
    if (bad) body.appendChild(el('div', { class: 'vpis-acc-warn', text: bad }));
    else if (S.phase === 'loading' || S.phase === 'idle') body.appendChild(el('p', { class: 'vpis-acc-note', text: 'Loading…' }));
    else if (S.user) body.appendChild(signedInView());
    else {
      body.appendChild(signInView());
      if (typed.email) { const i = body.querySelector('input[name="email"]'); if (i) i.value = typed.email; }
    }
    box.appendChild(body); paintMsg(); body.scrollTop = scroll;
  }

  /* ───────── open / close ───────── */
  function build() {
    injectStyle();
    dlg = el('dialog', { id: 'vpisAccountDlg', class: 'vpis-acc-dlg', 'aria-labelledby': 'vpisAccTitle' });
    box = el('div', { class: 'vpis-acc-box' }); dlg.appendChild(box);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    dlg.addEventListener('close', () => { S.confirmOut = false; S.rmArmed = null; clearTimeout(rmTimer); });
    document.body.appendChild(dlg);
  }
  function isOpen() { return !!(dlg && dlg.open); }
  async function open() {
    if (!dlg) build();
    if (!dlg.open) { try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); } }
    S.msg = null; S.confirmOut = false; S.rmArmed = null; render();
    if (window.VenusMemory && typeof window.VenusMemory.getDeviceId === 'function') window.VenusMemory.getDeviceId().then((id) => { S._myDevice = id; if (isOpen()) render(); }).catch(() => {});
    if (!configProblem()) { await ensureSession(); } else render();
  }
  function close() { if (dlg && dlg.open) { try { dlg.close(); } catch (e) { dlg.removeAttribute('open'); } } }

  /* ───────── glue with the Memory modal button (label shows the signed-in state) ───────── */
  function refreshMemoryUiButton() {
    try { const b = document.getElementById('vpisAccountBtn'); if (b) b.classList.toggle('vpis-signed', !!S.user); } catch (e) { /* ignore */ }
  }

  /* ───────── start-up: restore a saved session quietly, only if one exists ───────── */
  async function boot() {
    try {
      if (configProblem()) return;
      if (!(window.indexedDB)) return;
      const saved = await kv.get(STORAGE_KEY);
      if (!saved) return;                     // never signed in on this device: load nothing
      S.phase = 'idle';
      await ensureSession();
    } catch (e) { /* quiet */ }
  }
  const startBoot = () => { if (typeof window.requestIdleCallback === 'function') requestIdleCallback(() => { boot(); }, { timeout: 4000 }); else boot(); };
  const later = () => setTimeout(startBoot, 2500);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', later); else later();

  window.VenusAccount = {
    version: 1, open, close, isOpen,
    status: () => ({ signedIn: !!S.user, email: S.email, storage: memMode ? 'memory' : 'indexeddb' }),
    getClient, signOut, checkHealth, onChange,
    _keyProblem: keyProblem
  };
})();
