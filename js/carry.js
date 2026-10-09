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
// このiPhoneで記録した日常点検のうち、まだMac版に反映されていないものも
// 一緒に表示する（受け取った日誌と合わせて、点検の記録に抜けが出ないように）。

import {
  CARRY_FORMAT, CARRY_VERSION, DAILY_INSPECTION_ITEMS, ICLOUD_FOLDER,
} from "./constants.js";
import * as db from "./db.js";
import { inspectionSummary } from "./inspections.js";

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
  d.append(s);
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

export async function renderCarry() {
  const box = $("#carry-body");
  box.innerHTML = "";
  const saved = await db.getCarry();
  const local = await db.getAllInspections();

  const info = $("#carry-info");
  if (!saved) {
    info.textContent = "まだMacから受け取っていません。";
    box.append(el("div", "empty",
      `Mac版を起動すると、iCloud Drive の「${ICLOUD_FOLDER}」→「携行用」に`
      + "「飛行日誌_携行用.json」が作られます。上のボタンからそのファイルを選んでください。"));
    return;
  }
  const data = saved.data;
  const age = daysAgo(data.generatedAt);
  info.textContent = `Macで作成: ${fmtStamp(data.generatedAt)}`
    + (age != null ? `（${age === 0 ? "今日" : `${age}日前`}）` : "")
    + ` ／ 受け取り: ${fmtStamp(saved.receivedAt)}`;

  const aircraft = list(data.aircraft);
  if (!aircraft.length) {
    box.append(el("div", "empty", "受け取った日誌に記録がありません。"));
    return;
  }
  if (!aircraft.some((a) => a.serial === selectedSerial)) selectedSerial = str(aircraft[0].serial);

  // 機体ごとに備える日誌なので、機体を選んで見せる
  if (aircraft.length > 1) {
    const pills = el("div", "pills");
    for (const a of aircraft) {
      const b = el("button", `chip${a.serial === selectedSerial ? " active" : ""}`, str(a.label));
      b.onclick = () => { selectedSerial = str(a.serial); renderCarry(); };
      pills.append(b);
    }
    box.append(pills);
  }

  const ac = aircraft.find((a) => a.serial === selectedSerial);
  const head = el("div", "card");
  head.append(el("h2", null, str(ac.label)));
  kv(head, "無人航空機の登録記号", str(ac.registration) || "（未入力）");
  kv(head, "型式", str(ac.model));
  if (!ac.registration) {
    head.append(el("p", "help warn-text",
      "登録記号が未入力です。Mac版の設定画面で入力し、受け取り直してください。"));
  }
  box.append(head);

  // このiPhoneで記録し、まだMacの日誌に入っていない点検も載せる
  const known = new Set(list(ac.daily).map((r) => r.id));
  const localOnly = local.filter((r) => r.aircraftSerial === ac.serial && !known.has(r.id));
  const daily = [
    ...localOnly.map((r) => ({ r, localOnly: true })),
    ...list(ac.daily).map((r) => ({ r, localOnly: false })),
  ].sort((a, b) => str(b.r.date).localeCompare(str(a.r.date)));

  box.append(section("日常点検記録", daily.length, true,
    daily.map(({ r, localOnly: lo }) => dailyCard(r, lo)), "記録はありません。"));
  box.append(section("点検整備記録", list(ac.maintenance).length, true,
    [...list(ac.maintenance)].reverse().map(maintenanceCard), "記録はありません。"));
  box.append(section("飛行記録", list(ac.flights).length, false,
    [...list(ac.flights)].reverse().map(flightCard), "記録はありません。"));
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
