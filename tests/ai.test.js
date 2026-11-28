/* Tests for ai.js (multi-profile) + the ⚙ AI button in venus-memory-ui.js.  Run: node ai.test.js   (needs: npm i jsdom fake-indexeddb) */
'use strict';
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const ROOT = process.env.VENUS_ROOT || path.join(__dirname, '..');
const AI = fs.readFileSync(path.join(ROOT, 'ai.js'), 'utf8');
const MEMUI = fs.readFileSync(path.join(ROOT, 'venus-memory-ui.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + '  got ' + JSON.stringify(a) + '  want ' + JSON.stringify(b));
const T = (n) => console.log('• ' + n);
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 15));
const until = async (f, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 3000)) { const v = f(); if (v) return v; await tick(10); } return f(); };
function idb(win, fn) {
  return new Promise((res, rej) => {
    const r = win.indexedDB.open('venus-ai', 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
    r.onsuccess = () => { const db = r.result; Promise.resolve(fn(db)).then((v) => { db.close(); res(v); }, rej); };
    r.onerror = () => rej(r.error);
  });
}
const kvGet = (win, k) => idb(win, (db) => new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); }));
const kvPut = (win, k, v) => idb(win, (db) => new Promise((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(); }));
function sse(text) { return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: [DONE]\n\n')); c.close(); } }), { status: 200 }); }
const jerr = (status, msg) => new Response(JSON.stringify({ error: { message: msg } }), { status });
async function boot(seed, handler, extraScripts) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://venus.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.indexedDB = new IDBFactory(); w.IDBKeyRange = IDBKeyRange; w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
  w.marked = { parse: (t) => '<p>' + String(t).replace(/</g, '&lt;') + '</p>' }; w.DOMPurify = { sanitize: (h) => h };   // jsdom does not load CDN scripts
  w.calls = [];
  w.fetch = async (url, init) => { const body = init && init.body ? JSON.parse(init.body) : null; w.calls.push({ url, headers: init && init.headers, body }); return (handler || (() => sse('OK')))(url, init, body, w.calls.length); };
  if (seed) for (const k of Object.keys(seed)) await kvPut(w, k, seed[k]);
  (extraScripts || []).forEach((s) => w.eval(s));
  w.eval(AI);
  return w;
}
const MSG = [{ role: 'user', content: 'hi' }];
const prof = (o) => Object.assign({ id: 'p', name: 'P', requestFormat: 'openai', baseUrl: 'https://api.example.com/v1/chat/completions', apiKey: 'k', model: 'm', fallbackModels: '', thinkingEffort: 'default', dailyLimit: 50, denyTraining: true, temperature: 0.4, maxTokens: 0, replyLang: 'tiếng Việt', maxChars: 30000, customPrompt: '' }, o);
const cfgOf = (profiles, active, fb) => ({ schemaVersion: 2, activeProfileId: active || profiles[0].id, fallbackProfileIds: fb || [], profiles });
const today = new Date().toISOString().slice(0, 10);

