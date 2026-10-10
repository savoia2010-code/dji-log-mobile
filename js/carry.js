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
import { inspectionSummary, openInspection, postSummary } from "./inspections.js";
import { submitSection } from "./submit.js";

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
  await acceptCarry(data);
  alert(`受け取りました（Macで ${fmtStamp(data.generatedAt)} に作成）。`);
}

/**
 * 携行用の日誌を保存する（ファイルで受け取ったときと、Googleドライブから
 * 自動で受け取ったときの共通の入口）。形式が違えば false を返して何もしない。
 */
export async function acceptCarry(data) {
  if (!data || data.format !== CARRY_FORMAT || data.version !== CARRY_VERSION) return false;
  await db.putCarry(data);
  await db.mergeAircraftFromMac(list(data.aircraft).map((a) => ({
    serial: str(a.serial), name: str(a.name), registration: str(a.registration), model: str(a.model),
  })));
  if (await applyCriteria(obj(data.criteria))) document.dispatchEvent(new Event("criteria-changed"));
  await renderCarry();
  return true;
}

/**
 * Mac版の「飛行とみなす距離・高度」が、このiPhoneで変えたときより新しければ合わせる。
 * 合わせたら true。
 */
async function applyCriteria(c) {
  const theirs = Date.parse(str(c.updatedAt));
  if (Number.isNaN(theirs)) return false;
  const s = await db.getSettings();
  const mine = Date.parse(str(s.criteriaUpdatedAt));
  if (!Number.isNaN(mine) && mine >= theirs) return false;
  const dist = Number(c.distanceThresholdM);
  const alt = Number(c.altitudeThresholdM);
  if (Number.isFinite(dist) && dist >= 0) await db.setSetting("distanceThresholdM", dist);
  if (Number.isFinite(alt) && alt >= 0) await db.setSetting("altitudeThresholdM", alt);
  await db.setSetting("criteriaUpdatedAt", str(c.updatedAt));
  return true;
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
  const post = postSummary({ postResults: obj(r.postResults), notes: str(r.notes) });
  s.append(el("span", `badge ${sum.cls}`, `飛行前：${sum.text}`));
  s.append(el("span", `badge ${post.cls}`, `飛行後：${post.text}`));
  if (localOnly) s.append(el("span", "badge manual", "iPhoneのみ"));
  d.append(s);
  kv(d, "実施場所", str(r.place));
  kv(d, "実施者", str(r.inspector));
  const table = el("div", "items");
  const results = obj(r.results);
  const postResults = obj(r.postResults);
  const remarks = obj(r.itemRemarks);
  const head = el("div", "item item-head");
  head.append(el("span", null, "点検項目"), el("span", "muted", "飛行前 ／ 飛行後"));
  table.append(head);
  const resSpan = (v, empty) => {
    const res = str(v) || empty;
    return el("span", res === "異常" ? "ng" : res === "正常" ? "okt" : "muted", res);
  };
  for (const [name] of DAILY_INSPECTION_ITEMS) {
    const row = el("div", "item");
    row.append(el("span", null, name));
    const both = el("span");
    both.append(resSpan(results[name], "未記入"), document.createTextNode(" ／ "),
      resSpan(postResults[name], "—"));
    row.append(both);
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
  // 具備資料だけがある機体（まだ飛ばしていない機体など）も載せる
  for (const [serial, d] of Object.entries(obj(data && data.documents && data.documents.aircraft))) {
    if (!out.some((a) => a.serial === serial)) {
      out.push({ serial, label: str(d.label) || serial, registration: str(d.registration),
        model: str(obj(d.spec).name), flights: [], daily: [], maintenance: [] });
    }
  }
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
    // Macから届いたあとにこのiPhoneで直した記録（飛行後点検を足したなど）は、手元の方を見せる
    const localById = new Map(localInspections.map((r) => [r.id, r]));
    const time = (v) => { const t = Date.parse(v || ""); return Number.isNaN(t) ? 0 : t; };
    a.daily = a.daily.map((r) => {
      const mine = localById.get(r.id);
      return mine && time(mine.updatedAt) >= time(r.updatedAt) ? { ...mine, local: true } : r;
    });
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
function todayCard(aircraft, currentSerial, documents) {
  const day = today();
  const inspected = aircraft.filter((a) => a.daily.some((r) => r.date === day));
  const flown = aircraft.map((a) => ({ a, n: a.flights.filter((f) => f.date === day).length }))
    .filter((x) => x.n);
  const card = el("div", "card today");
  card.append(el("h2", null, `今日（${day}）の記録`));

  const insp = el("div", "today-row");
  insp.append(el("span", "label", "飛行前点検"));
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

  // 飛行後点検：今日の点検の記録のうち、飛行後の点検がまだのもの
  const todays = aircraft.flatMap((a) => a.daily.filter((r) => r.date === day)
    .map((r) => ({ a, r, post: postSummary({ postResults: obj(r.postResults), notes: str(r.notes) }) })));
  const postPending = todays.filter((x) => !x.post.done);
  if (todays.length) {
    const pr2 = el("div", "today-row");
    pr2.append(el("span", "label", "飛行後点検"));
    if (!postPending.length) {
      pr2.append(el("span", "okt", "記録あり"));
    } else {
      pr2.append(el("span", flown.length ? "ng" : "muted",
        `まだです（${postPending.map((x) => x.a.label).join("、")}）`));
    }
    card.append(pr2);
    if (postPending.length && flown.length) {
      card.append(el("p", "help", "その日の飛行を終えたら、飛行後の点検をして記録してください。"));
    }
  }

  // 許可書・承認書（審査要領 4-(18) により携行する）
  const permit = latestPermit(documents);
  const pr = el("div", "today-row");
  pr.append(el("span", "label", "許可書"));
  if (!permit) {
    pr.append(el("span", "muted", "登録なし"));
  } else {
    const e = expiryState(permit.valid_to);
    pr.append(el("span", e.state === "expired" ? "ng" : e.state === "soon" ? "ng" : "okt",
      e.state === "expired" ? `期限切れ（${permit.valid_to}まで）`
        : `${permit.valid_to ? `${permit.valid_to}まで` : "期間未入力"}`
          + (e.state === "soon" ? `（あと${e.days}日）` : "")));
  }
  card.append(pr);

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
  // ファイル選択をスクリプトから開くと、Safariでは無視されることがある。
  // 「記録」タブのボタン（実機で動いている）と同じく、同じ画面の入力を label で開く。
  const b2 = el("label", "btn small", "飛行記録を読み込む");
  b2.htmlFor = "carry-flight-input";
  actions.append(b1);
  // このiPhoneで記録した今日の点検に、飛行後点検を足す（Macで作った記録はMacで直す）
  const own = postPending.find((x) => x.r.localOnly || x.r.local);
  if (own) {
    const b3 = el("button", "btn small", "飛行後点検を記録する");
    b3.onclick = () => {
      document.querySelector('.tab-btn[data-view="inspections"]').click();
      openInspection(own.r.id, "", { phase: "post" });
    };
    actions.append(b3);
  }
  actions.append(b2);
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
    // 古いまま持ち歩いていると、Macで直した内容や点検整備の記録が抜ける
    if (age != null && age >= 7) {
      box.append(el("div", "card stale-warning",
        `Macから受け取った日誌が${age}日前のものです。Macで記録を更新していれば、`
        + "「Macから受け取る」で受け取り直してください。"));
    }
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
  const todayBox = $("#carry-today");
  todayBox.innerHTML = "";
  todayBox.append(todayCard(aircraft, selectedSerial, saved && saved.data.documents));
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

  const documents = saved && saved.data.documents;
  const doc = documents && obj(documents.aircraft)[ac.serial];
  // 提示・提出を求められたときに、すぐ出せるよう上の方に置く
  box.append(submitSection(ac, documents));
  box.append(documentsSection(documents, doc));
  box.append(permitsSection(documents));

  box.append(section("日常点検記録", ac.daily.length, true,
    ac.daily.map((r) => dailyCard(r, !!r.localOnly)), "記録はありません。"));
  box.append(section("点検整備記録", ac.maintenance.length, true,
    [...ac.maintenance].reverse().map(maintenanceCard), "記録はありません。"));
  // 今日の分はすぐ見せられるよう、今日飛んだ機体なら飛行記録も開いておく
  const flewToday = ac.flights.some((f) => f.date === today());
  box.append(section("飛行記録", ac.flights.length, flewToday,
    [...ac.flights].reverse().map(flightCard), "記録はありません。"));
}

// ---------- 具備資料 ----------

function expiryState(validTo) {
  if (!validTo) return { state: "unknown", days: null };
  const end = new Date(`${validTo}T23:59:59`);
  const days = Math.floor((end - new Date()) / 86400000);
  return { state: days < 0 ? "expired" : days <= 30 ? "soon" : "ok", days };
}

function latestPermit(documents) {
  const dated = list(documents && documents.permits).filter((p) => p.valid_to);
  if (!dated.length) return list(documents && documents.permits)[0] || null;
  return dated.reduce((a, b) => (str(a.valid_to) >= str(b.valid_to) ? a : b));
}

function photo(src, caption) {
  const fig = el("figure", "doc-photo");
  if (src && str(src).startsWith("data:image/")) {
    const img = el("img");
    img.src = src; img.alt = caption; img.loading = "lazy";
    // 提示するときに見やすいよう、押すと画面いっぱいに出す
    img.onclick = () => showLarge(src, caption);
    fig.append(img);
  } else {
    fig.append(el("div", "doc-photo-none", "なし"));
  }
  fig.append(el("figcaption", null, caption));
  return fig;
}

function showLarge(src, caption) {
  const overlay = el("div", "photo-overlay");
  const img = el("img");
  img.src = src; img.alt = caption;
  overlay.append(img, el("div", "photo-overlay-caption", `${caption}（タップで閉じる）`));
  overlay.onclick = () => overlay.remove();
  document.body.append(overlay);
}

/** 機体ごとの具備資料（製造者・名称・重量等／運用限界等／追加基準への適合性）。 */
function documentsSection(documents, doc) {
  const d = el("details", "card section");
  d.append(el("summary", "section-title", "具備資料（機体）"));
  if (!doc) {
    d.append(el("p", "help", "この機体の具備資料はまだありません。Mac版の「具備資料」で作ると、受け取ったときにここに入ります。"));
    return d;
  }
  const spec = obj(doc.spec);
  const photos = obj(doc.photos);
  const slots = obj(documents.photo_slots);

  d.append(el("h3", "doc-title", "無人航空機の製造者、名称、重量等"));
  kv(d, "登録記号", str(doc.registration) || "（未入力）");
  for (const [key, label] of list(documents.spec_fields)) kv(d, str(label), str(spec[key]));
  const g1 = el("div", "doc-photos");
  for (const slot of ["front", "top", "side", "controller"]) g1.append(photo(photos[slot], str(slots[slot])));
  d.append(g1);

  d.append(el("h3", "doc-title", "無人航空機の運用限界等"));
  for (const [key, label] of list(documents.limit_fields)) {
    kv(d, str(label), str(spec[key]) || (key === "max_payload_kg" ? "記載なし" : ""));
  }
  const g2 = el("div", "doc-photos");
  for (const slot of ["ops_body", "ops_video", "ops_controller"]) g2.append(photo(photos[slot], str(slots[slot]).replace("運用限界：", "")));
  d.append(g2);
  kv(d, "飛行させる方法", str(spec.flight_method));

  const cats = list(doc.categories);
  if (cats.length) {
    d.append(el("h3", "doc-title", "無人航空機の追加基準への適合性"));
    for (const c of cats) {
      d.append(el("div", "doc-cat", `○${str(c.heading)}`));
      for (const r of list(c.requirements)) {
        const box = el("div", "doc-req");
        box.append(el("div", "doc-std", str(r.standard)));
        box.append(el("div", "doc-comp", str(r.compliance) || "（未入力）"));
        const p = photos[`req:${str(r.id)}`];
        if (p) box.append(photo(p, "適合性を示す写真"));
        d.append(box);
      }
    }
    d.append(el("p", "help", "基準は「無人航空機の飛行に関する許可・承認の審査要領（カテゴリーⅡ飛行）」5. による。"));
  }
  return d;
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

/** 許可書・承認書（PDFを開ける）と保険。 */
function permitsSection(documents) {
  const d = el("details", "card section");
  const permits = list(documents && documents.permits);
  const insurance = list(documents && documents.insurance);
  d.append(el("summary", "section-title", `許可書・承認書と保険（${permits.length + insurance.length}件）`));
  if (!permits.length) d.append(el("p", "help", "許可書・承認書は登録されていません。"));
  for (const p of permits) {
    const box = el("div", "rec");
    const e = expiryState(str(p.valid_to));
    const head = el("div", "line1");
    head.append(el("span", "date", str(p.number) || "許可書・承認書"));
    if (e.state === "expired") head.append(el("span", "badge warn", "期限切れ"));
    else if (e.state === "soon") head.append(el("span", "badge manual", `あと${e.days}日`));
    box.append(head);
    kv(box, "期間", `${str(p.valid_from)}〜${str(p.valid_to)}`);
    kv(box, "内容", str(p.note));
    if (p.pdf) {
      const actions = el("div", "today-actions");
      const name = str(p.file_name) || "許可書.pdf";
      // 開くのはブラウザの表示に任せる。開けない環境では「共有・保存」から見られる
      const open = el("button", "btn small", "許可書のPDFを開く");
      open.onclick = () => {
        const url = URL.createObjectURL(base64ToBlob(str(p.pdf), "application/pdf"));
        window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      };
      const share = el("button", "btn small", "共有・保存");
      share.onclick = async () => {
        const file = new File([base64ToBlob(str(p.pdf), "application/pdf")], name, { type: "application/pdf" });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], title: name }); } catch { /* 取りやめ */ }
        } else {
          alert("この端末では共有できません。「許可書のPDFを開く」を使ってください。");
        }
      };
      actions.append(open, share);
      box.append(actions);
    }
    d.append(box);
  }
  if (insurance.length) d.append(el("h3", "doc-title", "第三者賠償責任保険"));
  for (const i of insurance) {
    const box = el("div", "rec");
    const e = expiryState(str(i.valid_to));
    const head = el("div", "line1");
    head.append(el("span", "date", str(i.company)));
    if (e.state === "expired") head.append(el("span", "badge warn", "期限切れ"));
    box.append(head);
    kv(box, "証券番号", str(i.policy_number));
    kv(box, "対人／対物", `${str(i.bodily) || "—"}／${str(i.property) || "—"}`);
    kv(box, "期間", `${str(i.valid_from)}〜${str(i.valid_to)}`);
    kv(box, "対象など", str(i.note));
    d.append(box);
  }
  return d;
}

// ---------- 記録を消されないための対策 ----------

// ホーム画面に追加したアプリとして開いているか
export const isInstalled = () =>
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
