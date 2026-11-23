/* Venus Hub — offline/PWA loader. Safe to include on every page (runs once). */
(function () {
  'use strict';
  if (window.__venusPwa) return; window.__venusPwa = true;
  var head = document.head;
  function ensure(sel, attrs, tag) {
    if (head.querySelector(sel)) return;
    var el = document.createElement(tag || 'link');
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    head.appendChild(el);
  }
  ensure('link[rel="manifest"]', { rel: 'manifest', href: './manifest.json' });
  ensure('link[rel="apple-touch-icon"]', { rel: 'apple-touch-icon', href: './icons/apple-touch-icon.png' });
  ensure('meta[name="apple-mobile-web-app-capable"]', { name: 'apple-mobile-web-app-capable', content: 'yes' }, 'meta');
  ensure('meta[name="apple-mobile-web-app-title"]', { name: 'apple-mobile-web-app-title', content: 'Venus Hub' }, 'meta');
  ensure('meta[name="theme-color"]', { name: 'theme-color', content: '#d17b96' }, 'meta');

  if (!('serviceWorker' in navigator)) return;
  var ok = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!ok) { try { console.info('[Venus Hub] Offline mode needs https:// or localhost (not file://).'); } catch (e) {} return; }

  var HOSTS = /^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn-icons-png\.flaticon\.com)\//;
  function warm(reg) {
    var sw = reg.active || reg.waiting || reg.installing; if (!sw) return;
    var urls = performance.getEntriesByType('resource').map(function (r) { return r.name; }).filter(function (u) { return HOSTS.test(u); });
    sw.postMessage({ type: 'warm', urls: urls });
  }
  function start() {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).then(function () {
      return navigator.serviceWorker.ready;
    }).then(function (reg) {
      warm(reg); setTimeout(function () { warm(reg); }, 6000);   // second pass catches libraries loaded a little later
    }).catch(function (e) { try { console.warn('[Venus Hub] Service worker failed:', e); } catch (_) {} });
  }
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
})();
