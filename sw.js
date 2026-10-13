/**
 * Service worker：只缓存 App 自己的外壳文件，让它能离线打开。
 *
 * ⚠ 绝对不能缓存 GitHub 和模型的请求 —— 那些永远是实时的。
 * 下面用 `url.origin !== self.location.origin` 把它们全部放过去。
 */
const CACHE = 'archive-shell-v1';
const ASSETS = [
  './',
  './index.html',
  './archive-core.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 别人的域名（GitHub、模型厂商）一律直连，不碰
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // 网络优先：拿到新的就顺手更新缓存
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
