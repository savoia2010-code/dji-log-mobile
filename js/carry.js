// 飛行日誌の携行・提示。
//
// 取扱要領 4.(7) により、飛行させるときは飛行日誌（飛行記録・日常点検記録・
// 点検整備記録）を常に携行し、求められたら提示できるようにしておく必要がある。
// 5.(3)b) により、点検整備記録は全件を携行する。
//
// 記録の大元はMac版にある。Mac版が iCloud Drive の「dji-log 飛行日誌/携行用」に
// 書き出したファイルをここで受け取り、端末内（IndexedDB）に保存する。
// 受け取ったあとは圏外でも見せられる。
//
// このiPhoneで記録したもののうち、まだMac版に反映されていないものも
// 一緒に表示する（受け取った日誌と合わせて、記録に抜けが出ないように）。
//   - 日常点検: 「点検」タブで記録したもの
//   - 飛行記録: 「記録」タブで DJI Fly の記録を読み込んだもの
// 飛行記録は「飛行させた都度」記載するもの（5.(1)a)）なので、その日の飛行は
// Macに戻るのを待たず、飛行が終わるたびにiPhoneで読み込んでおく。

import {
  CARRY_FORMAT, CARRY_VERSION, DAILY_INSPECTION_ITEMS, ICLOUD_FOLDER, display,
} from "./constants.js";
import * as db from "./db.js";
import { fmtDate, fmtTime, fmtDuration } from "./export.js";
import { formatPlace } from "./geocode.js";
import { inspectionSummary, openInspection } from "./inspections.js";

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const MAX_BYTES = 20 * 1024 * 1024;

let selectedSerial = "";

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const list = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

function fmtStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function daysAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 86400000) : null;
}

// ---------- 受け取り ----------

async function receive(file) {
  if (!file) return;
  if (file.size > MAX_BYTES) { alert("ファイルが大きすぎます。"); return; }
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    alert("Mac版の携行用ファイルではありません。「携行用」フォルダの「飛行日誌_携行用.json」を選んでください。");
    return;
  }
  if (!data || data.format !== CARRY_FORMAT) {
    alert("Mac版の携行用ファイルではありません。「携行用」フォルダの「飛行日誌_携行用.json」を選んでください。");
    return;
  }
  if (data.version !== CARRY_VERSION) {
    alert("対応していない版のファイルです。このアプリを最新にしてください（Safariで開き直すと更新されます）。");
    return;
  }
  const prev = await db.getCarry();
  if (prev && prev.data.generatedAt > data.generatedAt
      && !confirm("いま保存している日誌より古いファイルです。古い方で置き換えますか？")) return;
  await db.putCarry(data);
  await db.mergeAircraftFromMac(list(data.aircraft).map((a) => ({
    serial: str(a.serial), name: str(a.name), registration: str(a.registration), model: str(a.model),
  })));
  await renderCarry();
  alert(`受け取りました（Macで ${fmtStamp(data.generatedAt)} に作成）。`);
}

// ---------- 表示 ----------

function kv(parent, label, value) {
  if (!value) return;
  const row = el("div", "kv");
  row.append(el("span", "label", label), el("span", null, value));
  parent.append(row);
}

function dailyCard(r, localOnly) {
  const d = el("details", "rec");
  const s = el("summary");
  s.append(el("span", "date", str(r.date)));
  const sum = inspectionSummary(obj(r.results));
  s.append(el("span", `badge ${sum.cls}`, sum.text));
  if (localOnly) s.append(el("span", "badge manual", "iPhoneのみ"));
  d.append(s);
  kv(d, "実施場所", str(r.place));
  kv(d, "実施者", str(r.inspector));
  const table = el("div", "items");
  const results = obj(r.results);
  const remarks = obj(r.itemRemarks);
  for (const [name] of DAILY_INSPECTION_ITEMS) {
    const row = el("div", "item");
    row.append(el("span", null, name));
    const res = str(results[name]) || "未記入";
    row.append(el("span", res === "異常" ? "ng" : res === "正常" ? "okt" : "muted", res));
    table.append(row);
    if (remarks[name]) table.append(el("div", "item-remark", `└ ${str(remarks[name])}`));
  }
  d.append(table);
  kv(d, "特記事項", str(r.notes));
  return d;
}

