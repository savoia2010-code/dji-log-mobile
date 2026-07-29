// 画面の組み立てと操作。

import { PURPOSES, SPECIFIED_FLIGHTS, DEFAULT_PURPOSE, display } from "./constants.js";
import * as db from "./db.js";
import { parseLog } from "./parser.js";
import { reverseGeocode, formatPlace } from "./geocode.js";
import { buildLogbook, fileNameFor, fmtDate, fmtTime, fmtDuration } from "./export.js";

// 実機で「新しい版が反映されているか」を目視できるようにする。
// 中身を変えたらここを上げる。
export const APP_VERSION = "0.3.0";

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const state = {
  flights: [],
  aircraft: [],
  settings: null,
  show: "flight",
  aircraftFilter: "",
  editing: null,
};

const aircraftLabel = (a) =>
  !a ? "" : a.registration ? `${a.name || a.serial}（${a.registration}）` : (a.name || a.serial);

// ---------- 読み込み ----------

async function importFiles(fileList) {
  const files = [...fileList].filter((f) => f.name.toLowerCase().endsWith(".txt"));
  if (!files.length) return;

  const status = $("#import-status");
  const bar = $("#import-bar");
  const text = $("#import-text");
  status.hidden = false;

  let added = 0, skipped = 0, failed = 0;
  const errors = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    bar.style.width = `${Math.round((i / files.length) * 100)}%`;
    text.textContent = `${i + 1} / ${files.length} 件目：${file.name}`;
    await new Promise((r) => setTimeout(r, 0)); // 画面を更新させる

    if (await db.hasFlight(file.name)) { skipped++; continue; }
    try {
      const flight = await parseLog(file);
      flight.place = await reverseGeocode(flight.lat, flight.lon);
      await db.ensureAircraft(flight.aircraftSn, flight.aircraftName);
      await db.putFlight(flight);
      added++;
    } catch (e) {
      failed++;
      if (errors.length < 3) errors.push(`${file.name}: ${e.message || e}`);
    }
  }

  bar.style.width = "100%";
  let msg = `新しい記録 ${added} 件を追加しました`;
  if (skipped) msg += `（取り込み済み ${skipped} 件は飛ばしました）`;
  if (failed) msg += ` / 読めなかったもの ${failed} 件`;
  text.textContent = msg + (errors.length ? `\n${errors.join("\n")}` : "");

  await refresh();
  setTimeout(() => { status.hidden = true; bar.style.width = "0"; }, 6000);
}

// ---------- 一覧 ----------

async function refresh() {
  state.settings = await db.getSettings();
  state.flights = (await db.getAllFlights()).sort((a, b) =>
    b.takeoffTime.localeCompare(a.takeoffTime));
  state.aircraft = await db.getAllAircraft();
  render();
}

function visibleFlights() {
  const { distanceThresholdM: d, altitudeThresholdM: a } = state.settings;
  let list = state.flights;
  if (state.aircraftFilter) list = list.filter((f) => f.aircraftSn === state.aircraftFilter);
  if (state.show === "flight") return list.filter((f) => db.isFlight(f, d, a));
  if (state.show === "excluded") return list.filter((f) => !db.isFlight(f, d, a));
  return list;
}

function render() {
  const { distanceThresholdM: d, altitudeThresholdM: a } = state.settings;
  const scoped = state.aircraftFilter
    ? state.flights.filter((f) => f.aircraftSn === state.aircraftFilter)
    : state.flights;

  $('[data-count="flight"]').textContent = scoped.filter((f) => db.isFlight(f, d, a)).length;
  $('[data-count="excluded"]').textContent = scoped.filter((f) => !db.isFlight(f, d, a)).length;
  $('[data-count="all"]').textContent = scoped.length;

  $("#rule-hint").textContent =
    `累積移動距離 ${d}m 以上${a > 0 ? `、または高度 ${a}m 以上` : ""}を「飛行」と自動判定しています。`
    + " 記録をタップすると編集できます。";

  renderAircraftBar();
  renderList();
  renderExportSelect();
}

function renderAircraftBar() {
  const bar = $("#aircraft-bar");
  bar.innerHTML = "";
  if (state.aircraft.length < 2) { bar.hidden = true; return; }
  bar.hidden = false;

  const mk = (label, serial) => {
    const b = el("button", "chip" + (state.aircraftFilter === serial ? " active" : ""), label);
    b.onclick = () => { state.aircraftFilter = serial; render(); };
    return b;
  };
  bar.append(mk(`すべて (${state.flights.length})`, ""));
  for (const ac of state.aircraft) {
    const n = state.flights.filter((f) => f.aircraftSn === ac.serial).length;
    bar.append(mk(`${aircraftLabel(ac)} (${n})`, ac.serial));
  }
}

