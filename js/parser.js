// DJI飛行記録(.txt)の解析。
//
// dji-log-parser の WASM 版を使う。暗号化されている v13 以降のログでも、
// 先頭の Details ブロックは平文なので復号キー（DJI APIキー）なしで読める。
// 飛行日誌に必要な項目は Details に揃っているため、このアプリでは
// フレームの復号を行わない（ブラウザからは DJI API が CORS で叩けないため）。

import { DEFAULT_PURPOSE } from "./constants.js";

let wasm = null;

async function loadWasm() {
  if (!wasm) wasm = await import("../vendor/dji_log_parser_js.mjs");
  return wasm;
}

// DJIFlightRecord_2025-12-13_[11-00-57].txt → ローカル時刻
function filenameDate(name) {
  const m = name.match(/(\d{4})-(\d{2})-(\d{2})_\[(\d{2})-(\d{2})-(\d{2})\]/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s);
}

function validCoord(lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number") return false;
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) return false;
  return Math.abs(lat) > 0.0001 || Math.abs(lon) > 0.0001;
}

function validDate(dt) {
  if (!(dt instanceof Date) || isNaN(dt)) return false;
  const y = dt.getFullYear();
  return y >= 2010 && y <= new Date().getFullYear() + 1;
}

/** 1件の .txt を解析して飛行記録オブジェクトを返す。 */
export async function parseLog(file) {
  const mod = await loadWasm();
  const bytes = new Uint8Array(await file.arrayBuffer());

  let log;
  try {
    log = new mod.DJILog(bytes);
  } catch (e) {
    throw new Error(`ログを読み取れませんでした（${e}）`);
  }
  const d = log.details;

  // 開始時刻は Details を優先し、壊れていればファイル名から補う
  let takeoff = new Date(d.startTime);
  if (!validDate(takeoff)) takeoff = filenameDate(file.name);
  if (!validDate(takeoff)) throw new Error("飛行日時を特定できませんでした");

  const duration = Number(d.totalTime) || 0;
  const landing = new Date(takeoff.getTime() + duration * 1000);

  const hasGps = validCoord(d.latitude, d.longitude);

  return {
    fileName: file.name,
    aircraftName: d.aircraftName || "",
    aircraftSn: d.aircraftSn || "",
    takeoffTime: takeoff.toISOString(),
    landingTime: landing.toISOString(),
    durationSeconds: duration,
    // totalDistance は km 単位
    totalDistanceM: Math.round((Number(d.totalDistance) || 0) * 1000 * 10) / 10,
    maxAltitudeM: Number(d.maxHeight) || 0,
    lat: hasGps ? d.latitude : null,
    lon: hasGps ? d.longitude : null,
    hasGps,
    logVersion: log.version,
    // 以下は利用者が編集する項目
    place: "",
    purpose: [DEFAULT_PURPOSE],
    specifiedFlight: [],
    route: "",
    issues: "",
    issueResponse: "",
    remarks: "",
    manualOverride: null, // null=自動判定 / true=飛行 / false=対象外
  };
}
