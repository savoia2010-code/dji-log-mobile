// 具備資料（機体ごと）をこのiPhoneで直す。Mac版の「具備資料」と同じ内容。
//
// 直した内容は「部分」ごとに残し、Mac版へ送る（日常点検と同じ受信フォルダ）:
//   spec        製造者・名称・重量等、運用限界等、飛行させる方法
//   compliance  選んだ飛行形態と、基準ごとの 適／否・代替措置
//   photo:<置き場所>  写真（消したときは deleted）
// 部分ごとに更新日時を持たせ、Mac版は自分の方が新しければ取り込まない。Macから届いた日誌の
// 部分ごとの時刻（documents.aircraft[シリアル].sync）より新しいあいだは、このiPhoneの内容を見せる。
// Macに届いて日誌に入ったら（Macの時刻が追いついたら）、このiPhoneの分は消す。
//
// 写真は、ボタンからカメラを開いて撮るか、写真ライブラリから選ぶ。送る前に縮小する（長い辺1600px の JPEG）。

import * as db from "./db.js";

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const list = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v == null ? "" : String(v));
const time = (v) => { const t = Date.parse(v || ""); return Number.isNaN(t) ? 0 : t; };
const clone = (v) => JSON.parse(JSON.stringify(v));

const OTHER = "other";                     // 代替措置を自由に書くとき（Mac版の gubi_rules.OTHER）
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;  // Mac版の上限
const GROUP1 = ["front", "top", "side", "controller"];
const GROUP2 = ["ops_body", "ops_video", "ops_controller"];

export const partKey = (serial, section) => `${serial}|${section}`;

// Mac版 dji_models._key と同じ見比べ方（大文字・小文字、空白、"DJI" の有無を区別しない）
const modelKey = (name) => {
  const s = str(name).toLowerCase().replace(/[\s_-]+/g, "");
  return s.startsWith("dji") ? s.slice(3) : s;
};

function djiValues(documents, name) {
  const k = modelKey(name);
  const m = list(documents && documents.dji_models).find((x) => list(x.names).some((n) => modelKey(n) === k));
  return m ? obj(m.values) : null;
}

function textKeys(documents) {
  return [...list(documents && documents.spec_fields), ...list(documents && documents.limit_fields)]
    .map(([k]) => k).concat("flight_method");
}

/** 書類の「適合性」欄に載せる文（Mac版 gubi.compliance_text と同じ）。 */
export function complianceText(req, answer) {
  const a = obj(answer);
  if (!a.result) return "";
  if (a.result === "適") return "適";
  const sel = str(a.alt_selection);
  if (sel === OTHER && a.alt_other) return `否\n【代替措置】\n${a.alt_other}`;
  const alts = list(req.alternatives);
  if (/^\d+$/.test(sel) && Number(sel) < alts.length) return `否\n【代替措置】\n${alts[Number(sel)]}`;
  return "否";
}

function renderCategories(rules, categoryIds, answers) {
  const chosen = new Set(categoryIds);
  return rules.filter((c) => chosen.has(c.id)).map((c) => ({
    id: c.id, clause: c.clause, heading: c.heading,
    requirements: list(c.requirements).map((r) => ({
      id: r.id, standard: r.standard, compliance: complianceText(r, answers[r.id]),
    })),
  }));
}

/**
 * Macから届いた具備資料に、このiPhoneで直した部分（Macより新しいもの）を重ねたもの。
 * aircraft はこの機体（名前・登録記号を見る）。
 */