function renderList() {
  const box = $("#flight-list");
  box.innerHTML = "";
  const list = visibleFlights();
  if (!list.length) {
    box.append(el("div", "empty", "記録がありません。上のボタンから飛行記録を読み込んでください。"));
    return;
  }
  const { distanceThresholdM: d, altitudeThresholdM: a } = state.settings;

  for (const f of list) {
    const row = el("div", "row");

    const sel = el("label", "sel");
    const cb = el("input");
    cb.type = "checkbox";
    cb.dataset.file = f.fileName;
    sel.append(cb);

    const body = el("div", "body");
    const line1 = el("div", "line1");
    line1.append(el("span", "date", fmtDate(f.takeoffTime)));
    line1.append(el("span", "meta", f.aircraftName || f.aircraftSn));
    const flying = db.isFlight(f, d, a);
    line1.append(el("span", `badge ${flying ? "ok" : "muted"}`, flying ? "飛行" : "対象外"));
    if (f.manualOverride !== null && f.manualOverride !== undefined) {
      line1.append(el("span", "badge manual", "手動"));
    }
    body.append(line1);

    const dist = f.hasGps ? `${Math.round(f.totalDistanceM)} m` : "GPS無";
    body.append(el("div", "meta",
      `${fmtTime(f.takeoffTime)}〜${fmtTime(f.landingTime)} ・ ${fmtDuration(f.durationSeconds)}`
      + ` ・ 移動 ${dist} ・ 高度 ${Math.round(f.maxAltitudeM)} m`));
    body.append(el("div", "place", formatPlace(f.place, f.lat, f.lon) || "—"));
    const tags = [display(f.purpose), display(f.specifiedFlight)].filter(Boolean).join(" / ");
    if (tags) body.append(el("div", "tags", tags));

    body.onclick = () => openEditor(f.fileName);
    row.append(sel, body);
    box.append(row);
  }
}

function renderExportSelect() {
  const sel = $("#export-aircraft");
  const cur = sel.value;
  sel.innerHTML = '<option value="">すべての機体</option>';
  for (const ac of state.aircraft) {
    const o = el("option", null, aircraftLabel(ac));
    o.value = ac.serial;
    sel.append(o);
  }
  sel.value = state.aircraftFilter || cur || "";
}

// ---------- 編集 ----------

function checkboxGroup(container, options, selected, name) {
  container.innerHTML = "";
  for (const v of options) {
    const label = el("label", "chk");
    const input = el("input");
    input.type = "checkbox";
    input.value = v;
    input.name = name;
    input.checked = (selected || []).includes(v);
    label.append(input, document.createTextNode(v));
    container.append(label);
  }
}

const chosen = (container) =>
  [...container.querySelectorAll("input:checked")].map((i) => i.value);