function maintenanceCard(m) {
  const d = el("details", "rec");
  d.open = true;
  const s = el("summary");
  s.append(el("span", "date", str(m.date)));
  s.append(el("span", "meta", str(m.detail)));
  d.append(s);
  kv(d, "総飛行時間", str(m.total_time));
  kv(d, "実施理由", str(m.reason));
  kv(d, "実施場所", str(m.place));
  kv(d, "実施者", str(m.engineer));
  kv(d, "備考", str(m.remarks));
  return d;
}

function flightCard(f) {
  const d = el("details", "rec");
  const s = el("summary");
  s.append(el("span", "date", str(f.date)));
  s.append(el("span", "meta",
    `${str(f.takeoff_time)}〜${str(f.landing_time)}（${str(f.duration)}）`));
  if (f.localOnly) s.append(el("span", "badge manual", "iPhoneのみ"));
  d.append(s);
  if (f.localOnly) {
    d.append(el("p", "help",
      "このiPhoneで読み込んだ飛行です。総飛行時間はMacの記録の続きから数えた暫定値で、"
      + "Macに取り込むと確定します。"));
  }
  kv(d, "飛行させた者", str(f.pilot));
  kv(d, "飛行概要", [str(f.purpose), str(f.specified_flight)].filter(Boolean).join(" ／ 特定飛行: "));
  kv(d, "飛行経路", str(f.route));
  kv(d, "離陸場所", str(f.takeoff_place));
  kv(d, "着陸場所", str(f.landing_place));
  kv(d, "総飛行時間", str(f.total_time));
  kv(d, "飛行の安全に影響のあった事項", str(f.issues));
  kv(d, "対応", str(f.issue_response));
  kv(d, "記事", str(f.remarks));
  return d;
}

function section(title, count, open, cards, emptyText) {
  const d = el("details", "card section");
  d.open = open;
  d.append(el("summary", "section-title", `${title}（${count}件）`));
  if (!cards.length) d.append(el("p", "help", emptyText));
  for (const c of cards) d.append(c);
  return d;
}

