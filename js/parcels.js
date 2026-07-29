// 地番の検索（法務省 登記所備付地図データ）。
//
// 農研機構が公開している都道府県別のFlatGeobufを、HTTPレンジ取得で
// 必要な範囲だけ読む。1県2〜3GBあるが空間インデックス付きなので、
// 1回の検索で数百KB・1秒弱しか使わない。
// https://habs.rad.naro.go.jp/spatial_data/amxpoly47/

const URL_TEMPLATE =
  "https://habs.rad.naro.go.jp/spatial_data/amxpoly47/amxpoly_2022_{pref}.fgb";

const SEARCH_DEG = 0.0015; // 約165m四方
const MAX_M = 150;
const TIMEOUT_MS = 25000;
// 2.4GBのファイルへのレンジ取得なので単発で失敗することがある。
// 1回の失敗で諦めると以後ずっと番地が出なくなるため、続けて失敗した
// ときだけ打ち切る。
const GIVE_UP_AFTER = 3;

const failCount = new Map();

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * 最寄りの筆の { town, chiban, distance } を返す。見つからなければ null。
 * town は「大字名＋丁目名＋小字名」。呼び出し側で国土地理院の町名と
 * 突き合わせて、別の町の地番を拾っていないか確認すること。
 */
export async function nearest(prefCode, lat, lon) {
  if (!prefCode) return null;
  if ((failCount.get(prefCode) || 0) >= GIVE_UP_AFTER) return null;
  if (typeof flatgeobuf === "undefined") return null;

  const url = URL_TEMPLATE.replace("{pref}", prefCode);
  const d = SEARCH_DEG;
  const rect = { minX: lon - d, minY: lat - d, maxX: lon + d, maxY: lat + d };

  let best = null, bestD = MAX_M;
  const deadline = Date.now() + TIMEOUT_MS;

  try {
    for await (const f of flatgeobuf.deserialize(url, rect)) {
      if (Date.now() > deadline) break;
      const p = f.properties || {};
      const chiban = p["地番"];
      // 「道-492」「無地番-23」など地番でないものは除く
      if (!chiban || !/^\d/.test(String(chiban))) continue;
      const plat = Number(p["代表点緯度"]), plon = Number(p["代表点経度"]);
      if (!isFinite(plat) || !isFinite(plon)) continue;
      const dist = haversineM(lat, lon, plat, plon);
      if (dist < bestD) {
        bestD = dist;
        best = {
          town: `${p["大字名"] || ""}${p["丁目名"] || ""}${p["小字名"] || ""}`,
          chiban: String(chiban),
          distance: dist,
        };
      }
    }
  } catch (e) {
    console.warn("地番データを取得できませんでした:", e);
    failCount.set(prefCode, (failCount.get(prefCode) || 0) + 1);
    return null;
  }
  failCount.delete(prefCode); // 成功したら失敗回数を戻す
  return best;
}
