// Mac版と設定を揃える（Mac版の app/settings_sync.py と同じ規則）。
//
// 揃える設定（項目ごとに、最後に変えた時刻を残す）:
//   distanceThresholdM / altitudeThresholdM   飛行とみなす距離・高度
//   includeNoGps / noGpsMinMinutes            GPSの無い記録の扱い
//   defaultPilot                              操縦者（氏名・技能証明番号）
//   aircraft:<シリアル>:registration / model / initialFlightSeconds   機体ごとの情報
//
// - 時刻を付けるのは「保存」で値が実際に変わった項目だけ。
// - 相手側の時刻の方が新しい項目だけを、相手の値に合わせる（項目ごとに比べる）。
// - まだどちらでも変えていない項目は、こちらが空欄のときだけ相手の値で埋める。
// 受け渡し: Mac → iPhone は携行用ファイルの settings、iPhone → Mac はバックアップの sync。

import * as db from "./db.js";

const LABELS = {
  distanceThresholdM: "飛行とみなす距離",
  altitudeThresholdM: "飛行とみなす高度",
  includeNoGps: "GPSの無い記録の扱い",
  noGpsMinMinutes: "GPSの無い記録を飛行とみなす時間",
  defaultPilot: "操縦者",
  registration: "登録記号",
  model: "型式",
  initialFlightSeconds: "アプリ導入前の総飛行時間",
};
const AIRCRAFT_FIELDS = ["registration", "model", "initialFlightSeconds"];

const timeOf = (v) => { const t = Date.parse(String(v || "")); return Number.isNaN(t) ? null : t; };
const norm = (v) => JSON.stringify(v, v && typeof v === "object" ? Object.keys(v).sort() : undefined);
const blank = (v) => (v && typeof v === "object" ? !Object.values(v).some(Boolean) : v === "" || v === 0 || v == null);

export function label(key) {
  if (key.startsWith("aircraft:")) {
    const [, serial, field] = key.split(":");
    return `${LABELS[field] || field}（S/N …${serial.slice(-4)}）`;
  }
  return LABELS[key] || key;
}

/** 揃える設定の今の値。 */
export async function snapshot() {
  const s = await db.getSettings();
  const out = {
    distanceThresholdM: Number(s.distanceThresholdM),
    altitudeThresholdM: Number(s.altitudeThresholdM),
    includeNoGps: !!s.includeNoGps,
    noGpsMinMinutes: Number(s.noGpsMinMinutes),
    defaultPilot: { name: s.pilotName || "", certificateNumber: s.pilotCertificate || "" },
  };
  for (const a of await db.getAllAircraft()) {
    out[`aircraft:${a.serial}:registration`] = a.registration || "";
    out[`aircraft:${a.serial}:model`] = a.model || "";
    out[`aircraft:${a.serial}:initialFlightSeconds`] = Number(a.initialFlightSeconds) || 0;
  }
  return out;
}

export async function stamps() {
  const st = (await db.getSettings()).syncAt;
  return st && typeof st === "object" ? st : {};
}

/** 保存の前後で変わった項目に、今の時刻を付ける。変わった項目を返す。 */
export async function stampChanges(before) {
  const after = await snapshot();
  const at = new Date().toISOString();
  const st = { ...(await stamps()) };
  const changed = Object.keys(after).filter((k) => k in before && norm(before[k]) !== norm(after[k]));
  for (const k of changed) st[k] = at;
  if (changed.length) await db.setSetting("syncAt", st);
  return changed;
}

/** バックアップに入れる設定（値と、最後に変えた時刻）。 */
export async function forBackup() {
  const st = await stamps();
  const snap = await snapshot();
  return Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, { value: v, at: st[k] || "" }]));
}

/** バックアップの設定どうしを合わせる。項目ごとに新しい方、時刻が無ければ空欄でない方。 */
export function merge(remote, local) {
  const out = { ...(remote && typeof remote === "object" ? remote : {}) };
  for (const [k, mine] of Object.entries(local || {})) {
    const theirs = out[k];
    if (!theirs || typeof theirs !== "object") { out[k] = mine; continue; }
    const tm = timeOf(mine.at), tt = timeOf(theirs.at);
    if (tt !== null && (tm === null || tt > tm)) continue;            // バックアップの方が新しい
    if (tt === null && tm === null && blank(mine.value)) continue;    // どちらも未変更で手元が空欄
    out[k] = mine;
  }
  return out;
}

async function set(key, value) {
  if (["distanceThresholdM", "altitudeThresholdM", "noGpsMinMinutes"].includes(key)) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 100000) return false;
    await db.setSetting(key, n);
    return true;
  }
  if (key === "includeNoGps") {
    if (typeof value !== "boolean") return false;
    await db.setSetting(key, value);
    return true;
  }
  if (key === "defaultPilot") {
    if (!value || typeof value !== "object" || !String(value.name || "").trim()) return false;
    await db.setSetting("pilotName", String(value.name).trim().slice(0, 100));
    await db.setSetting("pilotCertificate", String(value.certificateNumber || "").trim().slice(0, 100));
    return true;
  }
  if (key.startsWith("aircraft:")) {
    const [, serial, field] = key.split(":");
    if (!serial || !AIRCRAFT_FIELDS.includes(field)) return false;
    const v = field === "initialFlightSeconds" ? Number(value) : String(value ?? "").trim().slice(0, 100);
    if (field === "initialFlightSeconds" && !(Number.isFinite(v) && v >= 0 && v <= 1e7)) return false;
    const a = (await db.getAllAircraft()).find((x) => x.serial === serial)
      || { serial, name: "", registration: "", model: "", initialFlightSeconds: 0 };
    await db.putAircraft({ ...a, [field]: v });
    return true;
  }
  return false;
}

/**
 * 相手側（Mac版・バックアップ）で後から変えた項目を、相手の値に合わせる。
 * 合わせた項目の名前を返す。
 */
export async function applyRemote(remote) {
  if (!remote || typeof remote !== "object") return [];
  const st = { ...(await stamps()) };
  const mine = await snapshot();
  const stored = await db.getStoredSettings();
  const isBlank = (k) => {
    if (k.startsWith("aircraft:")) return blank(mine[k]);
    if (k === "defaultPilot") return !mine.defaultPilot.name;
    return !(k in stored);    // 初期値のまま（まだ決めていない）
  };
  const changed = [];
  for (const [k, entry] of Object.entries(remote)) {
    if (!entry || typeof entry !== "object") continue;
    if (!(k in mine) && !k.startsWith("aircraft:")) continue;
    const tt = timeOf(entry.at), tm = timeOf(st[k]);
    const newer = tt !== null && (tm === null || tt > tm);
    const fill = tt === null && tm === null && isBlank(k) && !blank(entry.value);
    if (!newer && !fill) continue;
    if (k in mine && norm(mine[k]) === norm(entry.value)) {
      if (newer) st[k] = entry.at;
      continue;
    }
    if (await set(k, entry.value)) {
      if (newer) st[k] = entry.at;
      changed.push(label(k));
    }
  }
  await db.setSetting("syncAt", st);
  return changed;
}
