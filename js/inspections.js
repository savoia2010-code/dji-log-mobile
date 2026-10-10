// 日常点検記録（様式2）。
//
// 点検は飛行前と飛行後に現場で行うので、iPhoneで記録しておき、あとからMac版へ送る。
// 飛行前（results）と飛行後（postResults）は同じ点検項目で、1日・1機体で1件の記録にまとめる。
// このアプリはインターネット上に置かれ、Mac版はMacの中で動くため直接は
// つながらない。そこで記録をファイルに書き出し、共有メニューから
// iCloud Drive の「dji-log 飛行日誌」フォルダに保存してもらう。Mac版がその
// フォルダを見に行って取り込む。
//
// 記録ごとに識別子(id)と更新日時を持たせ、Mac版は同じidなら新しい方を採る。
// 同じファイルを何度送っても重複しない。

import {
  DAILY_INSPECTION_ITEMS, INSPECTION_RESULTS, POST_FLIGHT_WORD, SYNC_FORMAT, SYNC_VERSION,
} from "./constants.js";
import * as db from "./db.js";
import { reverseGeocode } from "./geocode.js";

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
const OTHER = "__other__";

// 送った後に直した記録も「未送信」として扱う
const isUnsent = (r) => !r.sentAt || r.updatedAt > r.sentAt;

let editing = null;

export function inspectionSummary(results) {
  const r = { results };
  const abnormal = DAILY_INSPECTION_ITEMS.map(([n]) => n).filter((n) => r.results[n] === "異常");
  if (abnormal.length) return { text: `異常あり（${abnormal.join("、")}）`, cls: "warn" };
  const blank = DAILY_INSPECTION_ITEMS.filter(([n]) => !r.results[n]).length;
  if (blank) return { text: `未記入 ${blank}項目`, cls: "muted" };
  return { text: "全項目 正常", cls: "ok" };
}

/** 飛行後点検のまとめ。done は記録があるか（特記事項に書いた古い記録も含む）。 */
export function postSummary(r) {
  const post = r && r.postResults && typeof r.postResults === "object" ? r.postResults : {};
  if (Object.keys(post).length) return { ...inspectionSummary(post), done: true };
  if (String((r && r.notes) || "").includes(POST_FLIGHT_WORD)) {
    return { text: "特記事項に記載", cls: "ok", done: true };
  }
  return { text: "未記録", cls: "muted", done: false };
}

const allOk = () => Object.fromEntries(DAILY_INSPECTION_ITEMS.map(([n]) => [n, "正常"]));

const aircraftLabel = (a) =>
  a.registration ? `${a.name || a.serial}（${a.registration}）` : (a.name || a.serial);

// ---------- 一覧 ----------

export async function renderInspections() {
  const list = (await db.getAllInspections())
    .sort((a, b) => (b.date + b.updatedAt).localeCompare(a.date + a.updatedAt));
  const unsent = list.filter(isUnsent).length;

  $("#insp-send").textContent = unsent ? `Macへ送る（未送信 ${unsent}件）` : "Macへ送る";
  $("#insp-send-help").textContent = unsent
    ? "共有メニューの「\"ファイル\"に保存」から、iCloud Drive の「dji-log 飛行日誌」フォルダに保存してください。Mac版が自動で取り込みます。"
    : "すべて送信済みです。";

  const box = $("#insp-list");
  box.innerHTML = "";
  if (!list.length) {
    box.append(el("div", "empty", "点検の記録はまだありません。"));
    return;
  }
  for (const r of list) {
    const row = el("div", "row");
    const body = el("div", "body");
    const line1 = el("div", "line1");
    line1.append(el("span", "date", r.date));
    line1.append(el("span", "meta", r.aircraftName || "機体未選択"));
    line1.append(el("span", `badge ${isUnsent(r) ? "manual" : "muted"}`,
      isUnsent(r) ? "未送信" : "送信済み"));
    body.append(line1);
    const s = inspectionSummary(r.results);
    const p = postSummary(r);
    const line2 = el("div", "line1");
    line2.append(el("span", `badge ${s.cls}`, `飛行前：${s.text}`));
    line2.append(el("span", `badge ${p.cls}`, `飛行後：${p.text}`));
    body.append(line2);
    body.append(el("div", "meta", [r.inspector, r.place].filter(Boolean).join(" ／ ") || "—"));
    body.onclick = () => openInspection(r.id, "", { phase: p.done ? "pre" : "post" });
    row.append(body);
    if (!p.done) {
      // 飛ばし終えたら、ここから1回で飛行後点検を記録できるようにする
      const quick = el("button", "btn small", "飛行後も全項目正常");
      quick.type = "button";
      quick.className = "btn small post-ok";
      quick.onclick = async () => {
        if (!confirm(`${r.date} の飛行後点検を「全項目 正常」で記録します。`
          + "実際に点検を行い、異常がなかった場合だけ記録してください。")) return;
        await recordPostAllOk(r.id);
      };
      row.append(quick);
    }
    box.append(row);
  }
}

