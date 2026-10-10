// 画面の組み立てと操作。

import { PURPOSES, SPECIFIED_FLIGHTS, DEFAULT_PURPOSE, display } from "./constants.js";
import * as db from "./db.js";
import { parseLog } from "./parser.js";
import { reverseGeocode, formatPlace } from "./geocode.js";
import { fmtDate, fmtTime, fmtDuration } from "./export.js";
import { buildLogbooks, shareBlob } from "./submit.js";
import { bindInspections, renderInspections } from "./inspections.js";
import { bindCarry, isInstalled, mergedAircraft, protectStorage, renderCarry } from "./carry.js";
import * as gas from "./gas.js";
import * as settingsSync from "./settingsSync.js";

// 実機で「新しい版が反映されているか」を目視できるようにする。
// 中身を変えたらここを上げる。
export const APP_VERSION = "0.15.0";

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

  let added = 0, skipped = 0, failed = 0, resent = 0;
  // Macの日誌にある記録（原本から解析したもの）。これに無い飛行は、原本をMacへ送る
  const carry = await db.getCarry();
  const macHas = new Set();
  for (const a of (carry && carry.data && carry.data.aircraft) || []) {
    for (const f of a.flights || []) if (f.file && !f.pending_raw) macHas.add(f.file);
  }
  const macNeeds = (name) => !!carry && !macHas.has(name);
  const errors = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    bar.style.width = `${Math.round((i / files.length) * 100)}%`;
    text.textContent = `${i + 1} / ${files.length} 件目：${file.name}`;
    await new Promise((r) => setTimeout(r, 0)); // 画面を更新させる

    if (await db.hasFlight(file.name)) {
      skipped++;
      // 前に読み込んだ飛行でも、Macにまだ原本が無ければ送る（Macの日誌の漏れを埋める）
      if (macNeeds(file.name)) {
        try {
          if (await gas.queueFlightLog(file)) resent++;
        } catch (e) {
          console.warn("飛行記録を送る準備ができませんでした", e);
        }
      }
      continue;
    }
    try {
      const flight = await parseLog(file);
      flight.place = await reverseGeocode(flight.lat, flight.lon);
      await db.ensureAircraft(flight.aircraftSn, flight.aircraftName);
      await db.putFlight(flight);
      // Googleドライブ同期を設定していれば、原本をMac版へ送る順番待ちに入れる
      try {
        await gas.queueFlightLog(file);
      } catch (e) {
        console.warn("飛行記録を送る準備ができませんでした", e);   // 読み込み自体は済んでいる
      }
      added++;
    } catch (e) {
      failed++;
      if (errors.length < 3) errors.push(`${file.name}: ${e.message || e}`);
    }
  }

  bar.style.width = "100%";
  let msg = `新しい記録 ${added} 件を追加しました`;
  if (skipped) msg += `（取り込み済み ${skipped} 件は飛ばしました）`;
  if (resent) msg += ` / Macに原本が無い ${resent} 件をMacへ送ります`;
  if (failed) msg += ` / 読めなかったもの ${failed} 件`;
  text.textContent = msg + (errors.length ? `\n${errors.join("\n")}` : "");

  await refresh();
  await renderCarry(); // 携行タブの「今日の記録」にもすぐ反映する
  // 読み込んだ飛行記録を、すぐMac版へ送る（電波が無ければ、次に同期したときに送る）
  if (added || resent) document.dispatchEvent(new Event("flights-imported"));
  setTimeout(() => { status.hidden = true; bar.style.width = "0"; }, 6000);
  return { added, skipped, failed };
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
  if (state.show === "flight") return list.filter((f) => db.isFlight(f, d, a, db.noGpsRule(state.settings)));
  if (state.show === "excluded") return list.filter((f) => !db.isFlight(f, d, a, db.noGpsRule(state.settings)));
  return list;
}