export function effective(documents, serial, parts, aircraft = {}) {
  const mac = obj(documents && documents.aircraft)[serial] || null;
  const macSync = obj(mac && mac.sync);
  const mine = list(parts).filter((p) => p.serial === serial
    && (!macSync[p.section] || time(p.updatedAt) > time(macSync[p.section])));
  const pick = (section) => mine.find((p) => p.section === section);

  let spec;
  if (mac) spec = { ...obj(mac.spec) };
  else {
    const name = str(aircraft.model || aircraft.name);
    spec = Object.fromEntries(textKeys(documents).map((k) => [k, ""]));
    spec.name = name;
    spec.manufacturer = name.toUpperCase().startsWith("DJI") ? "DJI" : "";
  }
  const sp = pick("spec");
  if (sp) spec = { ...spec, ...obj(sp.data) };

  let categoryIds = mac ? (mac.category_ids ? list(mac.category_ids) : list(mac.categories).map((c) => c.id)) : [];
  let answers = clone(obj(mac && mac.answers));
  const cp = pick("compliance");
  if (cp) { categoryIds = list(obj(cp.data).categories); answers = clone(obj(obj(cp.data).answers)); }

  const photos = { ...obj(mac && mac.photos) };
  for (const p of mine) {
    if (!p.section.startsWith("photo:")) continue;
    const slot = p.section.slice(6);
    if (p.deleted) delete photos[slot];
    else photos[slot] = str(obj(p.data).dataUrl);
  }

  const rules = list(documents && documents.rules);
  return {
    exists: !!mac || mine.length > 0,
    pending: mine.length > 0,
    registration: str(mac && mac.registration) || str(aircraft.registration),
    spec, categoryIds, answers, photos,
    categories: rules.length ? renderCategories(rules, categoryIds, answers) : list(mac && mac.categories),
  };
}

/** Macに届いて日誌に入った部分（Macの時刻が同じか新しいもの）を、このiPhoneから消す。 */
export async function cleanup(data) {
  const docs = obj(data && data.documents && data.documents.aircraft);
  for (const p of await db.getAllGubi()) {
    const mac = obj(obj(docs[p.serial]).sync)[p.section];
    if (mac && time(mac) >= time(p.updatedAt)) await db.deleteGubi(p.key);
  }
}

// ---------- 写真 ----------

