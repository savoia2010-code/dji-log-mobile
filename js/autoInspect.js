// 飛行のあった日に、日常点検の記録を自動で作る（Mac版の app/inspections.py の auto_record と同じ規則）。
//
// 利用者の求めで（2026-11-25）、飛行のあった「日×機体」に点検の記録が無ければ、飛行前・飛行後とも
// 全項目「正常」の記録を作る（その日の最初の飛行の前に飛行前点検、最後の飛行の後に飛行後点検をした
// 扱い。実施場所は最初の飛行の場所、実施者は既定の操縦者）。毎回点検している前提の運用で、
// 異常があった日は手で直す。
// - 手で入れた記録がある日は作らない。このiPhoneの記録で飛行後点検が空なら、飛行前に異常が
//   無いときだけ「正常」で埋める（Macの記録の飛行後点検は、Mac版が埋める）。
// - 識別子は Mac版と同じ作り方（autoId）にし、両方で作っても1件になる。
// - 一度作った（または手の記録があった）「日×機体」は覚えておき（設定 autoInspected）、
//   自動の記録を消しても作り直さない。
// - 直した記録は auto を外し、手で入れた記録として扱う。

import * as db from "./db.js";
import * as erase from "./erase.js";
import { DAILY_INSPECTION_ITEMS } from "./constants.js";
import { postSummary } from "./inspections.js";

const KEY = "autoInspected";
// uuid.NAMESPACE_URL（RFC 4122）
const NAMESPACE_URL = "6ba7b8119dad11d180b400c04fd430c8";

const allOk = () => Object.fromEntries(DAILY_INSPECTION_ITEMS.map(([n]) => [n, "正常"]));
const dayKey = (serial, date) => `${serial}|${date}`;

/** 自動の記録の識別子（UUID v5。Mac版の inspections.auto_id と同じ値になる）。 */
export async function autoId(serial, date) {
  const ns = Uint8Array.from(NAMESPACE_URL.match(/../g).map((h) => parseInt(h, 16)));
  const name = new TextEncoder().encode(`dji-log:auto-inspection:${serial}:${date}`);
  const buf = new Uint8Array(ns.length + name.length);
  buf.set(ns);
  buf.set(name, ns.length);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-1", buf)).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// 同時に2回走って同じ記録を2回作らないよう、1つずつ行う
let running = Promise.resolve();

/** 飛行のあった日に点検の記録を作る。作った件数を返す。 */
export function autoInspect() {
  const run = running.then(autoInspectNow, autoInspectNow);
  running = run.catch(() => 0);
  return run;
}

async function autoInspectNow() {
  const settings = await db.getSettings();
  const stored = await db.getStoredSettings();
  const done = new Set(Array.isArray(stored[KEY]) ? stored[KEY].map(String) : []);
  const before = done.size;
  const marks = await erase.marks();
  const noGps = db.noGpsRule(settings);
  const local = await db.getAllInspections();
  const aircraft = new Map((await db.getAllAircraft()).map((a) => [a.serial, a]));

  // Macの日誌にある点検（「日×機体」ごと）
  const carry = await db.getCarry();
  const macDays = new Map();
  for (const a of (carry && carry.data && carry.data.aircraft) || []) {
    for (const r of a.daily || []) {
      const k = dayKey(a.serial, String(r.date || ""));
      macDays.set(k, [...(macDays.get(k) || []), r]);
    }
  }

  // Macに手で入れた記録がある日の、このiPhoneの自動の記録（直していないもの）は外す
  for (const r of local) {
    if (!r.auto) continue;
    const mac = macDays.get(dayKey(r.aircraftSerial, r.date)) || [];
    if (mac.some((m) => m.id !== r.id)) await db.deleteInspection(r.id);
  }

  // 飛行のあった「日×機体」と、その日の最初の飛行
  const firsts = new Map();
  const flights = (await db.getAllFlights())
    .filter((f) => f.aircraftSn && f.takeoffTime
      && db.isFlight(f, settings.distanceThresholdM, settings.altitudeThresholdM, noGps))
    .sort((a, b) => String(a.takeoffTime).localeCompare(String(b.takeoffTime)));
  for (const f of flights) {
    const k = dayKey(f.aircraftSn, String(f.takeoffTime).slice(0, 10));
    if (!firsts.has(k)) firsts.set(k, f);
  }

  const current = await db.getAllInspections();
  let added = 0;
  for (const [k, first] of firsts) {
    const serial = first.aircraftSn;
    const date = String(first.takeoffTime).slice(0, 10);
    if (done.has(k) || erase.dayErased(marks, serial, date)) continue;
    done.add(k);
    const mine = current.filter((r) => r.aircraftSerial === serial && r.date === date);
    const mac = macDays.get(k) || [];
    if (mine.length || mac.length) {
      // 手で入れた記録がある日。飛行後点検がどれにも無ければ、このiPhoneの記録に「正常」で入れる
      if ([...mine, ...mac].some((r) => postSummary(r).done)) continue;
      const last = mine[mine.length - 1];
      if (!last || Object.values(last.results || {}).includes("異常")) continue;
      await db.putInspection({ ...last, postResults: allOk(), updatedAt: new Date().toISOString() });
      continue;
    }
    const a = aircraft.get(serial) || {};
    const at = Date.parse(first.takeoffTime);
    await db.putInspection({
      id: await autoId(serial, date),
      aircraftSerial: serial,
      aircraftName: a.name || first.aircraftName || serial,
      date,
      place: first.place || "",
      inspector: settings.pilotName || "",
      results: allOk(), postResults: allOk(), itemRemarks: {}, notes: "",
      auto: true,
      createdAt: new Date().toISOString(),
      // 更新日時は最初の飛行の時刻にする（あとで手で直した記録が、必ず新しい方になる）
      updatedAt: Number.isNaN(at) ? new Date().toISOString() : new Date(at).toISOString(),
      sentAt: "",
    });
    added++;
  }
  if (done.size !== before) await db.setSetting(KEY, [...done].sort());
  return added;
}