(async () => {
  /* ───────── 1. migration ───────── */
  T('migrate old schema → v2');
  const legacy = {
    provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-main', model: 'baidu/ernie-5.5-flash-preview:free', fallbackModels: 'a/b:free\nc/d:free', dailyLimit: 50, denyTraining: true, replyLang: 'tiếng Việt', maxChars: 25000, temperature: 0.3,
    instructions: 'Hướng dẫn riêng của tôi',
    backups: [{ provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk-1', model: 'llama-3.3-70b' }, { provider: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: '' }]
  };
  let w = await boot({ settings: legacy, usage: { day: today, n: 7, by: { 'baidu/ernie-5.5-flash-preview:free': 7 } } });
  let s = await w.VenusAI.getSettings();
  eq(s.schemaVersion, 2, 'schemaVersion 2');
  eq(s.profiles.length, 2, 'backup without model/key (ollama empty) is not migrated');
  eq(s.activeProfileId, 'prof_1', 'active = prof_1');
  eq(s.fallbackProfileIds, ['prof_2'], 'fallback ids');
  eq(s.profiles[0].baseUrl, 'https://openrouter.ai/api/v1/chat/completions', 'main URL → full chat URL');
  eq(s.profiles[0].requestFormat, 'openrouter', 'openrouter host → openrouter format');
  eq(s.profiles[1].requestFormat, 'openai', 'groq → openai format');
  eq(s.profiles[1].baseUrl, 'https://api.groq.com/openai/v1/chat/completions', 'groq URL');
  eq([s.apiKey, s.model, s.maxChars, s.temperature, s.provider], ['sk-main', 'baidu/ernie-5.5-flash-preview:free', 25000, 0.3, 'openrouter'], 'flat fields of the active profile');
  eq(s.fallbackModels, 'a/b:free\nc/d:free', 'fallbackModels kept');
  eq(s.profiles[0].customPrompt, 'Hướng dẫn riêng của tôi', 'custom instructions → customPrompt (main)');
  eq(s.profiles[1].customPrompt, 'Hướng dẫn riêng của tôi', 'backup inherits instructions');
  eq(s.profiles[1].maxChars, 25000, 'backup inherits maxChars');
  eq(s.instructions, 'Hướng dẫn riêng của tôi', 'flat instructions');
  eq(s.profiles[1].fallbackModels, '', 'backup has no fallbackModels');
  let u = await w.VenusAI.getUsage();
  eq([u.n, u.by['baidu/ernie-5.5-flash-preview:free']], [7, 7], "today's usage → active profile #1");
  eq((await w.VenusAI.getUsage('prof_2')).n, 0, 'prof_2 starts at 0');
  const stored = await kvGet(w, 'settings');
  eq(stored.schemaVersion, 2, 'v2 persisted to IndexedDB');
  ok(!('backups' in stored) && !('provider' in stored), 'old flat fields are not stored any more');
  ok((await kvGet(w, 'usage')).profiles, 'usage persisted in v2 shape');
  ok(!JSON.stringify(Object.keys(w.localStorage)).includes('sk-'), 'nothing in localStorage');

  T('migrate: old default instructions → empty customPrompt; old usage from a past day dropped; fresh install');
  w = await boot({ settings: Object.assign({}, legacy, { instructions: 'Mình đang xây kiến thức về tài chính, đầu tư và tích hợp AI. Hãy trả lời có cấu trúc và đi sâu thay vì tóm tắt hời hợt: khái niệm nền tảng, ứng dụng thực tế, ví dụ, rủi ro/giới hạn, bước tiếp theo. Chính xác, không khen thừa; nếu dữ liệu không đủ để kết luận thì nói rõ thay vì đoán.' }), usage: { day: '2000-01-01', n: 9, by: {} } });
  s = await w.VenusAI.getSettings();
  eq(s.profiles[0].customPrompt, '', 'default instructions → ""');
  ok(s.instructions.length > 50, 'flat instructions falls back to the default text');
  eq((await w.VenusAI.getUsage()).n, 0, 'past-day usage dropped');
  w = await boot();
  s = await w.VenusAI.getSettings();
  eq([s.profiles.length, s.activeProfileId, s.model, s.provider, s.thinkingEffort], [1, 'prof_1', '', 'openrouter', 'default'], 'fresh install: one empty OpenRouter profile');
  eq(await w.VenusAI.isConfigured(), false, 'fresh install is not configured');
  eq(await kvGet(w, 'settings'), undefined, 'fresh install writes nothing until you save');

  T('v2 data read as-is (no re-migration)');
  const v2 = cfgOf([prof({ id: 'a', name: 'A', model: 'ma' }), prof({ id: 'b', name: 'B', model: 'mb', apiKey: 'kb' })], 'b', ['a']);
  w = await boot({ settings: v2, usage: { day: today, profiles: { a: { n: 3, by: { ma: 3 } } } } });
  s = await w.VenusAI.getSettings();
  eq([s.activeProfileId, s.model, s.apiKey, s.fallbackProfileIds], ['b', 'mb', 'kb', ['a']], 'active profile b is the flat view');
  eq((await w.VenusAI.getUsage('a')).n, 3, 'usage of a');
  eq((await w.VenusAI.getUsage()).n, 0, 'usage of active b = 0');
  eq(s.backups.map((b) => b.model), ['ma'], 'compat: backups[] derived from fallback profiles');

  /* ───────── 2. URLs ───────── */
  T('resolveChatUrl / resolveModelsUrl');
  const V = w.VenusAI;
  eq(V.resolveChatUrl('https://x.io/v1'), 'https://x.io/v1/chat/completions', 'adds /chat/completions');
  eq(V.resolveChatUrl('https://x.io/v1/'), 'https://x.io/v1/chat/completions', 'trailing slash');
  eq(V.resolveChatUrl('https://x.io/v1/chat/completions/'), 'https://x.io/v1/chat/completions', 'already full');
  eq(V.resolveChatUrl(''), '', 'empty');
  eq(V.resolveModelsUrl('https://x.io/v1/chat/completions'), 'https://x.io/v1/models', 'models from full URL');
  eq(V.resolveModelsUrl('https://x.io/v1'), 'https://x.io/v1/models', 'models from base');

  /* ───────── 3. request format × thinking ───────── */
  T('buildRequest: format × thinking (seen through fetch)');
  const send = async (p, opts) => { const ww = await boot({ settings: cfgOf([p]) }); await ww.VenusAI.chat(Object.assign({ messages: MSG }, opts || {})); return ww.calls[0]; };
  let r = await send(prof({ requestFormat: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'o/m:free', temperature: 0.4 }));
  eq(r.url, 'https://openrouter.ai/api/v1/chat/completions', 'OpenRouter URL from a bare base');
  eq(r.body.provider, { data_collection: 'deny' }, 'openrouter: data_collection deny');
  eq([r.body.temperature, 'reasoning' in r.body, 'reasoning_effort' in r.body, 'max_tokens' in r.body, r.body.stream], [0.4, false, false, false, true], 'openrouter default thinking: temperature only');
  eq([r.headers.Authorization, r.headers['X-Title'], r.headers['HTTP-Referer']], ['Bearer k', 'Venus Hub', 'https://venus.test'], 'openrouter headers');
  r = await send(prof({ requestFormat: 'openrouter', denyTraining: false, thinkingEffort: 'high', temperature: 0.7, maxTokens: 500 }));
  eq(r.body.reasoning, { effort: 'high' }, 'openrouter high → reasoning.effort');
  ok(!('temperature' in r.body) && !('max_tokens' in r.body), 'thinking on → no temperature / max_tokens');
  eq(r.body.provider, { data_collection: 'allow' }, 'denyTraining false → allow');
  r = await send(prof({ requestFormat: 'openrouter', thinkingEffort: 'off', temperature: 0.2, maxTokens: 800 }));
  eq([r.body.reasoning, r.body.temperature, r.body.max_tokens], [{ effort: 'none' }, 0.2, 800], 'openrouter off → effort none, temperature + max_tokens sent');
  r = await send(prof({ requestFormat: 'openai', thinkingEffort: 'medium', temperature: 0.9 }));
  eq([r.body.reasoning_effort, 'reasoning' in r.body, 'provider' in r.body, 'temperature' in r.body], ['medium', false, false, false], 'openai medium → reasoning_effort only');
  ok(!('X-Title' in r.headers), 'openai format has no X-Title');
  r = await send(prof({ requestFormat: 'openai', thinkingEffort: 'off', maxTokens: 300 }));
  eq([r.body.reasoning_effort, r.body.max_tokens, r.body.temperature], ['none', 300, 0.4], 'openai off → reasoning_effort none');
  r = await send(prof({ requestFormat: 'openai', thinkingEffort: 'default' }));
  ok(!('reasoning_effort' in r.body) && !('max_tokens' in r.body), 'openai default: nothing about reasoning, maxTokens 0 not sent');
  r = await send(prof({ requestFormat: 'openai', thinkingEffort: 'xhigh' }));
  eq(r.body.reasoning_effort, 'xhigh', 'xhigh passed through');
  r = await send(prof({ requestFormat: 'openai', thinkingEffort: 'max' }));
  eq(r.body.reasoning_effort, 'max', 'max passed through');
  r = await send(prof({ requestFormat: 'openai', temperature: 0.4 }), { temperature: 0.3 });
  eq(r.body.temperature, 0.3, 'caller temperature (venus-review) overrides the profile');
  r = await send(prof({ requestFormat: 'openai', thinkingEffort: 'low', temperature: 0.4 }), { temperature: 0.3 });
  ok(!('temperature' in r.body), 'caller temperature is dropped while thinking is on');
  r = await send(prof({ apiKey: '', baseUrl: 'http://localhost:11434/v1', model: 'llama3' }));
  eq([r.url, 'Authorization' in r.headers], ['http://localhost:11434/v1/chat/completions', false], 'Ollama: no key, no Authorization');

  /* ───────── 4. chat: counters, switching, 429 → fallback profile ───────── */
  T('chat: per-profile counters, active switch, 429 daily → fallback profile');
  const A1 = prof({ id: 'a', name: 'A', baseUrl: 'https://api.a.test/v1/chat/completions', model: 'ma', dailyLimit: 5 }), B1 = prof({ id: 'b', name: 'B', baseUrl: 'https://api.b.test/v1/chat/completions', model: 'mb', apiKey: 'kb', dailyLimit: 9 });
  w = await boot({ settings: cfgOf([A1, B1], 'a', ['b']) });
  await w.VenusAI.chat({ messages: MSG }); await w.VenusAI.chat({ messages: MSG });
  eq([(await w.VenusAI.getUsage('a')).n, (await w.VenusAI.getUsage('b')).n], [2, 0], 'two calls counted on a only');
  await w.VenusAI.setActiveProfile('b'); await w.VenusAI.chat({ messages: MSG });
  eq([w.calls[2].url, (await w.VenusAI.getUsage('a')).n, (await w.VenusAI.getUsage('b')).n], ['https://api.b.test/v1/chat/completions', 2, 1], 'active switched: b is called and counted');
  eq((await w.VenusAI.getSettings()).fallbackProfileIds, [], 'the new active profile is removed from the fallback list');
  w = await boot({ settings: cfgOf([A1, B1], 'a', ['b']) }, (url) => url.includes('api.a.test') ? jerr(429, 'Rate limit exceeded: free-models-per-day') : sse('from B'));
  let moved = null;
  const out = await w.VenusAI.chat({ messages: MSG, onFallback: (f) => { moved = f; } });
  eq(out, 'from B', 'daily limit on A → B answers');
  eq([w.calls.map((c) => hostOfUrl(c.url))], [['api.a.test', 'api.b.test']], 'A tried once, then B');
  eq([(await w.VenusAI.getUsage('a')).n, (await w.VenusAI.getUsage('b')).n], [5, 1], 'A counter synced to its limit (5), B counted 1');
  ok(moved && /B · mb/.test(moved.to), 'onFallback names the fallback profile');
  function hostOfUrl(u) { return new URL(u).host; }

  T('chat: noFallback / profileId / validation / same-profile model fallback');
  w = await boot({ settings: cfgOf([A1, B1], 'a', ['b']) }, () => jerr(500, 'boom'));
  let err = await w.VenusAI.chat({ messages: MSG, noFallback: true }).catch((e) => e);
  eq([err.code, w.calls.length], ['server', 1], 'noFallback: one request only');
  w = await boot({ settings: cfgOf([A1, B1], 'a', ['b']) });
  await w.VenusAI.chat({ messages: MSG, profileId: 'b', noFallback: true });
  eq([hostOfUrl(w.calls[0].url), (await w.VenusAI.getUsage('b')).n, (await w.VenusAI.getUsage('a')).n], ['api.b.test', 1, 0], 'profileId pins the profile (even a non-active one)');
  err = await w.VenusAI.chat({ messages: MSG, profileId: 'zzz' }).catch((e) => e);
  eq(err.code, 'noprofile', 'unknown profileId');
  w = await boot({ settings: cfgOf([prof({ model: '' })]) });
  err = await w.VenusAI.chat({ messages: MSG }).catch((e) => e); eq(err.code, 'nomodel', 'no model');
  w = await boot({ settings: cfgOf([prof({ apiKey: '', baseUrl: 'https://openrouter.ai/api/v1', requestFormat: 'openrouter' })]) });
  err = await w.VenusAI.chat({ messages: MSG }).catch((e) => e); eq(err.code, 'nokey', 'OpenRouter without a key');
  w = await boot({ settings: cfgOf([prof({ model: 'm1', fallbackModels: 'm2\nm3\nm4\nm5' })]) }, (url, init, body) => body.model === 'm3' ? sse('ok3') : jerr(404, 'no such model'));
  eq(await w.VenusAI.chat({ messages: MSG }), 'ok3', 'same-profile model fallback reaches m3');
  eq(w.calls.map((c) => c.body.model), ['m1', 'm2', 'm3'], 'in order');
  eq((await w.VenusAI.getUsage()).n, 3, 'each attempt counted');
  w = await boot({ settings: cfgOf([prof({ model: 'm1', fallbackModels: 'm2\nm3\nm4\nm5' })]) }, () => jerr(404, 'no such model'));
  err = await w.VenusAI.chat({ messages: MSG }).catch((e) => e);
  eq(w.calls.length, 4, 'max 3 fallback models → 4 requests');
  w = await boot({ settings: cfgOf([A1, B1], 'a', ['b']) }, () => jerr(401, 'bad key'));
  err = await w.VenusAI.chat({ messages: MSG }).catch((e) => e);
  eq([err.code, w.calls.length], ['auth', 2], 'wrong key on A → other profile tried (own key), then the error');
  w = await boot({ settings: cfgOf([A1, prof({ id: 'b', model: '', name: 'B' })], 'a', ['b']) }, () => jerr(500, 'x'));
  await w.VenusAI.chat({ messages: MSG }).catch(() => {});
  eq(w.calls.length, 1, 'a fallback profile without a model is skipped');

  T('usage reset / legacy saveSettings patch');
  w = await boot({ settings: cfgOf([A1, B1], 'a', ['b']) });
  await w.VenusAI.chat({ messages: MSG }); await w.VenusAI.chat({ messages: MSG, profileId: 'b' });
  eq((await w.VenusAI.resetUsage()).n, 0, 'resetUsage() resets the active profile');
  eq((await w.VenusAI.getUsage('b')).n, 1, 'other profile untouched');
  await w.VenusAI.resetUsage('b'); eq((await w.VenusAI.getUsage('b')).n, 0, 'resetUsage(id)');
  const sv = await w.VenusAI.saveSettings({ model: 'new-model', maxChars: 9000, instructions: 'xin chào' });
  eq([sv.persisted, sv.cfg.model, sv.cfg.maxChars, sv.cfg.instructions, sv.cfg.profiles[0].customPrompt, sv.cfg.profiles[1].model], [true, 'new-model', 9000, 'xin chào', 'xin chào', 'mb'], 'old flat patch edits the ACTIVE profile only');
  eq((await kvGet(w, 'settings')).profiles[0].model, 'new-model', 'persisted');
  await w.VenusAI.saveSettings({ maxChars: 10 }); eq((await w.VenusAI.getSettings()).maxChars, 2000, 'values are clamped');
  await w.VenusAI.saveSettings({ thinkingEffort: 'bogus', requestFormat: 'nope' }); const sv2 = await w.VenusAI.getSettings(); eq([sv2.thinkingEffort, sv2.requestFormat], ['default', 'openai'], 'invalid enums are normalised');
  await w.VenusAI.saveSettings({ profiles: [A1] }); eq((await w.VenusAI.getSettings()).fallbackProfileIds, [], 'removed profile leaves the fallback list');
  eq((await w.VenusAI.getUsage('b')).n, 0, 'removed profile usage dropped');

  /* ───────── 5. settings UI ───────── */
  const click = (w2, el) => el.dispatchEvent(new w2.MouseEvent('click', { bubbles: true, cancelable: true }));
  const setVal = (w2, el, v, type) => { if (el.type === 'checkbox') el.checked = v; else el.value = v; el.dispatchEvent(new w2.Event('input', { bubbles: true })); if (type === 'change') el.dispatchEvent(new w2.Event('change', { bubbles: true })); if (type !== 'change' && (el.tagName === 'SELECT' || el.type === 'checkbox')) el.dispatchEvent(new w2.Event('change', { bubbles: true })); };
  const F = (w2, f) => w2.document.querySelector('.vai-set [data-f="' + f + '"]');
  const A = (w2, a) => w2.document.querySelector('.vai-set [data-a="' + a + '"]');
  const cards = (w2) => [...w2.document.querySelectorAll('.vai-set .vai-pc')];

  T('settings UI: CRUD, draft/cancel, thinking, format, add /chat/completions');
  w = await boot({ settings: cfgOf([A1, B1], 'a', []) });
  let saved = 0; w.VenusAI.openSettings({ onSave: () => { saved++; } });
  ok(await until(() => cards(w).length === 2), 'two profile cards rendered');
  ok(w.document.querySelector('dialog.vai-set'), 'the settings window is a <dialog> (top layer)');
  ok(cards(w)[0].textContent.includes('Đang dùng'), 'active badge on A');
  eq(F(w, 'name').value, 'A', 'form shows the active profile');
  click(w, cards(w)[1]); await tick();
  eq(F(w, 'name').value, 'B', 'clicking a card selects it');
  ok(A(w, 'activate') && !w.document.querySelector('.vai-set .vai-ptools .vai-tag-a'), 'B shows "use this profile"');
  setVal(w, F(w, 'name'), 'B renamed');
  ok(cards(w)[1].textContent.includes('B renamed'), 'card title follows the field live');
  // cancel discards
  click(w, A(w, 'cancel')); await tick();
  ok(!w.document.querySelector('.vai-set'), 'cancel closes');
  eq((await w.VenusAI.getSettings()).profiles[1].name, 'B', 'cancel discarded the draft');
  // edit + save
  w.VenusAI.openSettings({ onSave: () => { saved++; } }); await until(() => cards(w).length === 2);
  click(w, cards(w)[1]); await tick();
  setVal(w, F(w, 'model'), 'new-b'); setVal(w, F(w, 'baseUrl'), 'https://openrouter.ai/api/v1', 'change');
  eq(F(w, 'requestFormat').value, 'openrouter', 'URL → OpenRouter switches the format');
  eq(w.document.querySelector('#vaiResolved').textContent, 'https://openrouter.ai/api/v1/chat/completions', 'resolved URL hint');
  setVal(w, F(w, 'thinkingEffort'), 'high');
  ok(F(w, 'temperature').disabled && F(w, 'maxTokens').disabled, 'thinking on → temperature / max_tokens disabled');
  setVal(w, F(w, 'thinkingEffort'), 'off');
  ok(!F(w, 'temperature').disabled, 'thinking off → enabled again');
  setVal(w, F(w, 'thinkingEffort'), 'low');
  click(w, A(w, 'activate')); await tick();
  ok(cards(w)[1].textContent.includes('Đang dùng'), 'activate moves the badge to B');
  click(w, A(w, 'save')); await until(() => saved >= 1); await tick(30);
  let st = await w.VenusAI.getSettings();
  eq([st.activeProfileId, st.model, st.requestFormat, st.thinkingEffort, st.baseUrl], ['b', 'new-b', 'openrouter', 'low', 'https://openrouter.ai/api/v1'], 'saved: active B, model, format, thinking');
  ok(w.document.querySelector('#vaiMsg').textContent.includes('Đã lưu'), '"Đã lưu" message');
  // add / duplicate / delete
  click(w, A(w, 'add')); await tick();
  eq(cards(w).length, 3, 'add profile → 3 cards');
  eq(F(w, 'model').value, '', 'new profile is empty');
  setVal(w, F(w, 'name'), 'C'); setVal(w, F(w, 'model'), 'mc'); setVal(w, F(w, 'apiKey'), 'kc');
  ok(w.document.querySelector('.vai-set [data-fbtog]'), 'fallback tick available on a non-active profile');
  setVal(w, w.document.querySelector('.vai-set [data-fbtog]'), true);
  ok(cards(w)[2].textContent.includes('Dự phòng 1'), 'C is fallback #1');
  click(w, A(w, 'dup')); await tick();
  eq([cards(w).length, F(w, 'name').value, F(w, 'model').value], [4, 'C (bản sao)', 'mc'], 'duplicate copies the settings');
  setVal(w, w.document.querySelector('.vai-set [data-fbtog]'), true);
  eq(w.document.querySelectorAll('.vai-set .vai-fbl li').length, 2, 'two entries in the fallback order');
  click(w, w.document.querySelectorAll('.vai-set [data-a="fbup"]')[1]); await tick();
  ok(w.document.querySelector('.vai-set .vai-fbl li').textContent.includes('bản sao'), 'move up reorders');
  click(w, A(w, 'del')); await tick();
  eq(cards(w).length, 4, 'first click on Xóa only arms it');
  click(w, A(w, 'del')); await tick();
  eq(cards(w).length, 3, 'second click deletes');
  click(w, A(w, 'save')); await tick(60); await until(() => saved >= 2);
  st = await w.VenusAI.getSettings();
  eq([st.profiles.map((p) => p.name), st.fallbackProfileIds.length, st.activeProfileId], [['A', 'B renamed'.slice(0, 1), 'C'], 1, 'b'], 'saved list after add/dup/delete');
  click(w, A(w, 'close')); await tick();
  ok(!w.document.querySelector('.vai-set'), 'close button closes');
  // Escape
  w.VenusAI.openSettings(); await until(() => cards(w).length === 3);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await tick();
  ok(!w.document.querySelector('.vai-set'), 'Escape closes');
  // delete the active profile
  w.VenusAI.openSettings(); await until(() => cards(w).length === 3);
  click(w, A(w, 'del')); click(w, A(w, 'del')); await tick();
  click(w, A(w, 'save')); await tick(60);
  st = await w.VenusAI.getSettings();
  eq([st.profiles.length, st.activeProfileId !== 'b'], [2, true], 'deleting the active profile activates another one');
  ok(!st.fallbackProfileIds.includes(st.activeProfileId), 'active is not in the fallback list');

  T('settings UI: Test button runs only the edited profile; counter + reset');
  w = await boot({ settings: cfgOf([A1, B1], 'a', ['b']) }, (url) => sse('OK'));
  w.VenusAI.openSettings(); await until(() => cards(w).length === 2);
  click(w, cards(w)[1]); await tick();
  click(w, A(w, 'test')); await until(() => /Chạy được/.test(w.document.querySelector('#vaiMsg').textContent), 4000);
  ok(/Chạy được/.test(w.document.querySelector('#vaiMsg').textContent), 'test message shows success');
  eq([w.calls.length, hostOfUrl(w.calls[0].url)], [1, 'api.b.test'], 'only profile B was called (the selected one), no fallback');
  ok(await until(() => cards(w)[1].textContent.includes('Hôm nay: 1/9')), 'B card shows its own counter 1/9');
  ok(cards(w)[0].textContent.includes('Hôm nay: 0/5'), 'A card shows 0/5');
  click(w, cards(w)[1]); await tick();
  ok(w.document.querySelector('#vaiUse').textContent.includes('1 lượt'), 'usage line in the form');
  click(w, A(w, 'resetuse')); await until(() => cards(w)[1].textContent.includes('Hôm nay: 0/9'));
  eq((await w.VenusAI.getUsage('b')).n, 0, 'reset counter of the selected profile');
  // a failing test shows the error and keeps the dialog usable
  w = await boot({ settings: cfgOf([A1]) }, () => jerr(401, 'nope'));
  w.VenusAI.openSettings(); await until(() => cards(w).length === 1);
  click(w, A(w, 'test')); await until(() => /Key không đúng/.test(w.document.querySelector('#vaiMsg').textContent), 4000);
  ok(/Key không đúng/.test(w.document.querySelector('#vaiMsg').textContent), 'error text shown');
  ok(!A(w, 'save').disabled, 'buttons enabled again after a failed test');

  T('settings UI: models list reads supported_parameters + uses /models from full URL');
  w = await boot({ settings: cfgOf([prof({ requestFormat: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1/chat/completions', apiKey: 'kk', model: '' })]) }, (url) => {
    if (/\/models$/.test(url)) return new Response(JSON.stringify({ data: [
      { id: 'x/free-think:free', context_length: 128000, created: 5, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['temperature', 'reasoning'] },
      { id: 'y/paid', context_length: 8000, created: 9, pricing: { prompt: '0.1', completion: '0.1' }, supported_parameters: ['temperature'] }] }), { status: 200 });
    return sse('OK');
  });
  w.VenusAI.openSettings(); await until(() => cards(w).length === 1);
  click(w, A(w, 'models')); await until(() => w.document.querySelectorAll('#vaiModels option').length > 0);
  eq(w.calls[0].url, 'https://openrouter.ai/api/v1/models', 'models URL derived from the full chat URL');
  eq(w.calls[0].headers.Authorization, 'Bearer kk', 'models call sends the key');
  eq([...w.document.querySelectorAll('#vaiModels option')].map((o) => o.value), ['x/free-think:free'], 'free-only filter');
  ok(w.document.querySelector('#vaiModels option').textContent.includes('suy luận'), 'reasoning-capable model is flagged');

  T('settings UI: key never rendered as text, user strings escaped');
  w = await boot({ settings: cfgOf([prof({ name: '<img src=x onerror=alert(1)>', model: '"><b>x</b>', apiKey: 'sk-secret' })]) });
  w.VenusAI.openSettings(); await until(() => cards(w).length === 1);
  ok(!w.document.querySelector('.vai-set img') && !w.document.querySelector('.vai-set b[data-x]'), 'no injected elements');
  eq(F(w, 'apiKey').type, 'password', 'key field is a password input');
  eq(F(w, 'model').value, '"><b>x</b>', 'model value round-trips through attribute escaping');

  /* ───────── 6. openPanel ───────── */
  T('openPanel: profile picker updates meta + counter without closing');
  w = await boot({ settings: cfgOf([A1, B1], 'a', ['b']) });
  const panel = w.VenusAI.openPanel({ title: 'T', contextText: 'data', contextLabel: 'L', presets: [{ label: 'p', prompt: 'q' }] });
  const pick = () => w.document.querySelector('.vai [data-prof]');
  ok(await until(() => pick() && !pick().hidden && pick().options.length === 2), 'picker shown with 2 profiles');
  ok(w.document.querySelector('.vai-meta').textContent.includes('api.a.test'), 'meta shows A host');
  pick().value = 'b'; pick().dispatchEvent(new w.Event('change', { bubbles: true }));
  ok(await until(() => w.document.querySelector('.vai-meta').textContent.includes('api.b.test')), 'meta follows the picker');
  ok(w.document.querySelector('.vai'), 'panel still open');
  ok(await until(() => /0\/9/.test(w.document.querySelector('.vai-use').textContent)), 'counter shows B limit 0/9');
  eq((await w.VenusAI.getSettings()).activeProfileId, 'b', 'picker persisted the active profile');
  await panel.ask('hello');
  ok(await until(() => /1\/9/.test(w.document.querySelector('.vai-use').textContent) && w.document.querySelector('.vai-a')), 'asking uses B and bumps B counter');
  eq(hostOfUrl(w.calls[w.calls.length - 1].url), 'api.b.test', 'request went to B');
  const sys = w.calls[w.calls.length - 1].body.messages[0];
  eq(sys.role, 'system', 'system message first');
  ok(sys.content.includes('Mình đang xây kiến thức'), 'default instructions used when customPrompt is empty');
  panel.close();
  w = await boot({ settings: cfgOf([prof({ id: 'z', customPrompt: 'CUSTOM-PROMPT-XYZ' })]) });
  const p2 = w.VenusAI.openPanel({ title: 'T', contextText: 'data', contextLabel: 'L' });
  await tick(30); ok(pick().hidden, 'picker hidden with a single profile');
  await p2.ask('hi'); await until(() => w.calls.length > 0);
  const sys2 = w.calls[0].body.messages[0];
  ok(sys2.content.includes('CUSTOM-PROMPT-XYZ') && !sys2.content.includes('Mình đang xây kiến thức'), 'customPrompt replaces the default');
  p2.close();

  /* ───────── 7. the ⚙ AI button in the Memory modal ───────── */
  T('venus-memory-ui: ⚙ AI button loads ai.js on demand and opens settings above the modal');
  const stubMem = 'window.VenusMemory = { ready: async () => true, stats: async () => ({ profile: 0, decisions: 0 }), listProfile: async () => [], listDecisions: async () => [], listAudit: async () => [], getStaleMemories: async () => [], getSyncState: async () => ({}), onWrite: () => () => {} };';
  const dom = new JSDOM('<!doctype html><html><body><div class="dark-mode-container"></div></body></html>', { runScripts: 'outside-only', url: 'https://venus.test/', pretendToBeVisual: true });
  const mw = dom.window; mw.indexedDB = new IDBFactory(); mw.IDBKeyRange = IDBKeyRange; mw.TextDecoder = TextDecoder; mw.TextEncoder = TextEncoder;
  mw.fetch = async () => sse('OK');
  let appended = null;
  const origAppend = mw.document.head.appendChild.bind(mw.document.head);
  mw.document.head.appendChild = (n) => { if (n.tagName === 'SCRIPT' && /ai\.js/.test(n.src)) { appended = n.src; setTimeout(() => { mw.eval(AI); n.onload && n.onload(); }, 5); return n; } return origAppend(n); };
  try { mw.eval(stubMem); mw.eval(MEMUI); } catch (e) { console.log('  (memory-ui boot error: ' + e.message + ')'); }
  const m = mw.VenusMemoryUI;
  ok(m && m.open, 'VenusMemoryUI exposed');
  if (m && m.open) {
    try { await m.open(); } catch (e) { console.log('  open error', e.message); }
    const aiBtn = await until(() => mw.document.getElementById('vpisAiBtn'));
    ok(aiBtn, '⚙ AI button exists in the header');
    if (aiBtn) {
      eq(aiBtn.textContent, '⚙ AI', 'label');
      ok(!mw.VenusAI, 'ai.js not loaded yet');
      aiBtn.click();
      ok(await until(() => mw.document.querySelector('dialog.vai-set'), 3000), 'settings dialog opened after on-demand load');
      ok(appended && /\.\/ai\.js$|ai\.js$/.test(appended), 'script ./ai.js was requested');
      mw.document.querySelector('dialog.vai-set').remove(); mw.document.dispatchEvent(new mw.KeyboardEvent('keydown', { key: 'Escape' }));
    }
  }

  console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '✓ ') + pass + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack || e); process.exit(2); });
