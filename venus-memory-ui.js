/* Venus Hub — Memory Review modal (venus-memory-ui.js) · VPIS Phase 1B-iii
   Classic <script>, loaded AFTER venus-memory.js. Exposes window.VenusMemoryUI { open, close, toggle, refresh }.

   • One <dialog> (top layer, so no z-index fights) with 3 tabs: Hồ sơ (profile) · Quyết định (decisions) · Nhật ký (audit_logs, read-only).
   • Entry points: a small icon button inserted into the existing top-right icon cluster (.dark-mode-container, next to the Facts button) and Alt+M.
     No floating button at the bottom of the screen (that area already holds the Sleep bar, Daily Plan button and toasts).
   • Every write is a click by the user: it calls VenusMemory's UI methods with {approvedByUser:true} and the expected_revision of the record being shown;
     they are recorded in audit_logs as "ui:*". On revision_conflict nothing is written and the list reloads.
   • All text (including AI-proposed memory) is rendered with textContent only — never innerHTML — so stored content cannot inject markup.
   • skConfirm / showNotification live OUTSIDE the top layer and would be hidden behind the dialog, so this modal has its own inline message and two-step delete.
   • Styles: one <style id="vpis-style"> injected from here; every class is prefixed vpis-. No localStorage, no new database. */
