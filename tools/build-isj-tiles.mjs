// 国土交通省「街区レベル位置参照情報」を、地理的なタイルに分割して
// data/isj/<県コード>/<タイル>.json として書き出す。
//
//   node tools/build-isj-tiles.mjs 34        # 広島県
//   node tools/build-isj-tiles.mjs 33 34 35  # 複数まとめて
//
// 住居表示のある市街地はこのデータでしか番地が引けない
// （法務省の登記所備付地図データには市街地の筆が収録されていない）。
// ブラウザから国土交通省へ直接取得するとCORSで拒否されるため、
// あらかじめ変換して同一オリジンに置く。
//
// 出典: 国土交通省 位置参照情報 https://nlftp.mlit.go.jp/isj/

import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_ROOT = join(ROOT, "data", "isj");

export const STEP = 0.05;    // タイル1辺（度）。約5.5km
const MARGIN = 0.005;        // 境界付近の点は隣のタイルにも入れる。約550m

// 新しい年度から順に試す
const VERSIONS = Array.from({ length: 8 }, (_, i) => `${26 - i}.0a`);

export const tileKey = (lat, lon) =>
  `${Math.floor(lat / STEP)}_${Math.floor(lon / STEP)}`;

async function fetchPrefZip(pref) {
  for (const v of VERSIONS) {
    const url = `https://nlftp.mlit.go.jp/isj/dls/data/${v}/${pref}000-${v}.zip`;
    const res = await fetch(url);
    if (res.ok) {
      console.log(`  ${v} を取得しました`);
      return { buf: Buffer.from(await res.arrayBuffer()), version: v };
    }
  }
  throw new Error(`県コード ${pref} のデータが見つかりません`);
}

// zipから最初のCSVを取り出す（deflate格納のみを想定）
function extractCsv(buf) {
  let pos = 0;
  while (pos < buf.length - 4) {
    if (buf.readUInt32LE(pos) !== 0x04034b50) { pos++; continue; }
    const method = buf.readUInt16LE(pos + 8);
    const compSize = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const name = buf.subarray(pos + 30, pos + 30 + nameLen).toString("latin1");
    const dataStart = pos + 30 + nameLen + extraLen;
    if (name.toLowerCase().endsWith(".csv")) {
      const data = buf.subarray(dataStart, dataStart + compSize);
      // zipの格納方式は 0=無圧縮 / 8=deflate（raw）
      return method === 0 ? data : inflateRawSync(data);
    }
    pos = dataStart + compSize;
  }
  throw new Error("zip内にCSVが見つかりません");
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(",").map((s) => s.replace(/^"|"$/g, ""));
  const col = (n) => head.indexOf(n);
  const iLat = col("緯度"), iLon = col("経度");
  const iOaza = col("大字・丁目名"), iKoaza = col("小字・通称名"), iBlk = col("街区符号・地番");
  if ([iLat, iLon, iOaza, iBlk].some((i) => i < 0)) throw new Error("CSVの列名が想定と違います");

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(",").map((s) => s.replace(/^"|"$/g, ""));
    const lat = Number(f[iLat]), lon = Number(f[iLon]);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    out.push([lat, lon, (f[iOaza] || "") + (f[iKoaza] || ""), f[iBlk] || ""]);
  }
  return out;
}

async function buildPref(pref) {
  console.log(`\n県コード ${pref} を処理します`);
  const { buf, version } = await fetchPrefZip(pref);
  const text = new TextDecoder("shift_jis").decode(extractCsv(buf));
  const rows = parseCsv(text);
  console.log(`  ${rows.length.toLocaleString()} 件を読み込みました`);

  const tiles = new Map();
  for (const row of rows) {
    const [lat, lon] = row;
    const seen = new Set();
    for (const dy of [-MARGIN, 0, MARGIN]) {
      for (const dx of [-MARGIN, 0, MARGIN]) {
        const k = tileKey(lat + dy, lon + dx);
        if (seen.has(k)) continue;
        seen.add(k);
        if (!tiles.has(k)) tiles.set(k, []);
        tiles.get(k).push(row);
      }
    }
  }

  const dir = join(OUT_ROOT, pref);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  let bytes = 0;
  for (const [key, list] of tiles) {
    // 町名は繰り返しが多いので辞書化して縮める
    const towns = [...new Set(list.map((r) => r[2]))].sort();
    const ti = new Map(towns.map((t, i) => [t, i]));
    const body = {
      t: towns,
      b: list.map(([la, lo, t, blk]) => [+la.toFixed(6), +lo.toFixed(6), ti.get(t), blk]),
    };
    const json = JSON.stringify(body);
    bytes += Buffer.byteLength(json);
    await writeFile(join(dir, `${key}.json`), json);
  }
  await writeFile(join(dir, "meta.json"),
    JSON.stringify({ pref, version, step: STEP, tiles: tiles.size, rows: rows.length }));
  console.log(`  タイル ${tiles.size} 件 / 合計 ${(bytes / 1024 / 1024).toFixed(1)}MB を書き出しました`);
}

const prefs = process.argv.slice(2);
if (!prefs.length) {
  console.error("使い方: node tools/build-isj-tiles.mjs <県コード> [県コード...]");
  process.exit(1);
}
for (const p of prefs) await buildPref(p.padStart(2, "0"));
