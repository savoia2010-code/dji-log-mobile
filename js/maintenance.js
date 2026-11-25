// 点検整備記録（様式3）。Mac版の「点検整備記録」と同じ項目。
//
// 定期点検・部品交換・修理・改造を行ったときに、このiPhoneで記録し、日常点検と一緒に
// Mac版へ送る（Googleドライブの受信フォルダ）。記録ごとに識別子(id)と更新日時を持たせ、
// Mac版は同じidなら新しい方を採る。Macから届いた日誌にも同じidで入るので、二重には並ばない。
//
// 総飛行時間は、空欄ならMac版が飛行記録から求める。このiPhoneでは、それまでの飛行記録の
// 総飛行時間から暫定の値を出しておく（Macに取り込むと確定する）。
// このiPhoneで消した記録は、Macに送った分はMacに残る（日常点検と同じ）。

import * as db from "./db.js";
import { fillPlace, renderInspections } from "./inspections.js";

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const pad = (n) => String(n).padStart(2, "0");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const isUnsent = (r) => !r.sentAt || r.updatedAt > r.sentAt;
const aircraftLabel = (a) =>
  a.registration ? `${a.name || a.serial}（${a.registration}）` : (a.name || a.serial);

let editing = null;

const fmtMinutes = (min) => `${Math.floor(min / 60)}:${pad(min % 60)}`;
const toMinutes = (text) => {
  const m = /^(\d+):(\d{2})/.exec(String(text || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * 点検整備をした日の総飛行時間（"時:分"）。手入力があればそれ。無ければ、その日までの
 * 飛行の総飛行時間（Macの日誌とこのiPhoneの飛行を合わせたもの）から求めた暫定の値。
 * flights は日誌の様式1の行（date: YYYY-MM-DD, total_time: "時:分" など）。
 */
export function totalTimeAt(record, flights, initialSeconds = 0) {
  if (record.totalFlightSeconds != null) return fmtMinutes(Math.floor(record.totalFlightSeconds / 60));
  let total = null;
  for (const f of flights || []) {
    if (String(f.date) > String(record.date)) continue;
    const t = toMinutes(f.total_time);
    if (t != null) total = t;
  }
  if (total == null) total = Math.floor((Number(initialSeconds) || 0) / 60);
  return `${fmtMinutes(total)}（暫定）`;
}

/** 日誌（様式3）の行の形にする。 */
export function maintenanceRow(r, flights, initialSeconds) {
  return {
    id: r.id, updatedAt: r.updatedAt, date: r.date,
    total_time: totalTimeAt(r, flights, initialSeconds),
    detail: r.detail || "", reason: r.reason || "", place: r.place || "",
    engineer: r.engineer || "", remarks: r.remarks || "",
  };
}

export async function renderMaintenance() {
  const box = $("#maint-list");
  if (!box) return;
  const list = (await db.getAllMaintenance())
    .sort((a, b) => `${b.date}${b.updatedAt}`.localeCompare(`${a.date}${a.updatedAt}`));
  const aircraft = new Map((await db.getAllAircraft()).map((a) => [a.serial, a]));
  box.innerHTML = "";
  for (const r of list) {
    const row = el("div", "row");
    const body = el("div", "body");
    const line1 = el("div", "line1");
    line1.append(el("span", "date", r.date));
    const a = aircraft.get(r.aircraftSerial);
    line1.append(el("span", "meta", a ? aircraftLabel(a) : (r.aircraftName || "機体未選択")));
    line1.append(el("span", `badge ${isUnsent(r) ? "manual" : "muted"}`, isUnsent(r) ? "未送信" : "送信済み"));
    body.append(line1);
    body.append(el("div", "meta", r.detail));
    body.append(el("div", "meta", [r.engineer, r.reason].filter(Boolean).join(" ／ ") || "—"));
    body.onclick = () => openMaintenance(r.id);
    row.append(body);
    box.append(row);
  }
}

function field(label, input, help) {
  const f = el("label", "field", label);
  f.append(input);
  if (help) f.append(el("span", "help", help));
  return f;
}

function textInput(id, value, placeholder = "") {
  const i = el("input");
  i.type = "text"; i.id = id; i.value = value || ""; i.placeholder = placeholder;
  return i;
}

/** 点検整備の記録を開く（id が無ければ新しく記録する）。 */
export async function openMaintenance(id = null, presetSerial = "") {
  const settings = await db.getSettings();
  let r = id ? await db.getMaintenance(id) : null;
  const isNew = !r;
  const aircraft = (await db.getAllAircraft())
    .filter((a) => !a.retired || (r && r.aircraftSerial === a.serial) || a.serial === presetSerial);
  if (!r) {
    const last = aircraft.find((a) => a.serial === presetSerial)
      || aircraft.find((a) => a.serial === settings.lastInspectionAircraft);
    r = {
      id: crypto.randomUUID(), aircraftSerial: last ? last.serial : "", aircraftName: last ? (last.name || last.serial) : "",
      date: today(), totalFlightSeconds: null, detail: "", reason: "", place: "",
      engineer: settings.pilotName || "", remarks: "",
      createdAt: new Date().toISOString(), updatedAt: "", sentAt: "",
    };
  }
  editing = { record: r, isNew };
  $("#maint-title").textContent = isNew ? "点検整備を記録" : r.date;
  const body = $("#maint-body");
  body.innerHTML = "";

  const c1 = el("div", "card");
  c1.append(el("h2", null, "実施"));
  const acSel = el("select");
  acSel.id = "mt-aircraft";
  acSel.append(new Option("選んでください", ""));
  const names = aircraft.map(aircraftLabel);
  aircraft.forEach((a, i) => {
    const dup = names.filter((n) => n === names[i]).length > 1;
    acSel.append(new Option(dup ? `${names[i]}（S/N …${a.serial.slice(-4)}）` : names[i], a.serial));
  });
  acSel.value = r.aircraftSerial;
  c1.append(field("機体", acSel, aircraft.length ? "" : "飛行記録を読み込むと、機体が一覧に出ます。"));
  const dateIn = el("input");
  dateIn.type = "date"; dateIn.id = "mt-date"; dateIn.value = r.date;
  c1.append(field("実施年月日（作業を開始した日）", dateIn));
  const placeIn = textInput("mt-place", r.place, "例: 自宅");
  const placeField = field("実施場所", placeIn);
  const locBtn = el("button", "btn small", "現在地の住所を入れる");
  locBtn.type = "button";
  locBtn.onclick = () => fillPlace(placeIn, locBtn);
  placeField.append(locBtn);
  c1.append(placeField);
  c1.append(field("実施者", textInput("mt-engineer", r.engineer, "作業した人の氏名")));
  body.append(c1);

  const c2 = el("div", "card");
  c2.append(el("h2", null, "内容"));
  const detail = el("textarea");
  detail.id = "mt-detail"; detail.rows = 3; detail.value = r.detail;
  detail.placeholder = "例: プロペラ4枚を交換（純正品）／定期点検を実施";
  c2.append(field("点検、修理、改造及び整備の内容", detail, "部品を交換した場合は、交換した部品名も記入します。"));
  c2.append(field("実施理由", textInput("mt-reason", r.reason, "例: 飛行前点検でプロペラの欠けを発見したため")));
  const remarks = el("textarea");
  remarks.id = "mt-remarks"; remarks.rows = 2; remarks.value = r.remarks;
  remarks.placeholder = "次回予定している点検整備の期限など";
  c2.append(field("備考", remarks));
  body.append(c2);

  const c3 = el("div", "card");
  c3.append(el("h2", null, "総飛行時間"));
  c3.append(el("p", "help",
    "空欄のままにすると、この日までの飛行記録から自動で求めます（Macに送ると確定します）。"
    + "機体認証を受けた機体は、前回の機体認証の検査にあたって行った点検整備以降の時間を入力してください。"));
  const inline = el("div", "inline");
  const hours = el("input");
  hours.type = "number"; hours.min = "0"; hours.step = "1"; hours.id = "mt-hours"; hours.className = "short";
  const minutes = el("input");
  minutes.type = "number"; minutes.min = "0"; minutes.max = "59"; minutes.step = "1"; minutes.id = "mt-minutes";
  minutes.className = "short";
  if (r.totalFlightSeconds != null) {
    hours.value = Math.floor(r.totalFlightSeconds / 3600);
    minutes.value = Math.floor((r.totalFlightSeconds % 3600) / 60);
  }
  inline.append(hours, " 時間 ", minutes, " 分");
  c3.append(inline);
  const estimate = el("p", "help");
  estimate.id = "mt-estimate";
  c3.append(estimate);
  const showEstimate = async () => {
    const { mergedAircraft } = await import("./carry.js");
    const carry = await db.getCarry();
    const a = (await mergedAircraft(carry && carry.data)).find((x) => x.serial === acSel.value);
    const own = (await db.getAllAircraft()).find((x) => x.serial === acSel.value);
    estimate.textContent = acSel.value
      ? `空欄のときの値（暫定）: ${totalTimeAt({ date: dateIn.value, totalFlightSeconds: null },
        a ? a.flights : [], own && own.initialFlightSeconds).replace("（暫定）", "")}`
      : "";
  };
  acSel.onchange = showEstimate;
  dateIn.onchange = showEstimate;
  showEstimate();

  if (!isNew) {
    const del = el("button", "btn danger block", "この点検整備記録を削除");
    del.type = "button";
    del.style.marginTop = "16px";
    del.onclick = async () => {
      if (!confirm(isUnsent(r)
        ? "この点検整備記録を削除します。まだMacに送っていません。よろしいですか？"
        : "この点検整備記録をiPhoneから削除します（Macに送った分は残ります）。よろしいですか？")) return;
      await db.deleteMaintenance(r.id);
      closeMaintenance();
      await afterChange();
    };
    c3.append(del);
  }
  body.append(c3);

  const foot = el("div", "sheet-foot");
  const save2 = el("button", "btn primary block", "保存");
  save2.type = "button";
  save2.onclick = saveMaintenance;
  foot.append(save2);
  body.append(foot);

  $("#maint-editor").hidden = false;
  body.scrollTop = 0;
}

function closeMaintenance() {
  $("#maint-editor").hidden = true;
  editing = null;
}

async function afterChange() {
  await renderMaintenance();
  await renderInspections();   // 「Macへ送る（未送信 ○件）」の数を直す
  const { renderCarry } = await import("./carry.js");
  await renderCarry();
}

async function saveMaintenance() {
  if (!editing) return;
  const r = editing.record;
  const sel = $("#mt-aircraft").value;
  if (!sel) { alert("機体を選んでください。"); return; }
  const date = $("#mt-date").value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { alert("実施年月日を入力してください。"); return; }
  const detail = $("#mt-detail").value.trim();
  if (!detail) { alert("点検、修理、改造及び整備の内容を入力してください。"); return; }
  const h = $("#mt-hours").value.trim();
  const m = $("#mt-minutes").value.trim();
  let total = null;
  if (h !== "" || m !== "") {
    const hh = Number(h || 0), mm = Number(m || 0);
    if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || mm < 0 || mm > 59) {
      alert("総飛行時間を正しく入力してください（分は0〜59）。");
      return;
    }
    total = Math.round(hh * 3600 + mm * 60);
  }
  const a = (await db.getAllAircraft()).find((x) => x.serial === sel);
  Object.assign(r, {
    aircraftSerial: sel, aircraftName: a ? (a.name || a.serial) : sel, date, detail,
    totalFlightSeconds: total,
    reason: $("#mt-reason").value.trim(), place: $("#mt-place").value.trim(),
    engineer: $("#mt-engineer").value.trim(), remarks: $("#mt-remarks").value.trim(),
    updatedAt: new Date().toISOString(),
  });
  await db.putMaintenance(r);
  closeMaintenance();
  await afterChange();
  // Googleドライブ同期を設定していれば、すぐ送る（app.js が受け取る）
  document.dispatchEvent(new Event("inspection-saved"));
}

export function bindMaintenance() {
  $("#maint-new").onclick = () => openMaintenance(null);
  $("#maint-close").onclick = closeMaintenance;
  $("#maint-save").onclick = saveMaintenance;
}
