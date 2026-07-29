// 座標 → 住所。
//
// 1. 国土地理院の逆ジオコーダで 都道府県＋市区町村＋町丁目 を求める
//    （市区町村コードの変換表は data/muni.json に同梱）
// 2. その町丁目内の最寄りの番地を足す（見つからなければ町丁目まで）
//    - 市街地: 国土交通省 街区レベル位置参照情報（blocks.js）
//    - 郊外  : 法務省 登記所備付地図データ（parcels.js）

import * as blocks from "./blocks.js";
import * as parcels from "./parcels.js";

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

// 「加茂町字北山」と「加茂町北山」のような字の有無を吸収して比べる
function sameTown(a, b) {
  const x = norm(a).replace(/字/g, "");
  const y = norm(b).replace(/字/g, "");
  return !!x && !!y && (x === y || x.endsWith(y) || y.endsWith(x));
}

// 町丁目の先に番地を足す。付けられなければ住所をそのまま返す。
//
// 2段構え。どちらも片方だけでは穴が空くため順に試す:
//   1. 街区レベル位置参照情報（blocks.js）… 住居表示のある市街地
//   2. 登記所備付地図データ（parcels.js）  … 郊外の地番
//
// いずれも「最寄り」を採るので隣町の番号を拾う危険がある（郊外では
// 2km先が最寄りになることもある）。国土地理院が返した町名と一致する
// ときだけ採用する。代表点は区画の中心なので必ず「付近」を付ける。
async function appendNumber(address, town, prefCode, lat, lon) {
  if (!town || !prefCode) return address;

  try {
    const blk = await blocks.nearestInTown(prefCode, lat, lon, town);
    if (blk) return `${address}${blk.block}番付近`;
  } catch (e) {
    console.warn("街区の付与に失敗しました:", e);
  }

  try {
    const found = await parcels.nearest(prefCode, lat, lon);
    if (found && sameTown(found.town, town)) {
      return `${address}${found.chiban}番付近`;
    }
  } catch (e) {
    console.warn("地番の付与に失敗しました:", e);
  }

  return address;
}

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
    let address = `${pc[0]}${norm(pc[1])}${town}`;
    if (address) {
      address = await appendNumber(address, town, muniCd.padStart(5, "0").slice(0, 2), lat, lon);
    }
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