// ---------- 入力 ----------

/** 飛行後点検を全項目「正常」で記録する（飛行前の記録はそのまま）。 */
export async function recordPostAllOk(id) {
  const r = await db.getInspection(id);
  if (!r) return;
  r.postResults = allOk();
  r.updatedAt = new Date().toISOString();
  await db.putInspection(r);
  await renderInspections();
  document.dispatchEvent(new Event("inspection-saved"));
}

/**
 * 点検の記録を開く。phase は最初に見せる点検（"pre" 飛行前／"post" 飛行後）。
 * 飛行前の記録がある日にもう一度開くのは、たいてい飛行後の点検を記録するとき。
 */
export async function openInspection(id, presetSerial = "", { phase = "" } = {}) {
  const settings = await db.getSettings();
  const aircraft = await db.getAllAircraft();
  let r = id ? await db.getInspection(id) : null;
  const isNew = !r;
  if (!r) {
    // 機体は、呼び出し元の指定（今日飛ばした機体など）か、前回点検した機体を初期値にする
    const last = aircraft.find((a) => a.serial === presetSerial)
      || aircraft.find((a) => a.serial === settings.lastInspectionAircraft);
    r = {
      id: crypto.randomUUID(),
      aircraftSerial: last ? last.serial : "",
      aircraftName: last ? (last.name || last.serial) : "",
      date: today(), place: "", inspector: settings.pilotName || "",
      results: {}, postResults: {}, itemRemarks: {}, notes: "",
      createdAt: new Date().toISOString(), updatedAt: "", sentAt: "",
    };
  }
  if (!r.postResults || typeof r.postResults !== "object") r.postResults = {};
  editing = { record: r, isNew };
  if (!phase) phase = !isNew && Object.keys(r.results || {}).length ? "post" : "pre";

  $("#insp-title").textContent = isNew ? "日常点検を記録" : r.date;
  const body = $("#insp-body");
  body.innerHTML = "";

  // 実施
  const c1 = el("div", "card");
  c1.append(el("h2", null, "実施"));

  const acField = el("label", "field", "機体");
  const acSel = el("select");
  acSel.id = "in-aircraft";
  acSel.append(new Option("選んでください", ""));
  const names = aircraft.map(aircraftLabel);
  aircraft.forEach((a, i) => {
    // 登録記号が未入力で同じ型式の機体が2台あると見分けられないので、シリアル末尾を添える
    const dup = names.filter((n) => n === names[i]).length > 1;
    acSel.append(new Option(dup ? `${names[i]}（S/N …${a.serial.slice(-4)}）` : names[i], a.serial));
  });
  acSel.append(new Option("一覧にない機体（名前を入力）", OTHER));
  acSel.value = r.aircraftSerial || (r.aircraftName ? OTHER : "");
  const acName = el("input");
  acName.type = "text"; acName.id = "in-aircraft-name";
  acName.placeholder = "例: DJI Mini 4 Pro";
  acName.value = r.aircraftSerial ? "" : r.aircraftName;
  acName.hidden = acSel.value !== OTHER;
  acSel.onchange = () => { acName.hidden = acSel.value !== OTHER; };
  acField.append(acSel, acName);
  if (!aircraft.length) {
    acField.append(el("span", "help",
      "飛行記録を読み込むと、機体が一覧に出ます。まだなら「一覧にない機体」で名前を入れてください。"));
  }
  c1.append(acField);

  const dateField = el("label", "field", "実施年月日");
  const dateIn = el("input");
  dateIn.type = "date"; dateIn.id = "in-date"; dateIn.value = r.date;
  dateField.append(dateIn);
  c1.append(dateField);

  const placeField = el("label", "field", "実施場所");
  const placeIn = el("input");
  placeIn.type = "text"; placeIn.id = "in-place"; placeIn.value = r.place;
  placeIn.placeholder = "例: ○○公園";
  const locBtn = el("button", "btn small", "現在地の住所を入れる");
  locBtn.type = "button";
  locBtn.onclick = () => fillPlace(placeIn, locBtn);
  placeField.append(placeIn, locBtn);
  c1.append(placeField);

  const whoField = el("label", "field", "実施者");
  const whoIn = el("input");
  whoIn.type = "text"; whoIn.id = "in-inspector"; whoIn.value = r.inspector;
  whoField.append(whoIn);
  c1.append(whoField);
  body.append(c1);

  // 点検結果（飛行前・飛行後を切り替えて記録する。点検項目は同じ）
  const c2 = el("div", "card");
  c2.id = "insp-results";
  const head = el("div", "card-head");
  head.append(el("h2", null, "点検結果"));
  const allOkBtn = el("button", "btn small", "すべて「正常」");
  allOkBtn.type = "button";
  allOkBtn.id = "insp-all-ok";
  allOkBtn.onclick = () => {
    const prefix = c2.dataset.phase === "post" ? "post-" : "res-";
    body.querySelectorAll(`input[type=radio][name^="${prefix}"][value="正常"]`)
      .forEach((i) => { i.checked = true; });
  };
  head.append(allOkBtn);
  c2.append(head);
  const phases = el("div", "seg phase-tabs");
  const phaseHelp = el("p", "help");
  const setPhase = (p) => {
    c2.dataset.phase = p;
    phases.querySelectorAll("input").forEach((i) => { i.checked = i.value === p; });
    phaseHelp.textContent = p === "post"
      ? "その日の飛行を終えたあとに行った点検の結果です。"
      : "飛ばす前に行った点検の結果です。飛行後の点検は、飛ばし終えてから「飛行後」で記録します。";
  };
  for (const [value, label] of [["pre", "飛行前"], ["post", "飛行後"]]) {
    const l = el("label", "chk");
    const radio = el("input");
    radio.type = "radio"; radio.name = "insp-phase"; radio.value = value;
    radio.onchange = () => setPhase(value);
    l.append(radio, document.createTextNode(label));
    phases.append(l);
  }
  c2.append(phases, phaseHelp);
  const segFor = (prefix, i, current) => {
    const choices = el("div", `seg ${prefix === "post-" ? "phase-post" : "phase-pre"}`);
    for (const v of INSPECTION_RESULTS) {
      const l = el("label", "chk");
      const radio = el("input");
      radio.type = "radio"; radio.name = `${prefix}${i}`; radio.value = v;
      radio.checked = current === v;
      l.append(radio, document.createTextNode(v));
      choices.append(l);
    }
    return choices;
  };
  DAILY_INSPECTION_ITEMS.forEach(([name, desc], i) => {
    const item = el("div", "insp-item");
    const title = el("div", "insp-name");
    title.append(el("b", null, name), el("span", "meta", ` ${desc}`));
    item.append(title);
    item.append(segFor("res-", i, r.results[name]), segFor("post-", i, r.postResults[name]));
    const remark = el("input");
    remark.type = "text"; remark.className = "insp-remark"; remark.id = `rem-${i}`;
    remark.placeholder = "備考（任意）";
    remark.value = r.itemRemarks[name] || "";
    item.append(remark);
    c2.append(item);
  });
  body.append(c2);

  // 特記事項
  const c3 = el("div", "card");
  c3.append(el("h2", null, "特記事項"));
  const notes = el("textarea");
  notes.id = "in-notes"; notes.rows = 3; notes.value = r.notes;
  notes.placeholder = "点検で見つけた不具合など";
  const notesField = el("label", "field");
  notesField.append(notes);
  c3.append(notesField);
  if (!isNew) {
    const del = el("button", "btn danger block", "この点検記録を削除");
    del.type = "button";
    del.style.marginTop = "16px";
    del.onclick = async () => {
      const sent = !isUnsent(r);
      if (!confirm(sent
        ? "この点検記録をiPhoneから削除します（Macに送った分は残ります）。よろしいですか？"
        : "この点検記録を削除します。まだMacに送っていません。よろしいですか？")) return;
      await db.deleteInspection(r.id);
      closeInspection();
      await renderInspections();
    };
    c3.append(del);
  }
  body.append(c3);

  // 9項目を下までたどったあと、上まで戻らずに保存できるようにする
  const foot = el("div", "sheet-foot");
  const save2 = el("button", "btn primary block", "保存");
  save2.type = "button";
  save2.onclick = saveInspection;
  foot.append(save2);
  body.append(foot);

  setPhase(phase);
  $("#insp-editor").hidden = false;
  body.scrollTop = 0;
  // 飛行後の点検を記録しに開いたときは、点検結果から見せる
  if (phase === "post" && !isNew) c2.scrollIntoView({ block: "start" });
}