/** 写真を縮小して JPEG の data URL にする（長い辺 max px）。 */
export async function toJpeg(file, max = 1600, quality = 0.8) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("写真を読み込めませんでした"));
      img.src = url;
    });
    for (const [size, q] of [[max, quality], [1200, 0.7], [900, 0.6]]) {
      const scale = Math.min(1, size / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/jpeg", q);
      if ((data.length - data.indexOf(",") - 1) * 0.75 <= MAX_PHOTO_BYTES * 0.8) return data;
    }
    throw new Error("写真が大きすぎます");
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- 入力画面 ----------

let editing = null;

function photoSlot(slot, caption) {
  const box = el("div", "gubi-photo");
  box.dataset.slot = slot;
  const draw = () => {
    box.innerHTML = "";
    const src = editing.state.photos[slot];
    if (src) {
      const img = el("img");
      img.src = src; img.alt = caption;
      box.append(img);
    } else {
      box.append(el("div", "doc-photo-none", "なし"));
    }
    box.append(el("div", "gubi-photo-caption", caption));
    const actions = el("div", "gubi-photo-actions");
    // カメラで撮る（iPhoneでは capture 付きの入力でカメラが開く）／写真ライブラリから選ぶ
    for (const [label, capture] of [["写真を撮る", true], ["写真を選ぶ", false]]) {
      const l = el("label", "btn small", label);
      const input = el("input");
      input.type = "file"; input.accept = "image/*"; input.hidden = true;
      if (capture) input.setAttribute("capture", "environment");
      input.dataset.slot = slot;
      input.onchange = async () => {
        const file = input.files && input.files[0];
        input.value = "";
        if (!file) return;
        try {
          editing.state.photos[slot] = await toJpeg(file);
          draw();
        } catch (e) {
          alert(e.message || String(e));
        }
      };
      l.append(input);
      actions.append(l);
    }
    if (src) {
      const del = el("button", "btn small danger", "削除");
      del.type = "button";
      del.onclick = () => { delete editing.state.photos[slot]; draw(); };
      actions.append(del);
    }
    box.append(actions);
  };
  draw();
  return box;
}

function textField(key, label, value, multiline = false) {
  const f = el("label", "field", label);
  const input = el(multiline ? "textarea" : "input");
  if (!multiline) input.type = "text";
  else input.rows = 3;
  input.id = `gb-${key}`;
  input.value = str(value);
  f.append(input);
  return f;
}

function complianceCard(rules) {
  const card = el("div", "card");
  card.id = "gb-compliance";
  card.append(el("h2", null, "無人航空機の追加基準への適合性"));
  card.append(el("p", "help", "許可・承認を受ける飛行形態を選び、基準ごとに 適／否 を選びます。"
    + "「否」のときは代替となる安全対策を選ぶか書いてください。"));
  const st = editing.state;
  for (const c of rules) {
    const on = st.categoryIds.includes(c.id);
    const l = el("label", "chk gubi-cat");
    const cb = el("input");
    cb.type = "checkbox"; cb.checked = on; cb.dataset.category = c.id;
    cb.onchange = () => {
      readCompliance();
      st.categoryIds = cb.checked ? [...st.categoryIds, c.id] : st.categoryIds.filter((x) => x !== c.id);
      // 審査要領の順に並べる
      st.categoryIds = rules.map((x) => x.id).filter((id) => st.categoryIds.includes(id));
      card.replaceWith(complianceCard(rules));
    };
    l.append(cb, ` ${c.clause} ${c.heading}`);
    card.append(l);
    if (!on) continue;
    for (const r of list(c.requirements)) {
      const a = st.answers[r.id] || (st.answers[r.id] = { result: "", alt_selection: "", alt_other: "" });
      const box = el("div", "gubi-req");
      box.append(el("div", "doc-std", r.standard));
      const seg = el("div", "seg");
      for (const v of ["適", "否"]) {
        const rl = el("label", "chk");
        const radio = el("input");
        radio.type = "radio"; radio.name = `gb-res-${r.id}`; radio.value = v; radio.checked = a.result === v;
        radio.onchange = () => { readCompliance(); card.replaceWith(complianceCard(rules)); };
        rl.append(radio, el("span", null, v));
        seg.append(rl);
      }
      box.append(seg);
      if (a.result === "否") {
        const sel = el("select");
        sel.id = `gb-alt-${r.id}`;
        sel.append(new Option("代替措置を選んでください", ""));
        list(r.alternatives).forEach((t, i) => sel.append(new Option(t, String(i))));
        sel.append(new Option("自分で書く", OTHER));
        sel.value = a.alt_selection;
        const other = el("textarea");
        other.id = `gb-other-${r.id}`; other.rows = 3; other.value = str(a.alt_other);
        other.placeholder = "代替となる安全対策";
        other.hidden = sel.value !== OTHER;
        sel.onchange = () => { other.hidden = sel.value !== OTHER; };
        const f = el("label", "field", "代替措置");
        f.append(sel, other);
        box.append(f);
      }
      box.append(photoSlot(`req:${r.id}`, "適合性を示す写真（任意）"));
      card.append(box);
    }
  }
  return card;
}

/** 画面の適合性の入力を、編集中の内容に読み込む。 */
function readCompliance() {
  const st = editing.state;
  for (const rid of Object.keys(st.answers)) {
    const checked = document.querySelector(`input[name="gb-res-${rid}"]:checked`);
    if (checked) st.answers[rid].result = checked.value;
    const sel = document.getElementById(`gb-alt-${rid}`);
    if (sel) st.answers[rid].alt_selection = sel.value;
    const other = document.getElementById(`gb-other-${rid}`);
    if (other) st.answers[rid].alt_other = other.value.trim();
  }
}

/** 機体の具備資料を直す画面を開く。 */
export async function openGubiEditor(serial) {
  const saved = await db.getCarry();
  const documents = saved && saved.data && saved.data.documents;
  if (!documents || !Array.isArray(documents.rules)) {
    alert("具備資料を直すには、新しいMac版から日誌を受け取ってください（Mac版を更新して同期すると届きます）。");
    return;
  }
  const aircraft = (await db.getAllAircraft()).find((a) => a.serial === serial)
    || { serial, name: str(obj(obj(documents.aircraft)[serial]).label) };
  const eff = effective(documents, serial, await db.getAllGubi(), aircraft);
  const initial = { spec: { ...eff.spec }, categoryIds: [...eff.categoryIds], answers: clone(eff.answers),
    photos: { ...eff.photos } };
  // 空欄はDJIの公表値で埋めておく（保存するまでは書類に載らない。Mac版と同じ）
  const dji = djiValues(documents, eff.spec.name || aircraft.name);
  const prefilled = [];
  const spec = { ...eff.spec };
  for (const [k, v] of Object.entries(obj(dji))) {
    if (v && !str(spec[k]).trim()) { spec[k] = v; prefilled.push(k); }
  }
  editing = { serial, documents, initial,
    state: { spec, categoryIds: [...eff.categoryIds], answers: clone(eff.answers), photos: { ...eff.photos } } };

  $("#gubi-title").textContent = "具備資料を直す";
  const body = $("#gubi-body");
  body.innerHTML = "";

  const c1 = el("div", "card");
  c1.append(el("h2", null, "無人航空機の製造者、名称、重量等"));
  c1.append(el("p", "help", `登録記号: ${eff.registration || "（未入力。Mac版の設定で入れます）"}`));
  if (prefilled.length) {
    const m = list(documents.dji_models).find((x) => list(x.names).some((n) => modelKey(n) === modelKey(spec.name)));
    c1.append(el("p", "help", `空欄に DJI の公表値を入れました（${m ? m.checked : ""} 確認）。`
      + "保存すると書類に載ります。実際の機体と違うところは直してください。"));
  }
  for (const [k, label] of list(documents.spec_fields)) c1.append(textField(k, label, spec[k]));
  const g1 = el("div", "gubi-photos");
  for (const slot of GROUP1) g1.append(photoSlot(slot, str(obj(documents.photo_slots)[slot])));
  c1.append(g1);
  body.append(c1);

  const c2 = el("div", "card");
  c2.append(el("h2", null, "無人航空機の運用限界等"));
  for (const [k, label] of list(documents.limit_fields)) c2.append(textField(k, label, spec[k]));
  const g2 = el("div", "gubi-photos");
  for (const slot of GROUP2) g2.append(photoSlot(slot, str(obj(documents.photo_slots)[slot])));
  c2.append(g2);
  c2.append(textField("flight_method", "飛行させる方法（点検・整備の方法を含む）", spec.flight_method, true));
  body.append(c2);

  body.append(complianceCard(list(documents.rules)));

  const foot = el("div", "sheet-foot");
  const save2 = el("button", "btn primary block", "保存");
  save2.type = "button";
  save2.onclick = saveGubi;
  foot.append(save2);
  body.append(foot);

  $("#gubi-editor").hidden = false;
  body.scrollTop = 0;
}

function closeGubi() {
  $("#gubi-editor").hidden = true;
  editing = null;
}

async function saveGubi() {
  if (!editing) return;
  const { serial, documents, initial, state } = editing;
  for (const k of textKeys(documents)) {
    const input = document.getElementById(`gb-${k}`);
    if (input) state.spec[k] = input.value.trim();
  }
  readCompliance();
  const now = new Date().toISOString();
  const part = (section, extra) => ({ key: partKey(serial, section), serial, section, updatedAt: now, sentAt: "", ...extra });
  const parts = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const specOut = Object.fromEntries(textKeys(documents).map((k) => [k, str(state.spec[k])]));
  if (!same(specOut, Object.fromEntries(textKeys(documents).map((k) => [k, str(initial.spec[k])])))) {
    parts.push(part("spec", { data: specOut }));
  }
  // 選んでいない飛行形態の基準の答えも残す（選び直したときに戻るように。Mac版と同じ）
  const answers = Object.fromEntries(Object.entries(state.answers).filter(([, a]) => a.result || a.alt_selection || a.alt_other));
  const initialAnswers = Object.fromEntries(Object.entries(initial.answers).filter(([, a]) => a.result || a.alt_selection || a.alt_other));
  if (!same(state.categoryIds, initial.categoryIds) || !same(answers, initialAnswers)) {
    parts.push(part("compliance", { data: { categories: state.categoryIds, answers } }));
  }
  for (const slot of new Set([...Object.keys(state.photos), ...Object.keys(initial.photos)])) {
    if (state.photos[slot] === initial.photos[slot]) continue;
    parts.push(state.photos[slot]
      ? part(`photo:${slot}`, { data: { dataUrl: state.photos[slot] } })
      : part(`photo:${slot}`, { deleted: true, data: {} }));
  }
  if (parts.length) await db.putGubiList(parts);
  closeGubi();
  const { renderCarry } = await import("./carry.js");
  await renderCarry();
  // Googleドライブ同期を設定していれば、すぐ送る（app.js が受け取る）
  if (parts.length) document.dispatchEvent(new Event("inspection-saved"));
}

export function bindGubi() {
  $("#gubi-close").onclick = closeGubi;
  $("#gubi-save").onclick = saveGubi;
}