async function openEditor(fileName) {
  const f = await db.getFlight(fileName);
  if (!f) return;
  state.editing = f;
  $("#editor-title").textContent = fmtDate(f.takeoffTime);

  const body = $("#editor-body");
  body.innerHTML = "";

  // 読み取り専用の情報
  const info = el("div", "card");
  const grid = el("div", "readonly-grid");
  const add = (label, value) => {
    const div = el("div");
    div.append(el("span", "label", label), document.createTextNode(value));
    grid.append(div);
  };
  add("機体", f.aircraftName || f.aircraftSn);
  add("離陸", fmtTime(f.takeoffTime));
  add("着陸", fmtTime(f.landingTime));
  add("飛行時間", `${fmtDuration(f.durationSeconds)}（時:分）`);
  add("累積移動距離", f.hasGps ? `${Math.round(f.totalDistanceM)} m` : "GPS未測位");
  add("最高高度", `${Math.round(f.maxAltitudeM)} m`);
  info.append(grid);
  body.append(info);

  // 場所
  const placeCard = el("div", "card");
  placeCard.append(el("h2", null, "場所"));
  const placeField = el("label", "field", "離着陸場所");
  const placeInput = el("input");
  placeInput.type = "text";
  placeInput.id = "ed-place";
  placeInput.value = f.place || "";
  placeInput.placeholder = f.lat ? `(${f.lat.toFixed(5)}, ${f.lon.toFixed(5)})` : "";
  placeField.append(placeInput);
  placeCard.append(placeField);
  body.append(placeCard);

  // 目的
  const pCard = el("div", "card");
  pCard.append(el("h2", null, "飛行の目的"));
  const pBox = el("div", "checks");
  pBox.id = "ed-purpose";
  checkboxGroup(pBox, PURPOSES, f.purpose, "purpose");
  pCard.append(pBox);
  body.append(pCard);

  // 特定飛行
  const sCard = el("div", "card");
  sCard.append(el("h2", null, "特定飛行"));
  const sBox = el("div", "checks spec-grid");
  sBox.id = "ed-specified";
  checkboxGroup(sBox, SPECIFIED_FLIGHTS, f.specifiedFlight, "specified");
  sCard.append(sBox);
  sCard.append(el("p", "help",
    "前の4つは飛行空域（許可が必要）、後の6つは飛行方法（承認が必要）です。"));
  body.append(sCard);

  // その他
  const oCard = el("div", "card");
  oCard.append(el("h2", null, "その他の記入項目"));
  const textField = (label, id, value, ph) => {
    const fl = el("label", "field", label);
    const ta = el("textarea");
    ta.id = id; ta.rows = 2; ta.value = value || "";
    if (ph) ta.placeholder = ph;
    fl.append(ta);
    return fl;
  };
  oCard.append(textField("飛行経路（概要）", "ed-route", f.route, "例: 離陸地点周辺を周回"));
  oCard.append(textField("飛行の安全に影響のあった事項", "ed-issues", f.issues));
  oCard.append(textField("その対応", "ed-issue-response", f.issueResponse));
  oCard.append(textField("記事", "ed-remarks", f.remarks));
  body.append(oCard);

  // 判定
  const jCard = el("div", "card");
  jCard.append(el("h2", null, "日誌への記載"));
  const opts = [
    ["auto", "自動判定に従う"],
    ["flight", "飛行として記載する"],
    ["excluded", "対象外にする"],
  ];
  const current = f.manualOverride === null || f.manualOverride === undefined
    ? "auto" : (f.manualOverride ? "flight" : "excluded");
  for (const [v, label] of opts) {
    const l = el("label", "chk");
    l.style.display = "flex";
    l.style.marginBottom = "8px";
    const i = el("input");
    i.type = "radio"; i.name = "override"; i.value = v; i.checked = current === v;
    l.append(i, document.createTextNode(label));
    jCard.append(l);
  }
  body.append(jCard);

  $("#editor").hidden = false;
  body.scrollTop = 0;
}

async function saveEditor() {
  const f = state.editing;
  if (!f) return;
  f.place = $("#ed-place").value.trim();
  f.purpose = chosen($("#ed-purpose"));
  f.specifiedFlight = chosen($("#ed-specified"));
  f.route = $("#ed-route").value.trim();
  f.issues = $("#ed-issues").value.trim();
  f.issueResponse = $("#ed-issue-response").value.trim();
  f.remarks = $("#ed-remarks").value.trim();
  const ov = document.querySelector('input[name="override"]:checked').value;
  f.manualOverride = ov === "auto" ? null : ov === "flight";

  await db.putFlight(f);
  $("#editor").hidden = true;
  state.editing = null;
  await refresh();
}

// ---------- まとめて編集 ----------

async function applyBulk(field, values) {
  const files = [...document.querySelectorAll('#flight-list input[type=checkbox]:checked')]
    .map((i) => i.dataset.file);
  if (!files.length) {
    alert("適用する記録を、一覧の左のチェックで選んでください。");
    return;
  }
  const updated = [];
  for (const name of files) {
    const f = await db.getFlight(name);
    if (f) { f[field] = values; updated.push(f); }
  }
  await db.putFlights(updated);
  await refresh();
  alert(`${updated.length} 件に適用しました。`);
}

// ---------- 設定 ----------

function renderSettings() {
  const s = state.settings;
  $("#pilot-name").value = s.pilotName || "";
  $("#dist-threshold").value = s.distanceThresholdM;
  $("#alt-threshold").value = s.altitudeThresholdM;

  const box = $("#aircraft-list");
  box.innerHTML = "";
  if (!state.aircraft.length) {
    box.append(el("p", "help", "まだ機体がありません。"));
    return;
  }
  for (const ac of state.aircraft) {
    const item = el("div", "aircraft-item");
    item.append(el("div", null, `${ac.name || ac.serial}（S/N: ${ac.serial}）`));
    const mk = (label, key, ph) => {
      const fl = el("label", "field", label);
      const i = el("input");
      i.type = "text"; i.value = ac[key] || ""; if (ph) i.placeholder = ph;
      i.onchange = async () => {
        await db.putAircraft({ ...ac, [key]: i.value.trim() });
        await refresh();
      };
      fl.append(i);
      return fl;
    };
    item.append(mk("登録記号", "registration", "JU1234567890"));
    item.append(mk("型式", "model", "例: DJI Mini 4 Pro"));
    box.append(item);
  }
}

// ---------- 出力 ----------

