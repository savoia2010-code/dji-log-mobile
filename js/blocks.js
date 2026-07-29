// 街区（住居表示）の番地検索。
//
// 国土交通省「街区レベル位置参照情報」を tools/build-isj-tiles.mjs で
// タイル分割したものを data/isj/<県コード>/<タイル>.json から読む。
// 1タイルは5.5km四方・数十KB程度で、必要な1枚だけ取得する。
//
// 住居表示のある市街地はこのデータでしか番地が引けない。法務省の
// 登記所備付地図データ（parcels.js）には市街地の筆が収録されておらず、
// 逆に郊外はこちらに収録がない。両方を順に試すことで両者を補う。

const STEP = 0.05; // 生成時の値と一致させること
const MAX_M = 500;

const tileCache = new Map();   // タイル本体
const missing = new Set();     // 未整備の県・タイル

const tileKey = (lat, lon) => `${Math.floor(lat / STEP)}_${Math.floor(lon / STEP)}`;

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const norm = (s) => (s || "").replace(/[　 ]/g, "");

async function loadTile(prefCode, lat, lon) {
  const key = `${prefCode}/${tileKey(lat, lon)}`;
  if (tileCache.has(key)) return tileCache.get(key);
  if (missing.has(key)) return null;
  try {
    const res = await fetch(`./data/isj/${key}.json`);
    if (!res.ok) { missing.add(key); return null; }
    const tile = await res.json();
    tileCache.set(key, tile);
    return tile;
  } catch {
    missing.add(key);
    return null;
  }
}

/**
 * 指定の町丁目の中で最寄りの街区符号を返す。見つからなければ null。
 * 町丁目は国土地理院の逆ジオコーダで確定しているので、その中だけを探す
 * （隣町の番号を拾わないため）。
 */
export async function nearestInTown(prefCode, lat, lon, town) {
  if (!prefCode || !town) return null;
  const tile = await loadTile(prefCode, lat, lon);
  if (!tile) return null;

  const wanted = norm(town);
  // 町名の辞書から、対象の町丁目に当たる添字を集める
  const ids = new Set();
  tile.t.forEach((name, i) => { if (norm(name) === wanted) ids.add(i); });
  if (!ids.size) return null;

  let best = null, bestD = MAX_M;
  for (const [blat, blon, tid, blk] of tile.b) {
    if (!ids.has(tid)) continue;
    const d = haversineM(lat, lon, blat, blon);
    if (d < bestD) { bestD = d; best = blk; }
  }
  return best ? { block: best, distance: bestD } : null;
}
