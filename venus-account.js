/* Venus Hub — Venus Account (venus-account.js) · VPIS Phase 2B
   Classic <script>, loaded AFTER venus-memory-ui.js. Exposes window.VenusAccount { open, close, status, getClient, signOut, checkHealth }.

   • Sign-in with Email + Password (Supabase Auth). Sign-ups are switched OFF in the Supabase dashboard: the only account is the one created by the owner.
   • supabase-js (pinned, jsDelivr UMD) is loaded lazily: only when the Account dialog is opened, or when a saved session already exists. Nobody signed in ⇒ nothing extra is downloaded.
   • The session lives in its own IndexedDB "VenusAuthDB" (store kv). Never localStorage (it is ~95% full and is swept into backups). If IndexedDB fails, the session is kept in memory only
     and the dialog says so. Tokens are never logged and never written anywhere else. Storage key starts with "sb-" so even a stray localStorage copy would be excluded from backups.
   • Only the publishable key is used here. A secret / service_role key is refused at load time.
   • On sign-in (and on app start with a valid session) this device is upserted into public.user_devices; device_id comes from VenusMemory.getDeviceId().
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
    if (kp === 'secret') return 'Khóa Supabase trong venus-account.js là khóa BÍ MẬT (secret / service_role). Đã chặn: chỉ được dùng publishable key (sb_publishable_…).';
    if (kp || !urlOk(SUPABASE_URL)) return 'Chưa cấu hình: điền Project URL và publishable key ở đầu venus-account.js.';
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
  function fmtDateTime(s) {   // Vietnam time (UTC+7), parsed by hand so the page's patched Date cannot skew it
    const ms = isoMs(s); if (ms == null) return '—';
    const t = new Date(ms + 7 * 3600e3).toISOString();
    return t.slice(8, 10) + '/' + t.slice(5, 7) + ' ' + t.slice(11, 16);
  }

  /* Human error text. Never echoes server strings that could be long or odd; codes first, then a safe generic line. */
  function authErrText(e) {
    const code = e && (e.code || e.error_code), status = e && e.status, msg = String((e && e.message) || '');
    if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return 'Email hoặc mật khẩu không đúng.';
    if (code === 'email_not_confirmed') return 'Tài khoản chưa được xác nhận (trong Supabase, tick "Auto Confirm User" hoặc xác nhận user).';
    if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || status === 429) return 'Thử quá nhiều lần. Đợi vài phút rồi thử lại.';
    if (code === 'user_banned') return 'Tài khoản này đang bị khóa.';
    if (/timeout|failed to fetch|networkerror|network request failed|load failed|offline/i.test(msg) || e instanceof TypeError) return 'Không kết nối được. App vẫn chạy bình thường; thử lại khi có mạng.';
    return 'Không đăng nhập được' + (status ? ' (mã ' + status + ')' : '') + '. Thử lại sau.';
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
  const S = { user: null, email: null, devices: null, devicesErr: null, health: null, msg: null, busy: false, confirmOut: false, lib: 'idle', phase: 'idle', deviceNote: null };
  let dlg = null, box = null, msgTimer = null, confirmTimer = null, lastReg = { uid: null, at: 0 };

  function onAuth(evt, session) {
    const u = session && session.user ? session.user : null;
    const changed = (u && u.id) !== (S.user && S.user.id);
    S.user = u ? { id: u.id, email: u.email || '' } : null; S.email = S.user ? S.user.email : null;
    if (!u) { S.devices = null; S.health = null; S.confirmOut = false; }
    if (u && (evt === 'SIGNED_IN' || evt === 'INITIAL_SESSION' || changed)) registerDevice().then(() => { if (isOpen()) loadDevices(); });
    refreshMemoryUiButton();
    if (isOpen()) render();
  }

  /* ───────── device registration ───────── */
  function deviceLabel() {
    const ua = navigator.userAgent || '', touch = navigator.maxTouchPoints > 1;
    const dev = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? (touch ? 'iPad' : 'Mac') : /Windows/.test(ua) ? 'Windows' : /Linux|X11/.test(ua) ? 'Linux' : 'Thiết bị';
    const br = /Edg\//.test(ua) ? 'Edge' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Trình duyệt';
    let pwa = false; try { pwa = navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches); } catch (e) { /* ignore */ }
    return clip(dev + ' · ' + br + (pwa ? ' (PWA)' : ''), 80);
  }
  async function registerDevice() {
    const uid = S.user && S.user.id; if (!uid) return;
    if (lastReg.uid === uid && Date.now() - lastReg.at < 60000) return;   // SIGNED_IN can fire again on tab focus
    lastReg = { uid, at: Date.now() };
    try {
      if (!window.VenusMemory || typeof window.VenusMemory.getDeviceId !== 'function') { S.deviceNote = 'Chưa ghi được thiết bị (venus-memory.js chưa tải).'; return; }
      const id = await window.VenusMemory.getDeviceId();
      if (!UUID_RE.test(id || '')) { S.deviceNote = 'device_id không phải UUID nên chưa ghi thiết bị.'; return; }
      const c = await getClient();
      const row = { user_id: uid, device_id: id, label: deviceLabel(), platform: clip(navigator.userAgent || '', 120), last_seen_at: new Date().toISOString() };
      const r = await withTimeout(c.from('user_devices').upsert(row, { onConflict: 'user_id,device_id' }), NET_TIMEOUT);
      S.deviceNote = r && r.error ? 'Chưa ghi được thiết bị lên cloud.' : null;
      if (r && r.error) lastReg.at = 0;   // allow a retry sooner
    } catch (e) { S.deviceNote = 'Chưa ghi được thiết bị lên cloud (offline?).'; lastReg.at = 0; }
  }
  async function loadDevices() {
    if (!S.user) return;
    try {
      const c = await getClient();
      const r = await withTimeout(c.from('user_devices').select('device_id,label,platform,last_seen_at,created_at').order('last_seen_at', { ascending: false }).limit(20), NET_TIMEOUT);
      if (r.error) { S.devices = null; S.devicesErr = 'Không đọc được danh sách thiết bị.'; }
      else { S.devices = r.data || []; S.devicesErr = null; }
    } catch (e) { S.devices = null; S.devicesErr = 'Không đọc được danh sách thiết bị (offline?).'; }
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
    refreshMemoryUiButton();
    if (isOpen()) { render(); if (S.user) loadDevices(); }
  }

  async function signIn(email, password) {
    if (S.busy) return;
    email = String(email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return say('Email chưa đúng định dạng.', 'err');
    if (!password) return say('Nhập mật khẩu.', 'err');
    S.busy = true; render();
    try {
      const c = await getClient();
      const r = await withTimeout(c.auth.signInWithPassword({ email, password }), NET_TIMEOUT);
      if (r.error) throw r.error;
      const u = r.data && r.data.user; S.user = u ? { id: u.id, email: u.email || email } : null; S.email = S.user && S.user.email;
      S.lib = 'ok'; S.busy = false; say('Đã đăng nhập.', 'ok');
      await registerDevice(); refreshMemoryUiButton(); render(); loadDevices();
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
    S.user = null; S.email = null; S.devices = null; S.health = null; S.confirmOut = false; S.busy = false; lastReg = { uid: null, at: 0 };
    say('Đã đăng xuất khỏi thiết bị này. Dữ liệu Memory/Vault không bị động tới.', 'ok');
    refreshMemoryUiButton(); render();
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
      S.health = { state: 'fail', text: e && e.code === 'no_session' ? 'Chưa có phiên đăng nhập.' : 'Không kết nối được tới Supabase (offline hoặc project đang tạm dừng). App vẫn chạy bình thường.' };
    }
    S.busy = false; render();
  }

  /* ───────── styles ───────── */
  function injectStyle() {
    if (document.getElementById('vpis-acc-style')) return;
    const css = [
      'body.ft-clean-on #vpisAccountDlg{display:none!important}',
      '.vpis-acc-dlg{border:0;padding:0;background:transparent;color:var(--text-dark);width:min(480px,94vw);max-width:none;max-height:none;margin:auto;overflow:visible}',
      '.vpis-acc-dlg::backdrop{background:rgba(40,20,32,.5)}',
      '.vpis-acc-box{display:flex;flex-direction:column;box-sizing:border-box;max-height:86vh;max-height:86dvh;background:var(--bg-white);color:var(--text-dark);border:1px solid var(--border-color);border-radius:18px;overflow:hidden;box-shadow:0 18px 48px rgba(0,0,0,.28);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
      '.vpis-acc-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 16px 6px}',
      '.vpis-acc-title{margin:0;font-size:1.1rem;font-weight:700}',
      '.vpis-acc-x{border:0;background:transparent;color:var(--text-muted);font-size:1.6rem;line-height:1;cursor:pointer;min-width:40px;min-height:40px;border-radius:10px}',
      '.vpis-acc-body{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:8px 16px 14px}',
      '.vpis-acc-msg{margin:0 16px 6px;padding:8px 12px;border-radius:10px;font-size:.85rem;border:1px solid var(--border-color);background:var(--bg-light)}',
      '.vpis-acc-msg--ok{border-color:#4f8a6b;color:#2f6a4b}.vpis-acc-msg--err{border-color:#b94a5a;color:#a03647}',
      '.dark-mode .vpis-acc-msg--ok{color:#7fc3a0}.dark-mode .vpis-acc-msg--err{color:#e58898}',
      '.vpis-acc-note{font-size:.8rem;color:var(--text-muted);margin:0 0 10px;white-space:pre-wrap;word-break:break-word}',
      '.vpis-acc-warn{font-size:.82rem;margin:0 0 10px;padding:8px 12px;border-radius:10px;background:#fdf1e3;color:#8a5517;border:1px solid #e8c79a}',
      '.dark-mode .vpis-acc-warn{background:#3a2d1c;color:#e0a05f;border-color:#6b4f2a}',
      '.vpis-acc-field{display:block;margin-bottom:10px}.vpis-acc-field>span{display:block;font-size:.78rem;color:var(--text-muted);margin-bottom:2px}',
      '.vpis-acc-in{width:100%;box-sizing:border-box;border:1px solid var(--border-color);background:var(--bg-light);color:var(--text-dark);border-radius:10px;padding:8px 10px;font:inherit;font-size:16px;min-height:40px}',
      '.vpis-acc-check{display:flex;align-items:center;gap:6px;font-size:.82rem;color:var(--text-muted);margin:-4px 0 10px}',
      '.vpis-acc-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}',
      '.vpis-acc-btn{border:1px solid var(--border-color);background:var(--bg-white);color:var(--text-dark);border-radius:10px;padding:6px 14px;font:inherit;font-size:.85rem;cursor:pointer;min-height:40px}',
      '.vpis-acc-btn:disabled{opacity:.5;cursor:default}',
      '.vpis-acc-btn--pri{background:var(--primary);border-color:var(--primary);color:var(--bg-white);font-weight:700}',
      '.vpis-acc-btn--danger{border-color:#b94a5a;color:#a03647}.dark-mode .vpis-acc-btn--danger{color:#e58898}',
      '.vpis-acc-btn--confirm{background:#b94a5a;border-color:#b94a5a;color:#fff;font-weight:700}',
      '.vpis-acc-card{border:1px solid var(--border-color);border-radius:14px;padding:10px 12px;margin-bottom:10px;background:var(--bg-light)}',
      '.vpis-acc-h{margin:0 0 4px;font-size:.78rem;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.03em}',
      '.vpis-acc-big{margin:0;font-weight:700;word-break:break-all}',
      '.vpis-acc-dev{padding:6px 0;border-bottom:1px dashed var(--border-color)}.vpis-acc-dev:last-child{border-bottom:0}',
      '.vpis-acc-badge{display:inline-block;margin-left:6px;padding:0 8px;border-radius:99px;font-size:.7rem;font-weight:700;background:var(--primary-light);color:var(--text-dark);border:1px solid var(--border-color)}',
      '.vpis-acc-sub{color:var(--text-muted);font-size:.78rem}',
      '@media (max-width:640px){',
      ' .vpis-acc-dlg{width:100vw;height:100vh;height:100dvh;margin:0}',
      ' .vpis-acc-box{height:100%;max-height:none;border-radius:0;border:0;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}',
      ' .vpis-acc-btn{min-height:44px}',
      '}'
    ].join('\n');
    const st = document.createElement('style'); st.id = 'vpis-acc-style'; st.textContent = css; document.head.appendChild(st);
  }

  /* ───────── render ───────── */
  const btn = (text, cls, onclick, disabled) => el('button', { type: 'button', class: 'vpis-acc-btn' + (cls ? ' ' + cls : ''), text, disabled: !!disabled, onclick });

  function signInView() {
    const email = el('input', { class: 'vpis-acc-in', type: 'email', name: 'email', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', inputmode: 'email', placeholder: 'email của bạn', disabled: S.busy });
    const pw = el('input', { class: 'vpis-acc-in', type: 'password', name: 'password', autocomplete: 'current-password', placeholder: 'mật khẩu', disabled: S.busy });
    const show = el('input', { type: 'checkbox', onchange: () => { pw.type = show.checked ? 'text' : 'password'; } });
    const form = el('form', { novalidate: true, onsubmit: (ev) => { ev.preventDefault(); const p = pw.value; signIn(email.value, p).then(() => { try { pw.value = ''; } catch (e) { /* ignore */ } }); } }, [
      el('label', { class: 'vpis-acc-field' }, [el('span', { text: 'Email' }), email]),
      el('label', { class: 'vpis-acc-field' }, [el('span', { text: 'Mật khẩu' }), pw]),
      el('label', { class: 'vpis-acc-check' }, [show, el('span', { text: 'Hiện mật khẩu' })]),
      el('div', { class: 'vpis-acc-row' }, [el('button', { type: 'submit', class: 'vpis-acc-btn vpis-acc-btn--pri', text: S.busy ? 'Đang đăng nhập…' : 'Đăng nhập', disabled: S.busy })])
    ]);
    return el('div', null, [
      el('p', { class: 'vpis-acc-note', text: 'Đăng nhập là tùy chọn: chưa đăng nhập thì mọi thứ vẫn chạy y như trước. Đây là tài khoản riêng của bạn; không có đăng ký mới.' }),
      S.lib === 'fail' ? el('div', { class: 'vpis-acc-warn', text: 'Chưa tải được thư viện đăng nhập (offline hoặc bị chặn). Thử lại khi có mạng; app vẫn chạy bình thường.' }) : null,
      form
    ]);
  }
  function healthView() {
    const h = S.health; if (!h) return null;
    if (h.state === 'running') return el('p', { class: 'vpis-acc-note', text: 'Đang kiểm tra…' });
    if (h.state === 'fail') return el('p', { class: 'vpis-acc-note', text: h.text });
    const good = h.ok && h.authenticated && h.db === 'ok';
    const t = good ? 'Kết nối tốt: đã xác thực, đọc được cơ sở dữ liệu.' : 'Có vấn đề: HTTP ' + h.http + ', authenticated=' + h.authenticated + ', db=' + (h.db || '—') + (h.error ? ', lỗi=' + clip(h.error, 60) : '') + '.';
    return el('div', { class: good ? 'vpis-acc-msg vpis-acc-msg--ok' : 'vpis-acc-msg vpis-acc-msg--err', style: 'margin:0 0 10px', text: t });
  }
  function signedInView() {
    const myId = S._myDevice || null;
    const devs = S.devices ? (S.devices.length ? S.devices.map((d) => el('div', { class: 'vpis-acc-dev' }, [
      el('div', null, [document.createTextNode(clip(d.label, 80) || 'Thiết bị'), (myId && d.device_id === myId) ? el('span', { class: 'vpis-acc-badge', text: 'Thiết bị này' }) : null]),
      el('div', { class: 'vpis-acc-sub', text: 'thấy lần cuối ' + fmtDateTime(d.last_seen_at) + ' · ' + String(d.device_id || '').slice(0, 6) })
    ])) : [el('p', { class: 'vpis-acc-sub', text: 'Chưa có thiết bị nào.' })]) : [el('p', { class: 'vpis-acc-sub', text: S.devicesErr || 'Đang tải…' })];
    const armed = S.confirmOut;
    return el('div', null, [
      el('div', { class: 'vpis-acc-card' }, [el('p', { class: 'vpis-acc-h', text: 'Đã đăng nhập' }), el('p', { class: 'vpis-acc-big', text: S.email || '(không có email)' })]),
      memMode ? el('div', { class: 'vpis-acc-warn', text: 'Không ghi được vào IndexedDB của trình duyệt: phiên đăng nhập chỉ giữ trong bộ nhớ và sẽ mất khi tải lại trang.' }) : null,
      S.deviceNote ? el('p', { class: 'vpis-acc-note', text: S.deviceNote }) : null,
      el('div', { class: 'vpis-acc-card' }, [el('p', { class: 'vpis-acc-h', text: 'Thiết bị của bạn' })].concat(devs)),
      healthView(),
      el('div', { class: 'vpis-acc-row' }, [
        btn('Kiểm tra kết nối', '', checkHealth, S.busy),
        btn('Tải lại thiết bị', '', loadDevices, S.busy),
        btn(armed ? 'Bấm lần nữa để đăng xuất' : 'Đăng xuất', armed ? 'vpis-acc-btn--confirm' : 'vpis-acc-btn--danger', () => {
          if (!armed) { S.confirmOut = true; clearTimeout(confirmTimer); confirmTimer = setTimeout(() => { S.confirmOut = false; render(); }, 4000); render(); return; }
          clearTimeout(confirmTimer); signOut();
        }, S.busy)
      ])
    ]);
  }
  function render() {
    if (!box) return;
    const prev = box.querySelector('.vpis-acc-body'), scroll = prev ? prev.scrollTop : 0;
    // keep what is being typed if we re-render while the form is showing
    const typed = {}; box.querySelectorAll('input[name]').forEach((i) => { if (i.name === 'email') typed.email = i.value; });
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(el('div', { class: 'vpis-acc-head' }, [el('h2', { class: 'vpis-acc-title', id: 'vpisAccTitle', text: 'Tài khoản Venus' }), el('button', { type: 'button', class: 'vpis-acc-x', 'aria-label': 'Đóng', text: '×', onclick: close })]));
    box.appendChild(el('div', { class: 'vpis-acc-msg', role: 'status', 'aria-live': 'polite', hidden: true }));
    const body = el('div', { class: 'vpis-acc-body' });
    const bad = configProblem();
    if (bad) body.appendChild(el('div', { class: 'vpis-acc-warn', text: bad }));
    else if (S.phase === 'loading' || S.phase === 'idle') body.appendChild(el('p', { class: 'vpis-acc-note', text: 'Đang tải…' }));
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
    dlg.addEventListener('close', () => { S.confirmOut = false; });
    document.body.appendChild(dlg);
  }
  function isOpen() { return !!(dlg && dlg.open); }
  async function open() {
    if (!dlg) build();
    if (!dlg.open) { try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); } }
    S.msg = null; S.confirmOut = false; render();
    if (window.VenusMemory && typeof window.VenusMemory.getDeviceId === 'function') window.VenusMemory.getDeviceId().then((id) => { S._myDevice = id; if (isOpen()) render(); }).catch(() => {});
    if (!configProblem()) { await ensureSession(); } else render();
  }
  function close() { if (dlg && dlg.open) { try { dlg.close(); } catch (e) { dlg.removeAttribute('open'); } } }

  /* ───────── glue with the Memory modal button (label shows the signed-in state) ───────── */
  function refreshMemoryUiButton() {
    try { const b = document.getElementById('vpisAccountBtn'); if (b) b.textContent = S.user ? '☁ Tài khoản ✓' : '☁ Tài khoản'; } catch (e) { /* ignore */ }
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
    getClient, signOut, checkHealth,
    _keyProblem: keyProblem
  };
})();
