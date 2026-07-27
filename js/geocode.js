// 座標 → 住所（国土地理院の逆ジオコーダ）。
//
// 市区町村コードの変換表は data/muni.json に同梱しているので、
// 住所検索に必要な通信は国土地理院への1リクエストだけ。

const API_URL = "https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress";

let muniTable = null;
const cache = new Map(); // 同じ場所からの飛行が多いので使い回す

async function loadMuni() {
  if (muniTable) return muniTable;
  const res = await fetch("./data/muni.json");
  muniTable = await res.json();
  return muniTable;
}

const norm = (s) => (s || "").replace(/[　 ]/g, "");

/** 住所文字列を返す。取得できなければ空文字。 */
export async function reverseGeocode(lat, lon) {
  if (lat == null || lon == null) return "";
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (cache.has(key)) return cache.get(key);

  try {
    const res = await fetch(`${API_URL}?lat=${lat}&lon=${lon}`);
    if (!res.ok) return "";
    const results = (await res.json()).results || {};
    const muniCd = results.muniCd || "";
    let town = results.lv01Nm || "";
    if (town === "−") town = "";

    const table = await loadMuni();
    // muniCd は先頭0落ちの揺れがあるため両方引く
    const pc = table[muniCd] || table[muniCd.replace(/^0+/, "")] || ["", ""];
    const address = `${pc[0]}${norm(pc[1])}${town}`;
    cache.set(key, address);
    return address;
  } catch {
    return ""; // 圏外などは一時的な失敗なのでキャッシュしない
  }
}

/** 住所が空なら座標で代替する。 */
export function formatPlace(place, lat, lon) {
  if (place) return place;
  if (lat != null && lon != null) return `(${lat.toFixed(5)}, ${lon.toFixed(5)})`;
  return "";
}
