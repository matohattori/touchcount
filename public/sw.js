// public/sw.js
const CACHE = "shopping-list-cache-v1";
const ASSETS = ["/"]; // 必要に応じて "/index.html", "/assets/..." を追加

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((k) => (k === CACHE ? undefined : caches.delete(k)))
        )
      )
  );
});

// SPA向け：まずはネット→失敗時キャッシュ、HTMLナビゲーションは index.html にフォールバック
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const isNavigation = req.mode === "navigate";

  e.respondWith(
    (async () => {
      try {
        const net = await fetch(req);
        // 成功したレスポンスは静的ファイルならキャッシュ更新
        const url = new URL(req.url);
        if (
          url.origin === location.origin &&
          (url.pathname === "/" || url.pathname.startsWith("/assets/"))
        ) {
          const cache = await caches.open(CACHE);
          cache.put(req, net.clone());
        }
        return net;
      } catch {
        const cache = await caches.open(CACHE);
        if (isNavigation) {
          // index.html フォールバック
          const fallback = await cache.match("/");
          if (fallback) return fallback;
        }
        const cached = await cache.match(req);
        if (cached) return cached;
        throw new Error("offline and no cache");
      }
    })()
  );
});
