// オフラインで動かすためのキャッシュ。
// 解析・保存・Excel出力はすべて端末内で完結するため、
// いったん読み込めば圏外でも使える（住所の自動入力だけは通信が要る）。

const CACHE = "dji-log-mobile-v9";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/style.css",
  "./js/app.js",
  "./js/db.js",
  "./js/parser.js",
  "./js/geocode.js",
  "./js/export.js",
  "./js/constants.js",
  "./vendor/dji_log_parser_js.mjs",
  "./vendor/xlsx.mini.min.js",
  "./vendor/flatgeobuf-geojson.min.js",
  "./js/parcels.js",
  "./js/blocks.js",
  "./data/muni.json",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ネットワーク優先・キャッシュ予備。
// キャッシュ優先だとアプリを更新しても古い画面が出続けてしまうため、
// 通信できるときは常に最新を取り、圏外のときだけキャッシュを使う。
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // 住所検索など外部への通信には手を出さない
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== "GET") return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(async () => {
        // ?v=2 のような問い合わせ文字列が付いていてもキャッシュに当てる
        const hit = await caches.match(e.request, { ignoreSearch: true });
        if (hit) return hit;
        // ページを開く要求は、どのURLでも index.html を返して起動させる
        if (e.request.mode === "navigate") {
          const index = await caches.match("./index.html", { ignoreSearch: true });
          if (index) return index;
        }
        return new Response("オフラインのため読み込めませんでした", {
          status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      })
  );
});