async function exportXlsx() {
  const serial = $("#export-aircraft").value;
  const flights = serial ? state.flights.filter((f) => f.aircraftSn === serial) : state.flights;
  const aircraft = serial ? state.aircraft.filter((a) => a.serial === serial) : state.aircraft;

  const target = flights.filter((f) =>
    db.isFlight(f, state.settings.distanceThresholdM, state.settings.altitudeThresholdM));
  if (!target.length) {
    alert("書き出す飛行記録がありません。");
    return;
  }

  const blob = buildLogbook(flights, state.aircraft, state.settings);
  const name = fileNameFor(serial ? aircraftLabel(aircraft[0]) : "");
  const file = new File([blob], name, { type: blob.type });

  // iOSでは共有シートから「ファイル」Appに保存できる
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = el("a");
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- 起動 ----------

function bind() {
  $("#file-input").onchange = (e) => { importFiles(e.target.files); e.target.value = ""; };

  for (const b of document.querySelectorAll(".tab-btn")) {
    b.onclick = () => {
      document.querySelectorAll(".tab-btn").forEach((x) => x.classList.toggle("active", x === b));
      const v = b.dataset.view;
      $("#view-list").hidden = v !== "list";
      $("#view-settings").hidden = v !== "settings";
      if (v === "settings") renderSettings();
    };
  }

  for (const b of document.querySelectorAll("#filter-tabs .chip")) {
    b.onclick = () => {
      state.show = b.dataset.show;
      document.querySelectorAll("#filter-tabs .chip")
        .forEach((x) => x.classList.toggle("active", x === b));
      renderList();
    };
  }

  checkboxGroup($("#bulk-purpose"), PURPOSES, [DEFAULT_PURPOSE], "bulk-purpose");
  checkboxGroup($("#bulk-specified"), SPECIFIED_FLIGHTS, [], "bulk-specified");
  $("#bulk-apply-purpose").onclick = () => applyBulk("purpose", chosen($("#bulk-purpose")));
  $("#bulk-apply-specified").onclick =
    () => applyBulk("specifiedFlight", chosen($("#bulk-specified")));

  $("#editor-close").onclick = () => { $("#editor").hidden = true; state.editing = null; };
  $("#editor-save").onclick = saveEditor;
  $("#export-btn").onclick = exportXlsx;

  $("#save-settings").onclick = async () => {
    await db.setSetting("pilotName", $("#pilot-name").value.trim());
    await db.setSetting("distanceThresholdM", Number($("#dist-threshold").value) || 8);
    await db.setSetting("altitudeThresholdM", Number($("#alt-threshold").value) || 0);
    await refresh();
    alert("保存しました。");
  };

  $("#regeocode").onclick = async () => {
    const btn = $("#regeocode");
    const box = $("#regeocode-status");
    const bar = $("#regeocode-bar");
    const text = $("#regeocode-text");
    const targets = (await db.getAllFlights()).filter((f) => f.lat != null);
    if (!targets.length) { alert("住所を取り直す記録がありません。"); return; }

    btn.disabled = true;
    box.hidden = false;
    let updated = 0;
    for (let i = 0; i < targets.length; i++) {
      const f = targets[i];
      bar.style.width = `${Math.round((i / targets.length) * 100)}%`;
      text.textContent = `${i + 1} / ${targets.length} 件目…`;
      await new Promise((r) => setTimeout(r, 0));
      const place = await reverseGeocode(f.lat, f.lon);
      if (place && place !== f.place) { f.place = place; await db.putFlight(f); updated++; }
    }
    bar.style.width = "100%";
    text.textContent = `完了：${targets.length} 件を確認し、${updated} 件を更新しました`;
    btn.disabled = false;
    await refresh();
    renderSettings();
  };

  $("#clear-data").onclick = async () => {
    if (!confirm("保存されている飛行記録をすべて削除します。よろしいですか？")) return;
    for (const f of await db.getAllFlights()) await db.deleteFlight(f.fileName);
    await refresh();
    alert("削除しました。");
  };
}

function showFatal(message, detail) {
  const box = el("div", "card");
  box.append(el("h2", null, message));
  box.append(el("p", "help", detail));
  const main = document.querySelector("main");
  main.prepend(box);
}

async function start() {
  bind();
  try {
    await refresh();
  } catch (e) {
    if (e instanceof db.StorageUnavailable) {
      showFatal("記録を保存できません", [
        "Safariのプライベートブラウズでは記録を保存できません。",
        "通常のタブで開き直してください。",
        `（詳細: ${e.message}）`,
      ].join(""));
    } else {
      showFatal("起動できませんでした", String(e && e.message || e));
    }
    return;
  }
  const v = $("#app-version");
  if (v) v.textContent = `バージョン ${APP_VERSION}`;
}

start();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