const today = () => fmtDate(new Date().toISOString());
const sortKey = (date, time) => `${str(date)} ${str(time)}`;
const toMinutes = (hm) => {
  const m = /^(\d+):(\d{2})$/.exec(str(hm));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const fmtMinutes = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;

/**
 * このiPhoneで読み込んだ飛行のうち、Macの日誌にまだ無いものを様式1の形にする。
 * 総飛行時間は、Macの日誌の最後の飛行の値に足していく（Macと同じく1飛行ごとに
 * 分へ切り捨ててから足す）。Macの最後の飛行より前の飛行は足し方が決まらないので
 * 空欄にし、Macに取り込んだときに確定させる。
 */
function localFlightRows(localFlights, macFlights, settings, aircraft) {
  const known = new Set(macFlights.map((f) => f.file));
  const last = macFlights[macFlights.length - 1];
  const lastKey = last ? sortKey(last.date, last.takeoff_time) : "";
  let total = last ? toMinutes(last.total_time)
    : db.floorMinutes((aircraft && aircraft.initialFlightSeconds) || 0);

  const rows = [];
  const mine = localFlights
    .filter((f) => !known.has(f.fileName)
      && db.isFlight(f, settings.distanceThresholdM, settings.altitudeThresholdM))
    .sort((a, b) => a.takeoffTime.localeCompare(b.takeoffTime));
  for (const f of mine) {
    const date = fmtDate(f.takeoffTime);
    const time = fmtTime(f.takeoffTime);
    let totalText = "";
    if (total != null && sortKey(date, time) > lastKey) {
      total += db.floorMinutes(f.durationSeconds);
      totalText = `${fmtMinutes(total)}（暫定）`;
    }
    const place = formatPlace(f.place, f.lat, f.lon);
    rows.push({
      file: f.fileName, date, takeoff_time: time, landing_time: fmtTime(f.landingTime),
      duration: fmtDuration(f.durationSeconds), total_time: totalText,
      pilot: settings.pilotName || "", purpose: display(f.purpose),
      specified_flight: display(f.specifiedFlight), route: f.route || "",
      takeoff_place: place, landing_place: place,
      issues: f.issues || "", issue_response: f.issueResponse || "", remarks: f.remarks || "",
      localOnly: true,
    });
  }
  return rows;
}

/** Macの日誌とこのiPhoneの記録を、機体ごとに合わせる。 */
async function mergedAircraft(data) {
  const settings = await db.getSettings();
  const localAircraft = await db.getAllAircraft();
  const localFlights = await db.getAllFlights();
  const localInspections = await db.getAllInspections();
  const bySerial = new Map(localAircraft.map((a) => [a.serial, a]));

  const out = list(data && data.aircraft).map((a) => ({
    serial: str(a.serial), label: str(a.label), registration: str(a.registration),
    model: str(a.model), flights: list(a.flights), daily: list(a.daily),
    maintenance: list(a.maintenance),
  }));
  // Macの日誌に無い機体でも、このiPhoneに記録があれば載せる
  const serials = new Set([
    ...localFlights.map((f) => f.aircraftSn), ...localInspections.map((r) => r.aircraftSerial),
  ].filter(Boolean));
  for (const serial of serials) {
    if (out.some((a) => a.serial === serial)) continue;
    const a = bySerial.get(serial) || {};
    out.push({
      serial, label: a.name || serial, registration: a.registration || "",
      model: a.model || "", flights: [], daily: [], maintenance: [],
    });
  }

  for (const a of out) {
    const knownDaily = new Set(a.daily.map((r) => r.id));
    a.daily = [
      ...localInspections.filter((r) => r.aircraftSerial === a.serial && !knownDaily.has(r.id))
        .map((r) => ({ ...r, localOnly: true })),
      ...a.daily,
    ].sort((x, y) => str(y.date).localeCompare(str(x.date)));
    a.flights = [
      ...a.flights,
      ...localFlightRows(localFlights.filter((f) => f.aircraftSn === a.serial),
        a.flights, settings, bySerial.get(a.serial)),
    ];
  }
  return out;
}

/** 今日の点検と飛行が記録されているかを、いちばん上に示す。 */
function todayCard(aircraft, currentSerial) {
  const day = today();
  const inspected = aircraft.filter((a) => a.daily.some((r) => r.date === day));
  const flown = aircraft.map((a) => ({ a, n: a.flights.filter((f) => f.date === day).length }))
    .filter((x) => x.n);
  const card = el("div", "card today");
  card.append(el("h2", null, `今日（${day}）の記録`));

  const insp = el("div", "today-row");
  insp.append(el("span", "label", "日常点検"));
  if (inspected.length) {
    insp.append(el("span", "okt", `記録あり（${inspected.map((a) => a.label).join("、")}）`));
  } else {
    insp.append(el("span", flown.length ? "ng" : "muted",
      flown.length ? "記録がありません" : "まだありません"));
  }
  card.append(insp);
  // 飛行したのに点検の記録が無い機体は、はっきり知らせる
  const missing = flown.filter((x) => !inspected.includes(x.a));
  if (missing.length) {
    card.append(el("p", "help warn-text",
      `${missing.map((x) => x.a.label).join("、")} は今日飛行していますが、日常点検の記録がありません。`));
  }

  const fl = el("div", "today-row");
  fl.append(el("span", "label", "飛行記録"));
  const total = flown.reduce((n, x) => n + x.n, 0);
  fl.append(el("span", total ? "okt" : "muted", total ? `${total}件` : "まだありません"));
  card.append(fl);

  card.append(el("p", "help",
    "飛行の前に「点検」タブで日常点検を記録し、飛行が終わるたびに「記録」タブの"
    + "「飛行記録を読み込む」で DJI Fly の記録を取り込んでください。"
    + "取り込んだ飛行はここに「iPhoneのみ」として並びます。"));

  const actions = el("div", "today-actions");
  const b1 = el("button", "btn small", "点検を記録する");
  // 今日飛んだのに点検の記録が無い機体、なければ表示中の機体を選んだ状態で開く
  const preset = (missing[0] && missing[0].a.serial) || currentSerial || "";
  b1.onclick = () => {
    document.querySelector('.tab-btn[data-view="inspections"]').click();
    openInspection(null, preset);
  };
  const b2 = el("button", "btn small", "飛行記録を読み込む");
  // 読み込みの進み具合は「記録」タブに出るので、そちらに切り替えてから選ばせる
  b2.onclick = () => {
    document.querySelector('.tab-btn[data-view="list"]').click();
    document.getElementById("file-input").click();
  };
  actions.append(b1, b2);
  card.append(actions);
  return card;
}

export async function renderCarry() {
  const box = $("#carry-body");
  box.innerHTML = "";
  const saved = await db.getCarry();
  const aircraft = await mergedAircraft(saved && saved.data);

  const info = $("#carry-info");
  if (saved) {
    const data = saved.data;
    const age = daysAgo(data.generatedAt);
    info.textContent = `Macで作成: ${fmtStamp(data.generatedAt)}`
      + (age != null ? `（${age === 0 ? "今日" : `${age}日前`}）` : "")
      + ` ／ 受け取り: ${fmtStamp(saved.receivedAt)}`;
  } else {
    info.textContent = "まだMacから受け取っていません（このiPhoneの記録だけを表示しています）。"
      + ` Mac版を起動すると、iCloud Drive の「${ICLOUD_FOLDER}」→「携行用」に`
      + "「飛行日誌_携行用.json」が作られます。";
  }

  if (aircraft.length && !aircraft.some((a) => a.serial === selectedSerial)) {
    // 今日飛んだ機体があればそれを、なければ先頭を表示する
    const flewToday = aircraft.find((a) => a.flights.some((f) => f.date === today()));
    selectedSerial = (flewToday || aircraft[0]).serial;
  }
  box.append(todayCard(aircraft, selectedSerial));
  if (!aircraft.length) {
    box.append(el("div", "empty", "表示できる記録がまだありません。"));
    return;
  }

  // 機体ごとに備える日誌なので、機体を選んで見せる
  if (aircraft.length > 1) {
    const pills = el("div", "pills");
    for (const a of aircraft) {
      const b = el("button", `chip${a.serial === selectedSerial ? " active" : ""}`, a.label);
      b.onclick = () => { selectedSerial = a.serial; renderCarry(); };
      pills.append(b);
    }
    box.append(pills);
  }

  const ac = aircraft.find((a) => a.serial === selectedSerial);
  const head = el("div", "card");
  head.append(el("h2", null, ac.label));
  kv(head, "無人航空機の登録記号", ac.registration || "（未入力）");
  kv(head, "型式", ac.model);
  if (!ac.registration) {
    head.append(el("p", "help warn-text",
      "登録記号が未入力です。Mac版の設定画面で入力し、受け取り直してください。"));
  }
  box.append(head);

  box.append(section("日常点検記録", ac.daily.length, true,
    ac.daily.map((r) => dailyCard(r, !!r.localOnly)), "記録はありません。"));
  box.append(section("点検整備記録", ac.maintenance.length, true,
    [...ac.maintenance].reverse().map(maintenanceCard), "記録はありません。"));
  // 今日の分はすぐ見せられるよう、今日飛んだ機体なら飛行記録も開いておく
  const flewToday = ac.flights.some((f) => f.date === today());
  box.append(section("飛行記録", ac.flights.length, flewToday,
    [...ac.flights].reverse().map(flightCard), "記録はありません。"));
}

// ---------- 記録を消されないための対策 ----------

// ホーム画面に追加したアプリとして開いているか
const isInstalled = () =>
  window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

/**
 * 法定の記録を端末内に置くので、ブラウザに消されないよう保存の継続を求める。
 * Safariで開いているだけだと、しばらく使わないうちにサイトのデータが
 * 消されることがある。ホーム画面に追加して使ってもらうよう案内する。
 */
export async function protectStorage() {
  let persisted = false;
  try {
    if (navigator.storage && navigator.storage.persist) {
      persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    }
  } catch { /* 対応していない環境では案内だけ出す */ }
  const warn = !isInstalled() && !persisted;
  for (const n of document.querySelectorAll(".install-warning")) n.hidden = !warn;
  return { installed: isInstalled(), persisted };
}

export function bindCarry() {
  $("#carry-input").onchange = (e) => { receive(e.target.files[0]); e.target.value = ""; };
}