function render() {
  const { distanceThresholdM: d, altitudeThresholdM: a } = state.settings;
  const scoped = state.aircraftFilter
    ? state.flights.filter((f) => f.aircraftSn === state.aircraftFilter)
    : state.flights;

  $('[data-count="flight"]').textContent = scoped.filter((f) => db.isFlight(f, d, a, db.noGpsRule(state.settings))).length;
  $('[data-count="excluded"]').textContent = scoped.filter((f) => !db.isFlight(f, d, a, db.noGpsRule(state.settings))).length;
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
    const flying = db.isFlight(f, d, a, db.noGpsRule(state.settings));
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
  oCard.append(textField("飛行の安全に影響のあった事項", "ed-issues", f.issues,
    "影響があった（おそれがあった）場合は、その内容と、飛行前後の機体の状況"));
  body.append(oCard);

  // 記事（取扱要領 7.(1)l)）：不具合とその処置
  const kCard = el("div", "card");
  kCard.append(el("h2", null, "記事（不具合とその処置）"));
  kCard.append(el("p", "help", "不具合が無ければ空欄のままで構いません。"));
  const inputField = (label, id, value, type = "text", ph = "") => {
    const fl = el("label", "field", label);
    const i = el("input");
    i.id = id; i.type = type; i.value = value || "";
    if (ph) i.placeholder = ph;
    fl.append(i);
    return fl;
  };
  kCard.append(inputField("不具合事項", "ed-squawk", f.squawk, "text", "例: 着陸時にプロペラが接触し欠けた"));
  kCard.append(inputField("発生年月日（空欄なら飛行した日）", "ed-squawk-date", f.squawkDate, "date"));
  kCard.append(inputField("処置その他", "ed-issue-response", f.issueResponse, "text", "例: プロペラを交換"));
  kCard.append(inputField("処置年月日", "ed-action-date", f.actionDate, "date"));
  kCard.append(inputField("確認者", "ed-confirmer", f.confirmer, "text", "処置を確かめた人の氏名"));
  kCard.append(textField("備考（その他のメモ）", "ed-remarks", f.remarks));
  body.append(kCard);

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
  f.squawk = $("#ed-squawk").value.trim();
  f.squawkDate = $("#ed-squawk-date").value;
  f.actionDate = $("#ed-action-date").value;
  f.confirmer = $("#ed-confirmer").value.trim();
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
  $("#pilot-cert").value = s.pilotCertificate || "";
  $("#dist-threshold").value = s.distanceThresholdM;
  $("#alt-threshold").value = s.altitudeThresholdM;
  $("#include-no-gps").checked = !!s.includeNoGps;
  $("#no-gps-min").value = s.noGpsMinMinutes;

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
        // Mac版と揃えるので、変えた項目に時刻を付ける
        const before = await settingsSync.snapshot();
        await db.putAircraft({ ...ac, [key]: i.value.trim() });
        if ((await settingsSync.stampChanges(before)).length) autoSync(true);
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
  // Macから受け取った日誌とこのiPhoneの記録を合わせて、様式1〜3を出す（携行タブの「提出」と同じ）
  const serial = $("#export-aircraft").value;
  const saved = await db.getCarry();
  const all = await mergedAircraft(saved && saved.data);
  const list = serial ? all.filter((a) => a.serial === serial) : all;
  if (!list.some((a) => a.flights.length || a.daily.length || a.maintenance.length)) {
    alert("書き出す記録がありません。");
    return;
  }
  const one = list.length === 1 ? list[0] : null;
  const name = `飛行日誌_${one ? (one.registration || one.label) : "全機体"}_${fmtDate(new Date().toISOString()).replace(/-/g, "")}.xlsx`
    .replace(/[\\/:*?"<>|]/g, "_");
  await shareBlob(buildLogbooks(list), name);
}

// ---------- 起動 ----------

function bind() {
  $("#file-input").onchange = (e) => { importFiles(e.target.files); e.target.value = ""; };
  // 「今日の記録」から読み込んだときは、進み具合の見える「記録」タブで読み込み、
  // 終わったら携行タブへ戻す。読めなかったものがあれば、理由が見えるよう留まる
  $("#carry-flight-input").onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    document.querySelector('.tab-btn[data-view="list"]').click();
    const result = await importFiles(files);
    if (result && !result.failed) document.querySelector('.tab-btn[data-view="carry"]').click();
  };

  for (const b of document.querySelectorAll(".tab-btn")) {
    b.onclick = () => {
      document.querySelectorAll(".tab-btn").forEach((x) => x.classList.toggle("active", x === b));
      const v = b.dataset.view;
      $("#view-carry").hidden = v !== "carry";
      $("#view-list").hidden = v !== "list";
      $("#view-inspections").hidden = v !== "inspections";
      $("#view-settings").hidden = v !== "settings";
      if (v === "settings") { renderSettings(); renderGas(); }
      if (v === "inspections") renderInspections();
      if (v === "carry") renderCarry();
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

  bindInspections();
  bindCarry();
  bindGas();

  $("#editor-close").onclick = () => { $("#editor").hidden = true; state.editing = null; };
  $("#editor-save").onclick = saveEditor;
  $("#export-btn").onclick = exportXlsx;

  $("#save-settings").onclick = async () => {
    // Mac版と揃える設定は、保存で値が変わった項目にだけ時刻を付ける（新しい方に合わせるため）
    const before = await settingsSync.snapshot();
    await db.setSetting("pilotName", $("#pilot-name").value.trim());
    await db.setSetting("pilotCertificate", $("#pilot-cert").value.trim());
    await db.setSetting("distanceThresholdM", Number($("#dist-threshold").value) || 8);
    await db.setSetting("altitudeThresholdM", Number($("#alt-threshold").value) || 0);
    await db.setSetting("includeNoGps", $("#include-no-gps").checked);
    await db.setSetting("noGpsMinMinutes", Math.max(0, Number($("#no-gps-min").value) || 0));
    const changed = await settingsSync.stampChanges(before);
    await refresh();
    alert(changed.length ? "保存しました。Mac版にも届きます（同期したとき）。" : "保存しました。");
    if (changed.length) autoSync(true);
  };
  // Mac版で後から変えた設定に合わせたら、知らせて画面を描き直す（知らないうちに変わらないように）
  document.addEventListener("settings-synced", async (e) => {
    await refresh();
    renderSettings();
    alert(`Mac版で変えた設定に合わせました：${e.detail.join("、")}`);
  });

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

// ---------- Googleドライブ同期 ----------

async function renderGas() {
  const conf = await gas.getConfig();
  $("#gas-unset").hidden = !!conf;
  $("#gas-set").hidden = !conf;
  if (!conf) return;
  const st = (await db.getSettings()).gasStatus;
  const when = st ? new Date(st.time).toLocaleString("ja-JP") : "";
  $("#gas-status").textContent = st ? `${when}：${st.message}` : "まだ同期していません";
  $("#gas-status").classList.toggle("warn-text", !!st && !st.ok);
}

async function autoSync(force = false) {
  if (!navigator.onLine) return;
  const status = await gas.syncNow({ force });
  if (status) {
    await renderGas();
    await renderInspections();
    if (status.restorable) await offerRestore(status.restorable);
  }
}

/** このiPhoneが空で、Googleドライブにバックアップがあるときに、戻すかを聞く。 */
async function offerRestore(n) {
  if (!confirm(`このiPhoneには記録がありませんが、Googleドライブにバックアップがあります`
    + `（飛行記録 ${n.flights}件・日常点検 ${n.inspections}件）。このiPhoneに戻しますか？`)) return;
  try {
    const r = await gas.restoreFromBackup();
    await refresh();
    await renderCarry();
    await renderInspections();
    renderSettings();
    alert(`戻しました（飛行 ${r.flights}件・点検 ${r.inspections}件${r.settings ? "・設定" : ""}）。`);
  } catch (e) {
    alert(e.message);
  }
}

function bindGas() {
  $("#gas-save").onclick = async () => {
    try {
      await gas.saveConfig($("#gas-code").value);
    } catch (e) {
      alert(e.message);
      return;
    }
    $("#gas-code").value = "";
    await renderGas();
    await autoSync(true);
    const st = (await db.getSettings()).gasStatus;
    alert(st && st.ok ? `設定しました。${st.message}` : `設定しましたが、同期できませんでした。\n${st ? st.message : ""}`);
  };
  $("#gas-sync").onclick = () => autoSync(true);
  $("#gas-restore").onclick = async () => {
    if (!confirm("Googleドライブのバックアップから、このiPhoneに無い記録を戻します。よろしいですか？")) return;
    try {
      const r = await gas.restoreFromBackup();
      await refresh();
      await renderCarry();
      await renderInspections();
      renderSettings();
      alert(`戻しました（点検 ${r.inspections}件・飛行 ${r.flights}件${r.settings ? "・設定" : ""}）。`);
    } catch (e) {
      alert(e.message);
    }
  };
  $("#gas-clear").onclick = async () => {
    if (!confirm("Googleドライブ同期の設定を消します（Googleドライブの中身は消えません）。よろしいですか？")) return;
    await gas.clearConfig();
    await renderGas();
  };
  // 電波が戻ったとき・アプリに戻ってきたときにも同期する
  window.addEventListener("online", () => autoSync());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") autoSync();
  });
  // 点検を保存したら、すぐ送る（送り忘れを無くすため）
  document.addEventListener("inspection-saved", () => autoSync(true));
  document.addEventListener("flights-imported", () => autoSync(true));
}

/**
 * QRコードで受け取った設定コードの案内。
 * ホーム画面のアプリで開いたときはそのまま設定できる。Safariで開いたとき
 * （カメラで読むと Safari で開く）は、Safari とホーム画面のアプリは保存先が別なので、
 * コピーしてホーム画面のアプリに貼ってもらう。
 */
function showIncomingSetup(code) {
  try {
    gas.parseSetupCode(code);
  } catch (e) {
    alert(`QRコードの設定コードを読み取れませんでした。\n${e.message}`);
    return;
  }
  const card = el("div", "card setup-card");
  card.append(el("h2", null, "設定コードを受け取りました"));
  const apply = el("button", "btn primary block", "このアプリにGoogleドライブ同期を設定する");
  apply.onclick = async () => {
    await gas.saveConfig(code);
    card.remove();
    await autoSync(true);
    const st = (await db.getSettings()).gasStatus;
    alert(st && st.ok ? `設定しました。${st.message}` : `設定しましたが、同期できませんでした。\n${st ? st.message : ""}`);
  };
  if (isInstalled()) {
    card.append(apply);
  } else {
    card.append(el("p", "help",
      "いまはSafariで開いています。ホーム画面のアプリとは保存先が別なので、"
      + "下の「コピー」を押してから、ホーム画面の iPhone版を開き、「設定」→「Googleドライブ同期」に貼り付けてください。"));
    const copy = el("button", "btn primary block", "設定コードをコピー");
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(code);
        copy.textContent = "コピーしました。ホーム画面のアプリで貼り付けてください";
      } catch {
        alert("コピーできませんでした。もう一度押してください。");
      }
    };
    card.append(copy);
    apply.className = "btn block";
    apply.textContent = "（Safariのままで使う場合）ここに設定する";
    apply.style.marginTop = "8px";
    card.append(apply);
  }
  document.querySelector("main").prepend(card);
  window.scrollTo(0, 0);
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
  try {
    await renderCarry();
    await protectStorage();
    const incoming = gas.takeSetupFromUrl();
    if (incoming) showIncomingSetup(incoming);
    autoSync();
  } catch (e) {
    showFatal("携行用の日誌を表示できませんでした", String(e && e.message || e));
  }
}

start();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
