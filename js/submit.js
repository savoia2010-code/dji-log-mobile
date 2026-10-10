// 現場で提示・提出を求められたときの出力。
//
// 飛行日誌（様式1・2・3）は、Macから受け取った日誌とこのiPhoneの記録（今日の飛行や
// 点検など、Macにまだ無いもの）を合わせて、その場でExcelにする。
// 具備資料のPDF・許可書・そのほかの携行書類（技能証明書など）は、Mac版で登録したものを
// 携行用ファイルで受け取っているので、そのまま開く・送る。
//
// 送るときは iOS の共有シートを使う（メール・AirDrop・メッセージ・「ファイル」に保存など）。

import { DAILY_INSPECTION_ITEMS } from "./constants.js";
import { postSummary } from "./inspections.js";

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const str = (v) => (v == null ? "" : String(v));
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const list = (v) => (Array.isArray(v) ? v : []);
const pad = (n) => String(n).padStart(2, "0");
const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
};
const safe = (s) => str(s).replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "機体";

export function base64ToBlob(b64, type) {
  const bin = atob(str(b64));
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

/** iOS の共有シートで送る。共有できない環境では開いて見せる。 */
export async function shareBlob(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
    } catch (e) {
      if (e && e.name !== "AbortError") alert(`送れませんでした（${e.message || e}）`);
    }
    return;
  }
  openBlob(blob);
}

