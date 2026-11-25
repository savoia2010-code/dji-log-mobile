// 機体を記録ごと消す（Mac版の app/erase.py と同じ規則）。
//
// 手放した機体はふだん「使用終了」にする（記録は飛行日誌として残す）。ここは、自分の機体では
// ない記録が混ざったときなどに、機体と、その飛行記録・日常点検記録を消すためのもの。
//
// 消した機体と時刻を「消した機体」（設定 erasedAircraft。{シリアル: 消した時刻(UTC)}）に残し、
// その時刻までの記録（飛行は離陸時刻、点検は実施日）は、どこから届いても入れない
// （記録の読み込み・Macの日誌・Googleドライブのバックアップ）。
// Mac版とは、携行用の日誌の erased_aircraft と、バックアップの erased で互いに知らせる。

import * as db from "./db.js";
import * as settingsSync from "./settingsSync.js";

const KEY = "erasedAircraft";
const timeOf = (v) => { const t = Date.parse(String(v || "")); return Number.isNaN(t) ? null : t; };
const pad = (n) => String(n).padStart(2, "0");
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** {シリアル: 消した時刻}。 */
export async function marks() {
  const v = (await db.getStoredSettings())[KEY];
  if (!v || typeof v !== "object") return {};
  return Object.fromEntries(Object.entries(v).filter(([k, at]) => k && timeOf(at) !== null));
}

/** 消した機体の、消す前の飛行か。 */
export function flightErased(m, serial, takeoff) {
  const at = timeOf(m && m[serial || ""]);
  const when = timeOf(takeoff);
  return at !== null && when !== null && when <= at;
}

/** 消した機体の、消した日までの記録か（点検・Macの日誌の行は日付で見る）。 */
export function dayErased(m, serial, date) {
  const at = timeOf(m && m[serial || ""]);
  return at !== null && !!date && String(date).slice(0, 10) <= localDay(at);
}

/** 2つの「消した機体」を合わせる（同じ機体なら遅い方の時刻）。 */
export function mergeMarks(a, b) {
  const out = {};
  for (const src of [a, b]) {
    for (const [k, at] of Object.entries(src && typeof src === "object" ? src : {})) {
      const t = timeOf(at);
      if (!k || t === null) continue;
      if (!(k in out) || timeOf(out[k]) < t) out[k] = String(at);
    }
  }
  return out;
}

/** 機体を記録ごと消す。at までの記録を消し、記録が残らなければ機体も消す。 */
export async function purge(serial, at = new Date().toISOString()) {
  const m = mergeMarks(await marks(), { [serial]: at });
  await db.setSetting(KEY, m);
  let flights = 0, inspections = 0;
  for (const f of await db.getAllFlights()) {
    if (f.aircraftSn !== serial || !flightErased(m, serial, f.takeoffTime || at)) continue;
    await db.deleteFlight(f.fileName);
    await db.deleteOutbox(f.fileName);   // Macへ送る順番待ちからも外す
    flights++;
  }
  for (const r of await db.getAllInspections()) {
    if (r.aircraftSerial !== serial || !dayErased(m, serial, r.date)) continue;
    await db.deleteInspection(r.id);
    inspections++;
  }
  for (const r of await db.getAllMaintenance()) {
    if (r.aircraftSerial !== serial || !dayErased(m, serial, r.date)) continue;
    await db.deleteMaintenance(r.id);
  }
  const left = (await db.getAllFlights()).some((f) => f.aircraftSn === serial)
    || (await db.getAllInspections()).some((r) => r.aircraftSerial === serial)
    || (await db.getAllMaintenance()).some((r) => r.aircraftSerial === serial);
  if (!left) {
    await db.deleteAircraft(serial);
    await settingsSync.forgetAircraft(serial);
  }
  return { flights, inspections };
}

/** 相手側（Mac版・バックアップ）で消した機体を、このiPhoneでも消す。消した機体のシリアルを返す。 */
export async function applyRemote(remote) {
  if (!remote || typeof remote !== "object") return [];
  const mine = await marks();
  const done = [];
  for (const [serial, at] of Object.entries(remote)) {
    const t = timeOf(at);
    if (!serial || t === null) continue;
    if (serial in mine && timeOf(mine[serial]) >= t) continue;
    await purge(serial, String(at));
    done.push(serial);
  }
  return done;
}