async function fillPlace(input, btn) {
  if (!navigator.geolocation) {
    alert("この端末では現在地を取得できません。");
    return;
  }
  btn.disabled = true;
  btn.textContent = "現在地を取得しています…";
  try {
    const pos = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject,
        { enableHighAccuracy: true, timeout: 15000 }));
    const { latitude: lat, longitude: lon } = pos.coords;
    const place = await reverseGeocode(lat, lon);
    // 圏外などで住所が引けなければ座標を入れる（あとで直せる）
    input.value = place || `(${lat.toFixed(5)}, ${lon.toFixed(5)})`;
  } catch (e) {
    alert(e && e.code === 1
      ? "位置情報の利用が許可されていません。「設定」→「プライバシーとセキュリティ」→「位置情報サービス」で許可してください。"
      : "現在地を取得できませんでした。手で入力してください。");
  } finally {
    btn.disabled = false;
    btn.textContent = "現在地の住所を入れる";
  }
}

function closeInspection() {
  $("#insp-editor").hidden = true;
  editing = null;
}

async function saveInspection() {
  if (!editing) return;
  const r = editing.record;
  const aircraft = await db.getAllAircraft();
  const sel = $("#in-aircraft").value;
  if (!sel) { alert("機体を選んでください。"); return; }
  if (sel === OTHER) {
    const name = $("#in-aircraft-name").value.trim();
    if (!name) { alert("機体の名前を入力してください。"); return; }
    r.aircraftSerial = ""; r.aircraftName = name;
  } else {
    const a = aircraft.find((x) => x.serial === sel);
    r.aircraftSerial = sel; r.aircraftName = a ? (a.name || a.serial) : sel;
    await db.setSetting("lastInspectionAircraft", sel);
  }
  const date = $("#in-date").value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { alert("実施年月日を入力してください。"); return; }
  r.date = date;
  r.place = $("#in-place").value.trim();
  r.inspector = $("#in-inspector").value.trim();
  r.results = {};
  r.postResults = {};
  r.itemRemarks = {};
  DAILY_INSPECTION_ITEMS.forEach(([name], i) => {
    const checked = document.querySelector(`input[name="res-${i}"]:checked`);
    if (checked) r.results[name] = checked.value;
    const post = document.querySelector(`input[name="post-${i}"]:checked`);
    if (post) r.postResults[name] = post.value;
    const rem = $(`#rem-${i}`).value.trim();
    if (rem) r.itemRemarks[name] = rem;
  });
  r.notes = $("#in-notes").value.trim();
  r.updatedAt = new Date().toISOString();

  // 飛行後の点検は飛ばし終えてから記録するので、空なのは当たり前。途中までのときだけ確かめる
  const blank = DAILY_INSPECTION_ITEMS.filter(([n]) => !r.results[n]).length;
  if (blank && !confirm(`飛行前の点検で、結果が未記入の項目が ${blank} 個あります。このまま保存しますか？`)) return;
  const postCount = Object.keys(r.postResults).length;
  const postBlank = DAILY_INSPECTION_ITEMS.length - postCount;
  if (postCount && postBlank
    && !confirm(`飛行後の点検で、結果が未記入の項目が ${postBlank} 個あります。このまま保存しますか？`)) return;

  await db.putInspection(r);
  closeInspection();
  await renderInspections();
  // Googleドライブ同期を設定していれば、すぐ送る（app.js が受け取る）
  document.dispatchEvent(new Event("inspection-saved"));
}