export function openBlob(blob) {
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------- 飛行日誌（様式1・2・3）のExcel ----------

// Mac版の様式1（app/export.py の HEADERS）と同じ並び
const FLIGHT_HEADERS = [
  ["飛行年月日", "date"], ["飛行させた者の氏名", "pilot"], ["飛行の目的", "purpose"],
  ["特定飛行", "specified_flight"], ["飛行経路", "route"], ["離陸場所", "takeoff_place"],
  ["着陸場所", "landing_place"], ["離陸時刻", "takeoff_time"], ["着陸時刻", "landing_time"],
  ["飛行時間", "duration"], ["総飛行時間", "total_time"],
  ["飛行の安全に影響のあった事項", "issues"],
  ["記事：発生年月日", "squawk_date"], ["記事：不具合事項", "squawk"],
  ["記事：処置年月日", "action_date"], ["記事：処置その他", "issue_response"],
  ["記事：確認者", "confirmer"], ["備考", "remarks"],
];
const MAINT_HEADERS = [
  ["実施年月日", "date"], ["総飛行時間", "total_time"],
  ["点検、修理、改造及び整備の内容", "detail"], ["実施理由", "reason"], ["実施場所", "place"],
  ["実施者", "engineer"], ["備考", "remarks"],
];

/**
 * 冒頭に書く「無人航空機の概要」（取扱要領 6.(1)d)ア〜エ）。Macから受け取った概要を使い、
 * Macにまだ無い機体は分かる範囲で書く。
 */
function overviewLines(ac) {
  const ov = obj(ac.overview);
  const maker = str(ov.manufacturer) || (/^dji/i.test(str(ac.name) || str(ac.model)) ? "DJI" : "");
  const lines = [
    ["無人航空機の登録記号", str(ov.registration) || str(ac.registration)],
    ["型式", str(ov.model) || str(ac.model)],
    ["設計製造者", maker],
    ["製造番号", str(ov.serial) || str(ac.serial)],
  ];
  if (str(ov.type_cert_number)) lines.push(["型式認証書番号", str(ov.type_cert_number)]);
  if (str(ov.airworthiness)) lines.push(["機体認証の区分・機体認証書番号", str(ov.airworthiness)]);
  return lines;
}

function sheet(XLSX, title, ac, headers, rows, widths, notes = []) {
  const aoa = [
    [title],
    ...overviewLines(ac),
    ...notes.map((n) => [n]),
    [],
    headers,
    ...rows,
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = widths.map((w) => ({ wch: w }));
  return ws;
}

/** 1機分の飛行日誌（様式1・2・3）を1つのExcelにする。 */
export function buildFullLogbook(ac) {
  return buildLogbooks([ac]);
}

/** 複数の機体の飛行日誌を1つのExcelにする（機体ごとに様式1・2・3のシート）。 */
export function buildLogbooks(list) {
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();
  const used = new Set();
  const sheetName = (base) => {
    let name = base.replace(/[:\\/?*[\]]/g, "").slice(0, 31);
    for (let n = 2; used.has(name); n++) name = `${base.slice(0, 26)} (${n})`;
    used.add(name);
    return name;
  };
  // 1機なら「様式1 飛行記録」、複数の機体なら「様式1 JU…」のように機体を添える
  for (const ac of list) {
    const tag = str(ac.registration) || str(ac.label) || str(ac.serial);
    appendLogbook(XLSX, wb, ac, (form, title) => sheetName(list.length > 1 ? `${form} ${tag}` : `${form} ${title}`));
  }
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function appendLogbook(XLSX, wb, ac, nameFor) {
  const flights = [...list(ac.flights)].sort((a, b) =>
    `${str(a.date)} ${str(a.takeoff_time)}`.localeCompare(`${str(b.date)} ${str(b.takeoff_time)}`));
  XLSX.utils.book_append_sheet(wb, sheet(XLSX, "飛行記録（様式1）", ac,
    FLIGHT_HEADERS.map(([h]) => h),
    flights.map((f) => FLIGHT_HEADERS.map(([, k]) => str(f[k]))),
    [12, 14, 18, 26, 24, 26, 26, 8, 10, 10, 12, 28, 12, 24, 12, 24, 12, 24],
    flights.some((f) => f.localOnly)
      ? ["※総飛行時間の「暫定」は、このiPhoneで読み込みMacの日誌にまだ無い飛行（Macに取り込むと確定）。"]
      : []), nameFor("様式1", "飛行記録"));

  const daily = [...list(ac.daily)].sort((a, b) => str(a.date).localeCompare(str(b.date)));
  const items = DAILY_INSPECTION_ITEMS;
  XLSX.utils.book_append_sheet(wb, sheet(XLSX, "日常点検記録（様式2）", ac,
    ["実施年月日", "実施場所", "実施者", ...items.map(([n, d]) => `${n}\n${d}`), "飛行後点検", "備考", "特記事項"],
    daily.map((r) => {
      const res = obj(r.results);
      const post = obj(r.postResults);
      const remarks = obj(r.itemRemarks);
      return [
        str(r.date), str(r.place), str(r.inspector),
        ...items.map(([n]) => str(res[n])),
        postSummary({ postResults: post, notes: str(r.notes) }).text,
        items.filter(([n]) => remarks[n]).map(([n]) => `${n}: ${str(remarks[n])}`).join("\n"),
        str(r.notes),
      ];
    }),
    [12, 24, 14, ...items.map(() => 11), 16, 24, 28],
    ["点検項目ごとの結果は飛行前の点検。飛行後の点検（同じ項目）は「飛行後点検」欄。"]), nameFor("様式2", "日常点検記録"));

  XLSX.utils.book_append_sheet(wb, sheet(XLSX, "点検整備記録（様式3）", ac,
    MAINT_HEADERS.map(([h]) => h),
    list(ac.maintenance).map((m) => MAINT_HEADERS.map(([, k]) => str(m[k]))),
    [12, 10, 40, 20, 24, 14, 28],
    ["※総飛行時間は、前回の機体認証を受検するにあたり実施した点検整備以降の総飛行時間。"
      + "機体認証を受けていない無人航空機は、点検整備作業を実施した時点での総飛行時間。"]), nameFor("様式3", "点検整備記録"));
}

export const logbookFileName = (ac) =>
  `飛行日誌_${safe(ac.registration || ac.label)}_${stamp()}.xlsx`;

// ---------- 画面 ----------

function docRow(title, sub, blob, name) {
  const row = el("div", "submit-row");
  const text = el("div", "submit-text");
  text.append(el("div", "submit-title", title));
  if (sub) text.append(el("div", "meta", sub));
  row.append(text);
  const actions = el("div", "submit-actions");
  const open = el("button", "btn small", "開く");
  open.type = "button";
  open.onclick = () => openBlob(blob());
  const send = el("button", "btn small primary", "送る");
  send.type = "button";
  send.onclick = () => shareBlob(blob(), name);
  actions.append(open, send);
  row.append(actions);
  return row;
}

/**
 * 提出・提示用の出力（選んでいる機体の分）。
 * ac は Macの日誌とこのiPhoneの記録を合わせたもの、documents は携行用ファイルの具備資料。
 */
export function submitSection(ac, documents) {
  const card = el("div", "card submit");
  card.append(el("h2", null, "提出・提示を求められたら"));
  card.append(el("p", "help",
    "「送る」でメール・AirDrop・メッセージなどから送れます。「開く」はこの画面で見せるときに使います。"));

  const logs = el("div", "submit-row");
  const t = el("div", "submit-text");
  t.append(el("div", "submit-title", "飛行日誌（飛行記録・日常点検記録・点検整備記録）"));
  t.append(el("div", "meta",
    `様式1〜3を1つのExcelに（飛行 ${list(ac.flights).length}件・日常点検 ${list(ac.daily).length}件・点検整備 ${list(ac.maintenance).length}件。今日このiPhoneで記録した分も含む）`));
  logs.append(t);
  const la = el("div", "submit-actions");
  const send = el("button", "btn small primary", "送る");
  send.type = "button";
  send.id = "submit-logbook";
  send.onclick = () => shareBlob(buildFullLogbook(ac), logbookFileName(ac));
  la.append(send);
  logs.append(la);
  card.append(logs);

  const doc = documents && obj(documents.aircraft)[ac.serial];
  if (doc && doc.pdf) {
    card.append(docRow("具備資料（PDF）", "製造者・名称・重量等／運用限界等／追加基準への適合性／許可・承認及び保険",
      () => base64ToBlob(doc.pdf, "application/pdf"), str(doc.pdf_name) || "具備資料.pdf"));
  } else {
    card.append(el("p", "help", "具備資料のPDFはまだありません（Mac版の「具備資料」で作ると届きます）。"));
  }

  for (const p of list(documents && documents.permits)) {
    if (!p.pdf) continue;
    card.append(docRow(`許可書・承認書 ${str(p.number)}`, p.valid_to ? `${str(p.valid_to)}まで` : "",
      () => base64ToBlob(p.pdf, "application/pdf"), str(p.file_name) || "許可書.pdf"));
  }

  const others = list(documents && documents.others);
  for (const o of others) {
    if (!o.data) continue;
    const sub = [str(o.kind) !== str(o.title) ? str(o.kind) : "", o.valid_to ? `${str(o.valid_to)}まで` : "", str(o.note)]
      .filter(Boolean).join(" ／ ");
    card.append(docRow(str(o.title) || str(o.kind), sub,
      () => base64ToBlob(o.data, str(o.mime) || "application/octet-stream"), str(o.file_name) || str(o.title)));
  }
  if (!others.length) {
    card.append(el("p", "help",
      "技能証明書・機体登録の通知・飛行計画の通報・保険証券なども、Mac版の「具備資料」→「その他の携行書類」で登録するとここから送れます。"));
  }
  return card;
}