(function () {
  'use strict';
  if (window.VenusMemoryUI) return;

  const VM = () => window.VenusMemory;
  const APPROVED = { approvedByUser: true };
  const CATS = { career: 'Nghề nghiệp', work_rules: 'Quy tắc làm việc', learning_style: 'Cách học', constraints: 'Ràng buộc', other: 'Khác' };
  const TYPES = { decision: 'Quyết định', lesson: 'Bài học', milestone: 'Cột mốc', procedure: 'Quy trình', review_summary: 'Tóm tắt review' };
  const DST = { proposed: 'Chờ duyệt', approved: 'Đang dùng', superseded: 'Đã thay thế' };
  const KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,59}$/;
  const STALE_REVIEW_CODES = ['revision_conflict', 'not_found', 'not_editable', 'supersede_conflict', 'bad_state', 'not_replaceable'];

  /* ───────── tiny DOM helper (text is ALWAYS a text node) ───────── */
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
    (Array.isArray(kids) ? kids : kids == null ? [] : [kids]).forEach((c) => {
      if (c == null || c === false) return;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return n;
  }

  /* Dates: shown in Vietnam time (UTC+7, like the rest of the app). Parsed by hand so the page's patched Date cannot skew them. */
  const isoMs = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(typeof s === 'string' ? s : ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null; };
  const vnIso = (s) => { const ms = isoMs(s); return ms == null ? null : new Date(ms + 7 * 3600e3).toISOString(); };
  const fmtDate = (s) => { const t = vnIso(s); return t ? t.slice(8, 10) + '/' + t.slice(5, 7) + '/' + t.slice(0, 4) : '—'; };
  const fmtDateTime = (s) => { const t = vnIso(s); return t ? t.slice(8, 10) + '/' + t.slice(5, 7) + ' ' + t.slice(11, 16) : '—'; };
  const parseTags = (s) => String(s || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  const errText = (e) => (e && e.message) || String(e);

  /* ───────── state ───────── */
  const S = { tab: 'profile', dstatus: 'proposed', form: null, msg: null, confirm: null, busy: false, loading: false, fatal: null, pickInitial: false,
    stats: null, profile: [], decisions: [], audit: [], stale: [], staleIds: new Set() };
  let dlg = null, sheet = null, msgTimer = null, confirmTimer = null;

  /* ───────── styles ───────── */
  function injectStyle() {
    if (document.getElementById('vpis-style')) return;
    const css = [
      '#vpisMemoryBtn{position:relative}',
      '#vpisMemoryBtn.vpis-has-pending::before{content:"";position:absolute;top:7px;right:7px;width:8px;height:8px;border-radius:50%;background:#e0457b;z-index:1}',
      'body.ft-clean-on #vpisMemoryBtn,body.ft-fv-on #vpisMemoryBtn,body.ft-clean-on #vpisMemoryDlg{display:none!important}',
      'html:has(dialog[open][id^="vpis"]),body:has(dialog[open][id^="vpis"]){overflow:hidden}',
      '.vpis-dlg{border:0;padding:0;background:transparent;color:var(--text-dark);width:min(720px,94vw);max-width:none;max-height:none;margin:auto;overflow:hidden;border-radius:22px;overscroll-behavior:contain}',
      '.vpis-dlg:focus,.vpis-dlg:focus-visible{outline:none}',
      '.vpis-dlg::backdrop{background:rgba(24,10,18,.58);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}',
      '.vpis-dlg[open]{animation:vpis-pop .2s cubic-bezier(.2,.8,.2,1)}',
      '@keyframes vpis-pop{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion:reduce){.vpis-dlg[open]{animation:none}}',
      '.vpis-sheet{display:flex;flex-direction:column;box-sizing:border-box;max-height:min(86vh,860px);max-height:min(86dvh,860px);background:var(--bg-white);color:var(--text-dark);border:1px solid var(--border-color);border-radius:22px;overflow:hidden;box-shadow:var(--shadow-lg,0 12px 28px rgba(0,0,0,.3)),0 24px 60px rgba(24,10,18,.28),0 0 0 1px rgba(var(--primary-rgb,209,123,150),0.06);font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color-scheme:light}',
      '.dark-mode .vpis-sheet{color-scheme:dark}',
      '.vpis-sheet>*{flex:0 0 auto;min-width:0}',
      '.vpis-sheet>.vpis-body{flex:1 1 auto;min-height:0}',
      '.vpis-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:18px 20px 12px;background:linear-gradient(180deg,rgba(var(--primary-rgb,209,123,150),0.1),transparent)}',
      '.vpis-title{flex:1 1 auto;margin:0;font-size:1.2rem;font-weight:700;letter-spacing:-.01em;line-height:1.3}',
      '.vpis-x{flex:0 0 auto;display:inline-grid;place-items:center;width:36px;height:36px;min-width:36px;min-height:36px;border:0;border-radius:50%;background:transparent;color:var(--text-muted);font-size:1.5rem;line-height:1;cursor:pointer;transition:background .15s,color .15s}',
      '.vpis-x:hover{background:rgba(var(--primary-rgb,209,123,150),0.14);color:var(--text-dark)}',
      '.vpis-head .vpis-btn{min-height:34px;padding:4px 13px;border-radius:99px;font-size:.8rem;margin-left:0!important}',
      '.vpis-body{overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:14px 20px 18px}',
      '.vpis-body::-webkit-scrollbar,.vpis-pre::-webkit-scrollbar,textarea.vpis-in::-webkit-scrollbar{width:12px;height:12px}',
      '.vpis-body::-webkit-scrollbar-track,.vpis-pre::-webkit-scrollbar-track,textarea.vpis-in::-webkit-scrollbar-track{background:transparent}',
      '.vpis-body::-webkit-scrollbar-thumb,.vpis-pre::-webkit-scrollbar-thumb,textarea.vpis-in::-webkit-scrollbar-thumb{background:rgba(var(--primary-rgb,209,123,150),0.38);border-radius:99px;border:3px solid transparent;background-clip:padding-box}',
      '.vpis-body::-webkit-scrollbar-thumb:hover,.vpis-pre::-webkit-scrollbar-thumb:hover,textarea.vpis-in::-webkit-scrollbar-thumb:hover{background:rgba(var(--primary-rgb,209,123,150),0.7);background-clip:padding-box}',
      '.vpis-body::-webkit-scrollbar-button,.vpis-pre::-webkit-scrollbar-button,textarea.vpis-in::-webkit-scrollbar-button{display:none;width:0;height:0}',
      '.vpis-body::-webkit-scrollbar-corner,.vpis-pre::-webkit-scrollbar-corner,textarea.vpis-in::-webkit-scrollbar-corner{background:transparent}',
      '@supports not selector(::-webkit-scrollbar){.vpis-body,.vpis-pre,textarea.vpis-in{scrollbar-width:thin;scrollbar-color:rgba(var(--primary-rgb,209,123,150),0.5) transparent}}',
      '.vpis-note{font-size:.82rem;color:var(--text-muted);margin:0 0 10px;white-space:pre-wrap;word-break:break-word}',
      '.vpis-warn{font-size:.82rem;margin:0 0 10px;padding:9px 12px;border-radius:12px;background:#fdf1e3;color:#8a5517;border:1px solid #e8c79a;white-space:pre-wrap;word-break:break-word}',
      '.dark-mode .vpis-warn{background:#3a2d1c;color:#e0a05f;border-color:#6b4f2a}',
      '.vpis-btn{border:1px solid var(--border-color);background:var(--bg-white);color:var(--text-dark);border-radius:12px;padding:6px 15px;font:inherit;font-size:.85rem;cursor:pointer;min-height:38px;transition:background .15s,border-color .15s,filter .15s,box-shadow .15s}',
      '.vpis-btn:hover:not(:disabled){border-color:var(--primary);background:rgba(var(--primary-rgb,209,123,150),0.1)}',
      '.vpis-btn:disabled{opacity:.5;cursor:default}',
      '.vpis-btn--pri{background:var(--primary);border-color:var(--primary);color:var(--bg-white);font-weight:700;box-shadow:0 2px 8px rgba(var(--primary-rgb,209,123,150),0.35)}',
      '.vpis-btn--pri:hover:not(:disabled){background:var(--primary);filter:brightness(1.07)}',
      '.vpis-btn--danger{border-color:#b94a5a;color:#a03647}.dark-mode .vpis-btn--danger{color:#e58898}',
      '.vpis-btn--danger:hover:not(:disabled){border-color:#b94a5a;background:rgba(185,74,90,.1)}',
      '.vpis-btn--confirm{background:#b94a5a;border-color:#b94a5a;color:#fff;font-weight:700}',
      '.vpis-btn--confirm:hover:not(:disabled){background:#b94a5a;filter:brightness(1.08)}',
      '.vpis-in{width:100%;box-sizing:border-box;border:1px solid var(--border-color);background:var(--bg-light);color:var(--text-dark);border-radius:12px;padding:9px 12px;font:inherit;font-size:16px;min-height:42px;transition:border-color .15s,box-shadow .15s}',
      'textarea.vpis-in{resize:vertical;min-height:96px}',
      '.vpis-in:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(var(--primary-rgb,209,123,150),0.22)}',
      '.vpis-sheet :focus-visible{outline:2px solid var(--primary);outline-offset:2px}',
      '.vpis-sheet input[type="checkbox"]{accent-color:var(--primary);width:16px;height:16px}',
      '.vpis-card{border:1px solid var(--border-color);border-radius:16px;padding:12px 14px;margin-bottom:10px;background:var(--bg-light);background:color-mix(in srgb,var(--primary) 4%,var(--bg-light));transition:border-color .15s}',
      '.vpis-card:hover{border-color:rgba(var(--primary-rgb,209,123,150),0.45)}',
      '.vpis-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.vpis-meta{padding:0 20px 10px;color:var(--text-muted);font-size:.8rem}',
      '.vpis-msg{margin:0 20px 8px;padding:9px 12px;border-radius:12px;font-size:.85rem;border:1px solid var(--border-color);background:var(--bg-light)}',
      '.vpis-msg--ok{border-color:#4f8a6b;color:#2f6a4b}.vpis-msg--err{border-color:#b94a5a;color:#a03647}',
      '.dark-mode .vpis-msg--ok{color:#7fc3a0}.dark-mode .vpis-msg--err{color:#e58898}',
      '.vpis-stale{margin:0 20px 8px;padding:9px 12px;border-radius:12px;font-size:.82rem;background:#fdf1e3;color:#8a5517;border:1px solid #e8c79a}',
      '.dark-mode .vpis-stale{background:#3a2d1c;color:#e0a05f;border-color:#6b4f2a}',
      '.vpis-tabs{display:flex;gap:2px;padding:0 14px;border-bottom:1px solid var(--border-color);overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch}',
      '.vpis-tabs::-webkit-scrollbar{display:none;width:0;height:0}',
      '.vpis-tabs .vpis-tab{flex:0 0 auto;position:relative;border:0;border-radius:10px 10px 0 0;background:transparent;color:var(--text-muted);padding:10px 14px 11px;font:inherit;font-size:.88rem;font-weight:600;line-height:1.2;white-space:nowrap;cursor:pointer;min-height:42px;transition:color .15s,background .15s}',
      '.vpis-tabs .vpis-tab:hover{color:var(--text-dark);background:rgba(var(--primary-rgb,209,123,150),0.08)}',
      '.vpis-tabs .vpis-tab[aria-selected="true"]{color:var(--primary-dark,var(--primary));background:transparent}',
      '.vpis-tabs .vpis-tab[aria-selected="true"]::after{content:"";position:absolute;left:10px;right:10px;bottom:-1px;height:3px;border-radius:3px 3px 0 0;background:var(--primary)}',
      '.vpis-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}',
      '.vpis-chips .vpis-tab{flex:0 0 auto;border:1px solid var(--border-color);background:var(--bg-light);color:var(--text-dark);border-radius:99px;padding:5px 13px;font:inherit;font-size:.82rem;cursor:pointer;min-height:34px;transition:background .15s,border-color .15s}',
      '.vpis-chips .vpis-tab:hover{border-color:var(--primary)}',
      '.vpis-chips .vpis-tab[aria-selected="true"]{background:rgba(var(--primary-rgb,209,123,150),0.16);border-color:var(--primary);color:var(--primary-dark,var(--text-dark));font-weight:700}',
      '.vpis-foot{display:flex;gap:8px;justify-content:flex-end;padding:12px 20px;border-top:1px solid var(--border-color);background:var(--bg-white)}',
      '.vpis-card--sup{opacity:.65}',
      '.vpis-key{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700;font-size:.9rem;word-break:break-all}',
      '.vpis-card-title{font-weight:700;margin:0}',
      '.vpis-text{margin:6px 0 0;white-space:pre-wrap;word-break:break-word}',
      '.vpis-sub{margin:4px 0 0;color:var(--text-muted);font-size:.8rem;white-space:pre-wrap;word-break:break-word}',
      '.vpis-badge{display:inline-block;padding:1px 10px;border-radius:99px;font-size:.72rem;font-weight:700;background:var(--primary-light);color:var(--text-dark);border:1px solid var(--border-color)}',
      '.vpis-badge--warn{background:#fdf1e3;color:#8a5517;border-color:#e8c79a}.dark-mode .vpis-badge--warn{background:#3a2d1c;color:#e0a05f;border-color:#6b4f2a}',
      '.vpis-tag{display:inline-block;padding:0 9px;border-radius:99px;font-size:.72rem;color:var(--text-muted);border:1px solid var(--border-color)}',
      '.vpis-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}',
      '.vpis-form{border:1.5px solid var(--primary);border-radius:16px;padding:14px 16px;margin-bottom:14px;background:var(--bg-white);box-shadow:0 0 0 4px rgba(var(--primary-rgb,209,123,150),0.1)}',
      '.vpis-form h3{margin:0 0 10px;font-size:1rem}',
      '.vpis-field{display:block;margin-bottom:10px}.vpis-field>span{display:block;font-size:.78rem;color:var(--text-muted);margin-bottom:3px;font-weight:600}',
      '.vpis-empty{color:var(--text-muted);text-align:center;padding:32px 12px;border:1px dashed var(--border-color);border-radius:16px}',
      '.vpis-audit{width:100%;border-collapse:collapse;font-size:.78rem}',
      '.vpis-audit td{padding:6px 8px;border-bottom:1px dashed var(--border-color);vertical-align:top;word-break:break-word}',
      '.vpis-audit tr:last-child td{border-bottom:0}',
      '@media (max-width:640px){.vpis-dlg{width:100vw;height:100vh;height:100dvh;margin:0;border-radius:0}.vpis-sheet{height:100%;max-height:none;border-radius:0;border:0;padding-top:env(safe-area-inset-top,0px)}.vpis-btn{min-height:44px}.vpis-head{padding:14px 16px 10px}.vpis-x{width:40px;height:40px}.vpis-body{padding-left:16px;padding-right:16px;padding-bottom:calc(16px + env(safe-area-inset-bottom,0px))}.vpis-title{order:1;flex:1 1 calc(100% - 56px)}.vpis-x{order:2}.vpis-head .vpis-btn{order:3;flex:1 1 calc(50% - 8px);min-height:40px}.vpis-tabs .vpis-tab{min-height:46px}.vpis-chips .vpis-tab{min-height:40px}.vpis-foot{padding:10px 16px calc(10px + env(safe-area-inset-bottom,0px))}.vpis-foot .vpis-btn{flex:1}.vpis-meta{padding:0 16px 10px}.vpis-msg,.vpis-stale{margin-left:16px;margin-right:16px}.vpis-tabs{padding:0 8px}}'
    ].join('\n');
    const st = document.createElement('style'); st.id = 'vpis-style'; st.textContent = css; document.head.appendChild(st);
  }

  /* ───────── messages ───────── */
  function say(text, type) {
    S.msg = text ? { text, type: type || 'info' } : null;
    paintMsg();
    clearTimeout(msgTimer);
    if (text) msgTimer = setTimeout(() => { S.msg = null; paintMsg(); }, 8000);
  }
  function paintMsg() {
    if (!sheet) return;
    const m = sheet.querySelector('.vpis-msg'); if (!m) return;
    if (!S.msg) { m.hidden = true; m.textContent = ''; return; }
    m.hidden = false; m.className = 'vpis-msg vpis-msg--' + S.msg.type; m.textContent = S.msg.text;
  }

  /* ───────── data ───────── */
  async function refresh() {
    S.loading = true; render();
    try {
      const ready = await VM().ready();
      if (!ready.ok) { S.fatal = ready.error || 'Không mở được VenusMemoryDB'; }
      else {
        S.fatal = null;
        const r = await Promise.all([VM().stats(), VM().listProfile(), VM().listDecisions(), VM().getStaleMemories(90), VM().listAudit(100)]);
        S.stats = r[0]; S.profile = r[1]; S.decisions = r[2]; S.stale = r[3]; S.audit = r[4]; S.staleIds = new Set(r[3].map((x) => x.id));
        if (S.pickInitial) {   // first view after opening: jump to what needs attention
          S.pickInitial = false;
          if (S.stats.decisions.proposed > 0) { S.tab = 'decisions'; S.dstatus = 'proposed'; }
        }
      }
    } catch (e) { S.fatal = errText(e); }
    S.loading = false; render(); updateDot();
  }

  // Runs one user-initiated write. fn must return a promise; the list is reloaded afterwards either way.
  async function act(fn, okText) {
    if (S.busy) return;
    S.busy = true;
    try { await fn(); say(okText, 'ok'); S.form = null; }
    catch (e) {
      say(errText(e), 'err');
      if (e && STALE_REVIEW_CODES.indexOf(e.code) >= 0) S.form = null;   // the record changed under us: drop the form, reload
    }
    S.busy = false; S.confirm = null; await refresh();
  }

  /* ───────── builders ───────── */
  function field(label, input) { return el('label', { class: 'vpis-field' }, [el('span', { text: label }), input]); }
  function selectOf(map, value) {
    const s = el('select', { class: 'vpis-in' });
    Object.keys(map).forEach((k) => { const o = el('option', { value: k, text: map[k] }); if (k === value) o.selected = true; s.appendChild(o); });
    return s;
  }
  const tagRow = (tags) => (tags && tags.length ? el('div', { class: 'vpis-row', style: 'margin-top:6px' }, tags.map((t) => el('span', { class: 'vpis-tag', text: '#' + t }))) : null);
  const verifiedText = (r) => (r.last_verified_at ? 'xác nhận ' + fmtDate(r.last_verified_at) : 'chưa xác nhận');

  function deleteBtn(store, rec, label) {
    const id = store + ':' + rec.id, armed = S.confirm === id;
    return el('button', {
      type: 'button', class: 'vpis-btn ' + (armed ? 'vpis-btn--confirm' : 'vpis-btn--danger'), text: armed ? 'Bấm lần nữa để xóa' : (label || 'Xóa'),
      onclick: () => {
        if (!armed) { S.confirm = id; clearTimeout(confirmTimer); confirmTimer = setTimeout(() => { S.confirm = null; render(); }, 4000); render(); return; }
        clearTimeout(confirmTimer);
        act(() => VM().remove(store, rec.id, rec.revision, APPROVED), 'Đã xóa (xóa mềm, vẫn nằm trong nhật ký và backup).');
      }
    });
  }
  function verifyBtn(store, rec) {
    return el('button', { type: 'button', class: 'vpis-btn', text: 'Còn đúng', title: 'Xác nhận mục này vẫn đúng', onclick: () => act(() => VM().markVerified(store, rec.id, rec.revision, APPROVED), 'Đã đánh dấu còn đúng.') });
  }

  /* ----- profile ----- */
  function profileCard(r) {
    const stale = S.staleIds.has(r.id);
    return el('div', { class: 'vpis-card' }, [
      el('div', { class: 'vpis-row' }, [el('span', { class: 'vpis-key', text: r.key }), el('span', { class: 'vpis-badge', text: CATS[r.category] || r.category }), stale ? el('span', { class: 'vpis-badge vpis-badge--warn', text: 'Cần xác nhận' }) : null]),
      el('p', { class: 'vpis-text', text: r.content }),
      tagRow(r.tags),
      el('p', { class: 'vpis-sub', text: 'revision ' + r.revision + ' · ' + verifiedText(r) + ' · sửa ' + fmtDateTime(r.updated_at) }),
      el('div', { class: 'vpis-actions' }, [
        el('button', { type: 'button', class: 'vpis-btn', text: 'Sửa', onclick: () => { S.form = { kind: 'profile', rec: r }; S.focusForm = true; render(); } }),
        verifyBtn('profile', r), deleteBtn('profile', r)
      ])
    ]);
  }
  function profileForm(rec) {
    const key = el('input', { class: 'vpis-in', type: 'text', maxlength: 60, value: rec ? rec.key : '', placeholder: 'vd: career_direction', readonly: !!rec, autocapitalize: 'none', autocomplete: 'off' });
    const cat = selectOf(CATS, rec ? rec.category : 'career');
    const content = el('textarea', { class: 'vpis-in', maxlength: 4000, rows: 5, placeholder: 'Thông tin nền ổn định về bạn (định hướng, quy tắc làm việc, ràng buộc…)' }); content.value = rec ? rec.content : '';
    const tags = el('input', { class: 'vpis-in', type: 'text', value: rec ? rec.tags.join(', ') : '', placeholder: 'ngăn cách bằng dấu phẩy' });
    return el('div', { class: 'vpis-form' }, [
      el('h3', { text: rec ? 'Sửa mục hồ sơ' : 'Thêm mục hồ sơ' }),
      field('Key (a-z, 0-9, _ . -; không đổi được sau khi tạo)', key), field('Nhóm', cat), field('Nội dung', content), field('Thẻ', tags),
      el('div', { class: 'vpis-actions' }, [
        el('button', { type: 'button', class: 'vpis-btn vpis-btn--pri', text: 'Lưu', disabled: S.busy, onclick: () => {
          const k = key.value.trim().toLowerCase(), c = content.value.trim();
          if (!KEY_RE.test(k)) return say('Key chỉ gồm a-z, 0-9, _ . - (tối đa 60 ký tự, bắt đầu bằng chữ hoặc số).', 'err');
          if (!c) return say('Nội dung không được rỗng.', 'err');
          if (!rec && S.profile.some((p) => p.key === k)) return say('Key "' + k + '" đã tồn tại — hãy sửa mục đó thay vì tạo mới.', 'err');
          act(() => VM().saveProfileItem({ key: k, category: cat.value, content: c, tags: parseTags(tags.value) }, rec ? rec.revision : 0, APPROVED), rec ? 'Đã cập nhật mục hồ sơ.' : 'Đã thêm mục hồ sơ.');
        } }),
        el('button', { type: 'button', class: 'vpis-btn', text: 'Hủy', onclick: () => { S.form = null; render(); } })
      ])
    ]);
  }

  /* ----- decisions ----- */
  const titleOf = (id) => { const d = S.decisions.find((x) => x.id === id); return d ? d.title : null; };
  function decisionCard(r) {
    const stale = r.status === 'approved' && S.staleIds.has(r.id), acts = [];
    if (r.status === 'proposed') {
      acts.push(el('button', { type: 'button', class: 'vpis-btn vpis-btn--pri', text: 'Duyệt', disabled: S.busy, onclick: () => act(() => VM().approve(r.id, r.revision, APPROVED), 'Đã duyệt: mục này đang có hiệu lực.') }));
      acts.push(el('button', { type: 'button', class: 'vpis-btn', text: 'Sửa', onclick: () => { S.form = { kind: 'decision', mode: 'edit', rec: r }; S.focusForm = true; render(); } }));
      acts.push(deleteBtn('decisions', r, 'Bỏ đề xuất'));
    } else if (r.status === 'approved') {
      acts.push(el('button', { type: 'button', class: 'vpis-btn', text: 'Sửa', onclick: () => { S.form = { kind: 'decision', mode: 'replace', rec: r }; S.focusForm = true; render(); } }));
      acts.push(verifyBtn('decisions', r)); acts.push(deleteBtn('decisions', r));
    }
    const replaces = r.supersedes_id ? titleOf(r.supersedes_id) : null;
    return el('div', { class: 'vpis-card' + (r.status === 'superseded' ? ' vpis-card--sup' : '') }, [
      el('div', { class: 'vpis-row' }, [el('span', { class: 'vpis-badge', text: TYPES[r.type] || r.type }), el('span', { class: 'vpis-badge', text: DST[r.status] || r.status }), stale ? el('span', { class: 'vpis-badge vpis-badge--warn', text: 'Cần xác nhận' }) : null]),
      el('p', { class: 'vpis-card-title', style: 'margin-top:6px', text: r.title }),
      el('p', { class: 'vpis-text', text: r.content }),
      r.rationale ? el('p', { class: 'vpis-sub', text: 'Lý do: ' + r.rationale }) : null,
      replaces ? el('p', { class: 'vpis-sub', text: 'Thay thế: ' + replaces }) : null,
      tagRow(r.tags),
      el('p', { class: 'vpis-sub', text: 'tin cậy ' + Math.round((r.confidence || 0) * 100) + '%' + (r.source ? ' · nguồn ' + r.source : '') + ' · revision ' + r.revision + ' · ' + verifiedText(r) }),
      acts.length ? el('div', { class: 'vpis-actions' }, acts) : null
    ]);
  }
  function decisionForm(f) {
    const rec = f.rec, mode = f.mode || 'new';
    const type = selectOf(TYPES, rec ? rec.type : 'decision');
    const title = el('input', { class: 'vpis-in', type: 'text', maxlength: 200, value: rec ? rec.title : '' });
    const content = el('textarea', { class: 'vpis-in', maxlength: 4000, rows: 5 }); content.value = rec ? rec.content : '';
    const rationale = el('textarea', { class: 'vpis-in', maxlength: 2000, rows: 3, style: 'min-height:64px' }); rationale.value = rec ? rec.rationale || '' : '';
    const conf = el('input', { class: 'vpis-in', type: 'number', min: 0, max: 100, step: 5, value: rec ? Math.round((rec.confidence || 0) * 100) : 70, inputmode: 'numeric' });
    const tags = el('input', { class: 'vpis-in', type: 'text', value: rec ? rec.tags.join(', ') : '', placeholder: 'ngăn cách bằng dấu phẩy' });
    const heading = mode === 'new' ? 'Thêm quyết định / bài học' : mode === 'edit' ? 'Sửa đề xuất (chưa duyệt)' : 'Sửa mục đang dùng';
    return el('div', { class: 'vpis-form' }, [
      el('h3', { text: heading }),
      mode === 'replace' ? el('p', { class: 'vpis-note', text: 'Lưu sẽ tạo phiên bản mới (đang dùng) và chuyển bản cũ sang "Đã thay thế" — lịch sử được giữ.' }) : null,
      mode === 'new' ? el('p', { class: 'vpis-note', text: 'Mục thêm tay được lưu thẳng ở trạng thái "Đang dùng".' }) : null,
      field('Loại', type), field('Tiêu đề', title), field('Nội dung', content), field('Lý do (tuỳ chọn)', rationale), field('Độ tin cậy (%)', conf), field('Thẻ', tags),
      el('div', { class: 'vpis-actions' }, [
        el('button', { type: 'button', class: 'vpis-btn vpis-btn--pri', text: 'Lưu', disabled: S.busy, onclick: () => {
          const t = title.value.trim(), c = content.value.trim();
          if (!t) return say('Tiêu đề không được rỗng.', 'err');
          if (!c) return say('Nội dung không được rỗng.', 'err');
          const n = Number(conf.value), confidence = isFinite(n) ? Math.max(0, Math.min(100, n)) / 100 : 0.7;
          const base = { type: type.value, title: t, content: c, rationale: rationale.value.trim(), source: rec ? rec.source || '' : 'manual', confidence, tags: parseTags(tags.value) };
          if (mode === 'edit') act(() => VM().saveDecisionItem(Object.assign({ id: rec.id, status: 'proposed' }, base), rec.revision, APPROVED), 'Đã cập nhật đề xuất.');
          else if (mode === 'replace') act(() => VM().saveDecisionItem(Object.assign({ supersedes_id: rec.id, status: 'approved' }, base), rec.revision, APPROVED), 'Đã lưu phiên bản mới; bản cũ chuyển sang "Đã thay thế".');
          else act(() => VM().saveDecisionItem(Object.assign({ status: 'approved' }, base), 0, APPROVED), 'Đã thêm mục.');
        } }),
        el('button', { type: 'button', class: 'vpis-btn', text: 'Hủy', onclick: () => { S.form = null; render(); } })
      ])
    ]);
  }

  /* ----- audit ----- */
  function auditView() {
    if (!S.audit.length) return el('div', { class: 'vpis-empty', text: 'Chưa có bản ghi nào.' });
    const rows = S.audit.map((a) => el('tr', null, [
      el('td', { text: fmtDateTime(a.ts) }),
      el('td', { text: a.tool_name || '' }),
      el('td', { text: (a.status || '') + (a.approved_by_user ? '' : ' · chưa duyệt') }),
      el('td', { text: a.target_id ? String(a.target_id).slice(0, 8) : '' })
    ]));
    return el('div', null, [
      el('p', { class: 'vpis-note', text: 'Giờ Việt Nam. 100 bản ghi gần nhất; chỉ lưu tên thao tác, trạng thái và id — không lưu nội dung.' }),
      el('div', { style: 'overflow-x:auto' }, [el('table', { class: 'vpis-audit' }, [el('tbody', null, rows)])])
    ]);
  }

  /* ───────── render ───────── */
  function chip(label, selected, onclick) { return el('button', { type: 'button', class: 'vpis-tab', role: 'tab', 'aria-selected': selected ? 'true' : 'false', text: label, onclick }); }

  function render() {
    if (!sheet) return;
    const prevBody = sheet.querySelector('.vpis-body'), scroll = prevBody ? prevBody.scrollTop : 0;
    while (sheet.firstChild) sheet.removeChild(sheet.firstChild);
    const st = S.stats, dec = S.decisions;
    const cnt = (s) => dec.filter((d) => d.status === s).length;

    const revBtn = window.VenusReview ? el('button', { id: 'vpisReviewBtn', type: 'button', class: 'vpis-btn', style: 'margin-left:auto', text: '📋 Review tháng', 'aria-haspopup': 'dialog', onclick: () => window.VenusReview.open() }) : null;
    const aiBtn = el('button', { id: 'vpisAiBtn', type: 'button', class: 'vpis-btn', style: revBtn ? 'margin-left:6px' : 'margin-left:auto', text: '⚙ AI', title: 'Cài đặt AI (profile, model, thinking)', onclick: openAiSettings });
    const accBtn = window.VenusAccount ? el('button', { id: 'vpisAccountBtn', type: 'button', class: 'vpis-btn', style: 'margin-left:6px', text: (window.VenusAccount.status && window.VenusAccount.status().signedIn) ? '☁ Tài khoản ✓' : '☁ Tài khoản', 'aria-haspopup': 'dialog', onclick: () => window.VenusAccount.open() }) : null;
    sheet.appendChild(el('div', { class: 'vpis-head' }, [el('h2', { class: 'vpis-title', id: 'vpisTitle', text: 'Bộ nhớ Venus' }), revBtn, aiBtn, accBtn, el('button', { type: 'button', class: 'vpis-x', 'aria-label': 'Đóng', text: '×', onclick: close })]));
    sheet.appendChild(el('div', { class: 'vpis-meta', text: st ? 'Hồ sơ ' + S.profile.length + ' · đang dùng ' + cnt('approved') + ' · chờ duyệt ' + cnt('proposed') + ' · chờ đồng bộ ' + st.outbox_pending + (st.device_id ? ' · thiết bị ' + String(st.device_id).slice(0, 6) : '') : (S.loading ? 'Đang tải…' : '') }));
    const m = el('div', { class: 'vpis-msg', role: 'status', 'aria-live': 'polite', hidden: true }); sheet.appendChild(m);
    if (S.stale.length) sheet.appendChild(el('div', { class: 'vpis-stale', text: S.stale.length + ' mục đang dùng đã hơn 90 ngày chưa được xác nhận. Nếu vẫn đúng, bấm "Còn đúng" trên mục đó.' }));

    sheet.appendChild(el('div', { class: 'vpis-tabs', role: 'tablist' }, [
      chip('Hồ sơ (' + S.profile.length + ')', S.tab === 'profile', () => { S.tab = 'profile'; S.form = null; render(); }),
      chip('Quyết định (' + (cnt('approved') + cnt('proposed')) + ')' + (cnt('proposed') ? ' •' : ''), S.tab === 'decisions', () => { S.tab = 'decisions'; S.form = null; render(); }),
      chip('Nhật ký', S.tab === 'audit', () => { S.tab = 'audit'; S.form = null; render(); })
    ]));

    const body = el('div', { class: 'vpis-body' });
    if (S.fatal) body.appendChild(el('div', { class: 'vpis-empty', text: 'Không mở được bộ nhớ: ' + S.fatal + '. Thử tải lại trang (nếu đang mở app ở nhiều tab, hãy đóng bớt).' }));
    else if (S.loading && !st) body.appendChild(el('div', { class: 'vpis-empty', text: 'Đang tải…' }));
    else if (S.tab === 'profile') {
      if (S.form && S.form.kind === 'profile') body.appendChild(profileForm(S.form.rec));
      if (!S.profile.length && !S.form) body.appendChild(el('div', { class: 'vpis-empty', text: 'Chưa có mục hồ sơ nào. Bấm "+ Thêm mục hồ sơ" để thêm định hướng, quy tắc làm việc hoặc ràng buộc cá nhân.' }));
      S.profile.forEach((r) => body.appendChild(profileCard(r)));
    } else if (S.tab === 'decisions') {
      body.appendChild(el('div', { class: 'vpis-chips', role: 'tablist' }, ['proposed', 'approved', 'superseded'].map((s) => chip(DST[s] + ' (' + cnt(s) + ')', S.dstatus === s, () => { S.dstatus = s; S.form = null; render(); }))));
      if (S.form && S.form.kind === 'decision') body.appendChild(decisionForm(S.form));
      const list = dec.filter((d) => d.status === S.dstatus);
      if (!list.length && !S.form) body.appendChild(el('div', { class: 'vpis-empty', text: S.dstatus === 'proposed' ? 'Không có đề xuất nào đang chờ duyệt.' : 'Chưa có mục nào.' }));
      list.forEach((r) => body.appendChild(decisionCard(r)));
    } else body.appendChild(auditView());
    sheet.appendChild(body);

    const foot = el('div', { class: 'vpis-foot' });
    if (S.tab === 'profile' && !S.fatal) foot.appendChild(el('button', { type: 'button', class: 'vpis-btn vpis-btn--pri', text: '+ Thêm mục hồ sơ', onclick: () => { S.form = { kind: 'profile', rec: null }; S.focusForm = true; render(); } }));
    if (S.tab === 'decisions' && !S.fatal) foot.appendChild(el('button', { type: 'button', class: 'vpis-btn vpis-btn--pri', text: '+ Thêm quyết định', onclick: () => { S.form = { kind: 'decision', mode: 'new', rec: null }; S.focusForm = true; render(); } }));
    foot.appendChild(el('button', { type: 'button', class: 'vpis-btn', text: 'Tải lại', onclick: refresh }));
    sheet.appendChild(foot);

    paintMsg();
    body.scrollTop = scroll;
    if (S.focusForm) { S.focusForm = false; const f = body.querySelector('.vpis-form'); if (f) { try { f.scrollIntoView({ block: 'nearest' }); const i = f.querySelector('input:not([readonly]),textarea'); if (i) i.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } }
  }

  /* ───────── "⚙ AI" button: opens the AI settings (ai.js is loaded on demand, like venus-review.js / ai-hub.js do) ───────── */
  let aiLoading = null;
  function loadAi() {
    if (window.VenusAI) return Promise.resolve(window.VenusAI);
    if (!aiLoading) aiLoading = new Promise((res, rej) => {
      const t = setTimeout(() => { aiLoading = null; rej(new Error('timeout')); }, 10000);
      const sc = document.createElement('script'); sc.src = './ai.js';
      sc.onload = () => { clearTimeout(t); if (window.VenusAI) res(window.VenusAI); else { aiLoading = null; rej(new Error('missing')); } };
      sc.onerror = () => { clearTimeout(t); aiLoading = null; rej(new Error('not_found')); };
      document.head.appendChild(sc);
    });
    return aiLoading;
  }
  async function openAiSettings() {
    const btn = () => document.getElementById('vpisAiBtn');
    try {
      if (!window.VenusAI) { if (btn()) btn().disabled = true; say('Đang tải ai.js…', 'info'); await loadAi(); say(null); }
      window.VenusAI.openSettings();   // a <dialog> in the top layer, so it shows above this modal
    } catch (e) {
      say('Không tải được ai.js (kiểm tra file ai.js nằm cạnh index.html và kết nối mạng).', 'err');
    }
    if (btn()) btn().disabled = false;
  }

  /* ───────── open / close ───────── */
  function build() {
    injectStyle();
    dlg = el('dialog', { id: 'vpisMemoryDlg', class: 'vpis-dlg', 'aria-labelledby': 'vpisTitle' });
    sheet = el('div', { class: 'vpis-sheet' });
    dlg.appendChild(sheet);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    dlg.addEventListener('close', () => { S.form = null; S.confirm = null; });
    document.body.appendChild(dlg);
  }
  function isOpen() { return !!(dlg && dlg.open); }
  function open() {
    if (!VM()) { alert('venus-memory.js chưa tải (kiểm tra file nằm cạnh index.html).'); return; }
    if (!dlg) build();
    if (!dlg.open) { try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); } }
    S.pickInitial = true; S.form = null; S.confirm = null; S.msg = null;
    refresh();
  }
  function close() { if (dlg && dlg.open) { try { dlg.close(); } catch (e) { dlg.removeAttribute('open'); } } }
  function toggle() { if (isOpen()) close(); else open(); }

  /* ───────── entry points ───────── */
  function updateDot() {
    const b = document.getElementById('vpisMemoryBtn'); if (!b || !VM()) return;
    Promise.resolve(S.stats || VM().stats()).then((st) => {
      const n = st && st.decisions ? st.decisions.proposed : 0;
      b.classList.toggle('vpis-has-pending', n > 0);
      b.title = 'Bộ nhớ Venus (Alt+M)' + (n > 0 ? ' — ' + n + ' đề xuất chờ duyệt' : '');
    }).catch(() => {});
  }
  function addButton() {
    if (document.getElementById('vpisMemoryBtn')) return;
    injectStyle();
    const anchor = document.getElementById('insightQuickBtn'), box = document.querySelector('.dark-mode-container');
    if (!anchor && !box) return;   // header cluster not found: Alt+M still works
    const b = el('button', { id: 'vpisMemoryBtn', type: 'button', class: 'dark-mode-toggle fab-icon-btn', title: 'Bộ nhớ Venus (Alt+M)', 'aria-label': 'Bộ nhớ Venus', 'aria-haspopup': 'dialog', onclick: toggle }, [el('i', { class: 'fa-solid fa-brain', 'aria-hidden': 'true' })]);
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(b, anchor.nextSibling); else box.appendChild(b);
  }
  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.code === 'KeyM' || e.key === 'm' || e.key === 'M')) { e.preventDefault(); toggle(); }
  });

  window.VenusMemoryUI = { version: 1, open, close, toggle, refresh, isOpen };
  const init = () => { addButton(); setTimeout(updateDot, 3000); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
