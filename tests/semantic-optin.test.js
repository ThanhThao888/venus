// Semantic-search consent switch (F13). Run: NODE_PATH=$(npm root -g) node tests/semantic-optin.test.js
const { chromium } = require('playwright'); const path = require('path');
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext(); const pg = await ctx.newPage();
  const google = []; const errs = [];
  pg.on('pageerror', (e) => errs.push(String(e)));
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (/googleapis\.com/.test(u)) { google.push(u); const body = JSON.parse(r.request().postData() || '{}'); const n = body.requests ? body.requests.length : 1;
      const vec = Array(768).fill(0).map((_, i) => i === 0 ? 1 : 0);
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body.requests ? { embeddings: Array(n).fill({ values: vec }) } : { embedding: { values: vec } }) }); }
    if (u.startsWith('file://') || u.startsWith('about:')) return r.continue();
    return r.abort();
  });
  await pg.goto('file://' + __dirname + '/semantic-optin.html');
  await pg.waitForFunction(() => window.VenusAI);
  await pg.evaluate(() => window.VenusAI.saveSettings({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', apiKey: 'AIzaFAKE', model: 'gemini-2.5-flash' }));
  ok(await pg.evaluate(() => window.VenusAI.hasEmbeddingKey()), 'Gemini key detected');
  ok((await pg.evaluate(() => window.VenusAI.semanticEnabled())) === false, 'default is OFF');
  const r1 = await pg.evaluate(async () => { try { await window.VenusAI.embedTexts(['secret note text']); return 'sent'; } catch (e) { return e.code; } });
  ok(r1 === 'optout', 'embedTexts refuses while off (code ' + r1 + ')');
  const q1 = await pg.evaluate(async () => { try { await window.VenusAI.embedTexts([{ text: 'my search question' }], { taskType: 'RETRIEVAL_QUERY' }); return 'sent'; } catch (e) { return e.code; } });
  ok(q1 === 'optout', 'search question also refused while off');
  ok(google.length === 0, 'zero requests to Google while off (' + google.length + ')');
  // UI: settings dialog
  await pg.evaluate(() => window.VenusAI.openSettings());
  await pg.waitForSelector('.vai-set');
  await pg.evaluate(() => { document.querySelectorAll('.vai-acc, details, [data-acc]').forEach((e) => { if (e.open === false) e.open = true; }); });
  const openVec = async () => { const h = await pg.$('[data-acc="vector"], [data-a="acc"][data-k="vector"]'); if (h) await h.click().catch(() => {}); };
  await openVec();
  const txt = () => pg.evaluate(() => document.querySelector('.vai-set').innerText);
  ok(/ĐANG TẮT/.test(await txt()), 'settings shows OFF state');
  await pg.click('[data-a="semask"]');
  ok(/Tôi hiểu, bật/.test(await txt()) && /mọi note không gắn #noai/.test(await txt()), 'first tap asks for informed confirmation');
  ok((await pg.evaluate(() => window.VenusAI.semanticEnabled())) === false, 'still OFF after first tap');
  await pg.click('[data-a="semcancel"]');
  ok(/ĐANG TẮT/.test(await txt()) && (await pg.evaluate(() => window.VenusAI.semanticEnabled())) === false, 'cancel keeps OFF');
  await pg.click('[data-a="semask"]'); await pg.click('[data-a="semon"]');
  await pg.waitForFunction(() => /ĐANG BẬT/.test(document.querySelector('.vai-set').innerText));
  ok(/ĐANG BẬT/.test(await txt()) && (await pg.evaluate(() => window.VenusAI.semanticEnabled())) === true, 'confirm turns ON and persists');
  const r2 = await pg.evaluate(async () => { try { const v = await window.VenusAI.embedTexts(['hello']); return v.length; } catch (e) { return e.code; } });
  ok(r2 === 1 && google.length === 1, 'when ON, embedding works (' + r2 + ', requests ' + google.length + ')');
  await pg.click('[data-a="semoff"]'); await pg.waitForFunction(() => /ĐANG TẮT/.test(document.querySelector('.vai-set').innerText));
  ok(/ĐANG TẮT/.test(await txt()) && (await pg.evaluate(() => window.VenusAI.semanticEnabled())) === false, 'turning OFF works');
  const before = google.length;
  const r3 = await pg.evaluate(async () => { try { await window.VenusAI.embedTexts(['again']); return 'sent'; } catch (e) { return e.code; } });
  ok(r3 === 'optout' && google.length === before, 'blocked again after turning off');
  // survives reload
  await pg.reload(); await pg.waitForFunction(() => window.VenusAI);
  ok((await pg.evaluate(() => window.VenusAI.semanticEnabled())) === false, 'OFF after reload');
  ok(errs.length === 0, 'no page errors ' + errs.join('|'));
  console.log(`\n${pass} passed, ${fail} failed`); await b.close(); process.exit(fail ? 1 : 0);
})();