// ---------- Macへ送る ----------

async function sendToMac() {
  const all = await db.getAllInspections();
  let targets = all.filter(isUnsent);
  if (!targets.length) {
    if (!all.length) { alert("送る点検記録がありません。"); return; }
    if (!confirm("未送信の記録はありません。すべての記録を送り直しますか？（Mac側で重複はしません）")) return;
    targets = all;
  }

  const payload = {
    format: SYNC_FORMAT,
    version: SYNC_VERSION,
    exportedAt: new Date().toISOString(),
    inspections: targets.map(({ sentAt, ...rest }) => rest),
  };
  const d = new Date();
  const name = `点検記録_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
  const json = JSON.stringify(payload, null, 1);

  // 共有メニューが JSON のファイルを受け付けない環境もあるので、
  // その場合は中身を変えずに種類だけ text/plain にして試す
  const candidates = [
    new File([json], name, { type: "application/json" }),
    new File([json], name, { type: "text/plain" }),
  ];
  const file = candidates.find((f) => navigator.canShare && navigator.canShare({ files: [f] }));

  if (file) {
    try {
      await navigator.share({ files: [file], title: name });
    } catch (e) {
      if (e.name === "AbortError") return; // 利用者が取りやめた
      alert(`送れませんでした（${e.message || e}）`);
      return;
    }
  } else {
    // 共有メニューが使えない環境（PCのブラウザなど）はダウンロードにする
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = el("a");
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const now = new Date().toISOString();
  await db.putInspections(targets.map((r) => ({ ...r, sentAt: now })));
  await renderInspections();
}

export function bindInspections() {
  $("#insp-new").onclick = () => openInspection(null);
  $("#insp-close").onclick = closeInspection;
  $("#insp-save").onclick = saveInspection;
  $("#insp-send").onclick = sendToMac;
}
