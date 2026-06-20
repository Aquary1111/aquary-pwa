/* Aquary PWA Service Worker
 * アプリの“ガワ”（HTML/JS/アイコン）をキャッシュし、オフラインでも起動できるようにする。
 * API（GAS doPost）はクロスオリジンPOSTのためキャッシュしない（=常にネットワーク）。
 * 読み取りデータのオフライン表示は app.js 側の localStorage キャッシュで担う。
 */
var CACHE = 'aquary-shell-v16';
var SHELL = [
  './',
  './index.html',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // config.js が無い場合でも install を失敗させない
      return Promise.all(SHELL.map(function (u) {
        return c.add(u).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  // GET の同一オリジン資産のみ扱う。API(POST/別オリジン)やGISは素通し。
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // ナビゲーションはネットワーク優先＋オフライン時はキャッシュのindexへフォールバック
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function () { return caches.match('./index.html'); })
    );
    return;
  }
  // それ以外の資産は cache-first（更新があれば裏で取得して差し替え）
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
