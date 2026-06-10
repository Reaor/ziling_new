/* 字灵日程 Service Worker：壳缓存（添加到主屏幕/弱网可用）。
 * 策略：导航请求 network-first（保证拿到新版本，离线回缓存）；静态资源 cache-first。
 * 发版时改 VERSION 即整体失效旧缓存。 */
const VERSION = 'zl-v3';
const CORE = [
  './', 'index.html', 'ziling.html', 'manifest.webmanifest',
  'css/shell.css', 'css/app.css',
  'js/shell/main.js', 'js/shell/store.js', 'js/shell/splash.js', 'js/shell/api.js', 'js/shell/remind.js',
  'js/app.js', 'js/ai/bridge.js', 'js/ai/mock.js', 'js/ui/settings.js', 'js/game/wordmatch.js',
  'js/render/renderer.js', 'js/input/gestures.js',
  'js/core/grid.js', 'js/core/character.js', 'js/core/motion.js', 'js/core/shape.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // API/跨域请求不缓存
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit
      || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      }))
  );
});
