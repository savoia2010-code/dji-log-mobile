// Googleドライブ（Google Apps Script）を介した Mac版との自動同期。
//
// 利用者が自分のGoogleアカウントで公開したスクリプト（Mac版の gas/Code.gs）を呼び、
//   - このiPhoneで記録した日常点検（未送信のもの）を送る（Mac版が取り込む）
//   - このiPhoneの中身（点検・読み込んだ飛行）をバックアップする
//   - Mac版の携行用の日誌・具備資料が新しくなっていれば受け取る
// を、アプリを開いたとき・点検を保存したとき・電波が戻ったときに自動で行う。
//
// 設定は、Mac版の設定画面に出る「設定コード」（URLと合言葉をまとめた1行）を貼るだけ。
// 送り先は利用者自身のGoogleドライブだけ（CSP でも script.google.com 以外へは送れない）。
// 本文は text/plain の JSON で送る（Apps Script は事前確認(preflight)に応答できないため）。

import { SYNC_FORMAT, SYNC_VERSION } from "./constants.js";
import * as db from "./db.js";
import * as settingsSync from "./settingsSync.js";

const PREFIX = "DJILOG1:";
const SCRIPT_URL = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
const MIN_INTERVAL_MS = 60 * 1000;   // 画面の切り替えのたびに呼ばないよう間隔を空ける
const BACKUP_FORMAT = "dji-log-mobile-backup";
let running = null;
let lastRun = 0;

export class GasError extends Error {}

/** Mac版の「設定コード」を読み取る。 */
export function parseSetupCode(code) {
  // 貼り付けたときに、iPhoneが先頭を小文字にしたり、改行や空白が混ざったりすることがある。
  // 先頭の目印は大文字・小文字を区別しない（後ろの本体は区別するので、そのまま使う）
  const text = String(code || "").replace(/[\s\u200b\ufeff]/g, "");
  if (text.slice(0, PREFIX.length).toUpperCase() !== PREFIX) throw new GasError("設定コードの形式が違います（DJILOG1: で始まる1行を貼ってください）");
  let conf;
  try {
    const b64 = text.slice(PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    conf = JSON.parse(json);
  } catch {
    throw new GasError("設定コードを読み取れませんでした。もう一度コピーして貼ってください");
  }
  if (!conf || !SCRIPT_URL.test(String(conf.url)) || !conf.token) {
    throw new GasError("設定コードの中身が正しくありません");
  }
  return { url: String(conf.url), token: String(conf.token) };
}

/**
 * QRコードで開いたときの設定コードを受け取る（アドレスの #setup= の後ろ）。
 * 受け取ったら、アドレスからすぐ消す（履歴や画面に合言葉を残さないため）。
 * # より後ろはブラウザが公開先へ送らないので、GitHub には届かない。
 */
export function takeSetupFromUrl() {
  const hash = location.hash || "";
  if (!hash.startsWith("#setup=")) return null;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    return decodeURIComponent(hash.slice("#setup=".length));
  } catch {
    return null;
  }
}

export async function getConfig() {
  const s = await db.getSettings();
  return s.gasUrl && s.gasToken ? { url: s.gasUrl, token: s.gasToken } : null;
}

export async function saveConfig(code) {
  const conf = parseSetupCode(code);
  await db.setSetting("gasUrl", conf.url);
  await db.setSetting("gasToken", conf.token);
  await db.setSetting("gasBackupDigest", "");   // 送り先が変わったかもしれないので、次は必ず送る
  return conf;
}

export async function clearConfig() {
  await db.setSetting("gasUrl", "");
  await db.setSetting("gasToken", "");
  await db.setSetting("gasStatus", null);
  await db.setSetting("gasBackupDigest", "");
}

async function call(conf, action, payload = {}) {
  let res;
  try {
    res = await fetch(conf.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: conf.token, action, ...payload }),
      redirect: "follow",
    });
  } catch {
    throw new GasError("Googleドライブに接続できませんでした（電波を確かめてください）");
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new GasError("スクリプトの応答を読めませんでした（公開の設定を確かめてください）");
  }
  if (!data || !data.ok) throw new GasError((data && data.error) || "スクリプトがエラーを返しました");
  return data;
}

const isUnsent = (r) => !r.sentAt || r.updatedAt > r.sentAt;
const UNSUPPORTED = "対応していない操作です";

/** ArrayBuffer を base64 に（大きなファイルでも落ちないよう、少しずつ変換する）。 */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * 読み込んだ飛行記録の原本を、Mac版へ送る順番待ちに入れる（同期を設定しているときだけ）。
 * 電波の無い場所で読み込んでも、次に同期したときに送られる。
 */
export async function queueFlightLog(file) {
  if (!(await getConfig())) return false;
  await db.putOutbox({ fileName: file.name, bytes: await file.arrayBuffer(), addedAt: new Date().toISOString() });
  return true;
}

/** 順番待ちの飛行記録を送る。送れた数と、残った数を返す。 */
async function sendFlightLogs(conf) {
  let sent = 0;
  const keys = await db.getOutboxKeys();
  for (const name of keys) {
    const item = await db.getOutbox(name);
    if (!item) continue;
    try {
      await call(conf, "putFlightLog", { name, data: toBase64(item.bytes) });
    } catch (e) {
      if (e instanceof GasError && e.message.includes("ファイル名")) {
        await db.deleteOutbox(name);   // 送れない名前のものは、何度送っても同じなので外す
        continue;
      }
      if (e instanceof GasError && e.message.includes(UNSUPPORTED)) {
        return { sent, waiting: keys.length - sent, outdated: true };
      }
      throw e;
    }
    await db.deleteOutbox(name);
    sent++;
  }
  return { sent, waiting: 0, outdated: false };
}

/**
 * 同期する。結果は設定の gasStatus にも残す（画面に出すため）。
 * 同時に二重に走らないようにし、force でなければ1分以内の再実行は飛ばす。
 */
export async function syncNow({ force = false } = {}) {
  const conf = await getConfig();
  if (!conf) return null;
  if (running) return running;
  if (!force && Date.now() - lastRun < MIN_INTERVAL_MS) return null;
  lastRun = Date.now();
  running = (async () => {
    const status = { time: new Date().toISOString(), ok: true, sent: 0, flights: 0, received: false, message: "" };
    let outdated = false;
    try {
      // 1. 未送信の点検を送る
      const inspections = await db.getAllInspections();
      const unsent = inspections.filter(isUnsent);
      if (unsent.length) {
        await call(conf, "putInspections", {
          data: {
            format: SYNC_FORMAT, version: SYNC_VERSION, exportedAt: new Date().toISOString(),
            inspections: unsent.map(({ sentAt, ...rest }) => rest),
          },
        });
        const now = new Date().toISOString();
        await db.putInspections(unsent.map((r) => ({ ...r, sentAt: now })));
        status.sent = unsent.length;
      }

      // 1b. 読み込んだ飛行記録の原本を送る（Mac版が解析して日誌に入れる）
      const logs = await sendFlightLogs(conf);
      status.flights = logs.sent;
      outdated = logs.outdated;

      // 2. Mac版の携行用の日誌が新しくなっていれば受け取る
      const saved = await db.getCarry();
      const got = await call(conf, "getCarry", { since: saved ? saved.data.generatedAt : "" });
      if (got.carry) {
        const { acceptCarry } = await import("./carry.js");
        status.received = await acceptCarry(got.carry);
      }

      // 3. このiPhoneの中身をバックアップする（消えたときに戻せるように）。
      //    置き換えずに、Googleドライブにあるバックアップと合わせる。置き換えると、
      //    中身が消えたiPhoneで設定し直したときに、空の中身でバックアップを
      //    上書きしてしまう（戻したいバックアップが消える）。
      //    前回から何も変わっていなければ送らない（飛行記録が増えると100KBを超えるので、
      //    画面を開くたびに送ると、出先の通信が遅いときに同期が長引く）。
      //    受け取った日誌の作成時刻も入れて、Mac版が「iPhoneに届いたか」を確かめられるようにする。
      const carryNow = await db.getCarry();
      const local = {
        inspections: await db.getAllInspections(),
        flights: await db.getAllFlights(),
        carryGeneratedAt: carryNow ? String(carryNow.data.generatedAt || "") : "",
        // Mac版と揃える設定（飛行とみなす距離・操縦者・機体の登録記号など）も、変えた時刻と
        // 一緒に残す。入れ直したときに初期値に戻らないように。Mac版もこれを見て合わせる
        sync: await settingsSync.forBackup(),
      };
      const digest = await digestOf(local);
      if (digest !== (await db.getSettings()).gasBackupDigest) {
        const remote = (await call(conf, "getBackup")).backup;
        // このiPhoneが空なのにバックアップがある（アイコンを消して追加し直した・別のiPhoneなど）
        // ときは、戻すかを聞けるように知らせる
        if (!local.inspections.length && !local.flights.length && remote && remote.format === BACKUP_FORMAT) {
          const n = { flights: (remote.flights || []).length, inspections: (remote.inspections || []).length };
          if (n.flights || n.inspections) status.restorable = n;
        }
        await call(conf, "putBackup", {
          data: { ...mergeBackup(remote, local.inspections, local.flights, local),
                  carryGeneratedAt: local.carryGeneratedAt },
        });
        await db.setSetting("gasBackupDigest", digest);
      }

      const parts = [];
      if (status.sent) parts.push(`点検 ${status.sent}件を送信`);
      if (status.flights) parts.push(`飛行記録 ${status.flights}件を送信`);
      if (status.received) parts.push("Macの日誌を受信");
      status.message = parts.join("、") || "変更はありませんでした";
      if (outdated) {
        status.message += "。Googleドライブのスクリプトが古いため、飛行記録はまだ送れません"
          + "（Mac版の「設定」→「Googleドライブ同期」の案内で更新してください。送れなかった記録は残してあります）";
      }
    } catch (e) {
      status.ok = false;
      status.message = e instanceof GasError ? e.message : `同期できませんでした（${e.message || e}）`;
    }
    await db.setSetting("gasStatus", status);
    return status;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

/**
 * バックアップを合わせる。点検は識別子ごとに新しい方、飛行は記録ファイル名ごと。
 * 合わせるだけなので、バックアップの記録が減ることはない。
 */
export function mergeBackup(remote, inspections, flights, { sync = {} } = {}) {
  const old = remote && remote.format === BACKUP_FORMAT ? remote : { inspections: [], flights: [] };
  const insp = new Map();
  for (const r of [...(old.inspections || []), ...inspections]) {
    if (!r || !r.id) continue;
    const cur = insp.get(r.id);
    if (!cur || String(r.updatedAt) >= String(cur.updatedAt)) insp.set(r.id, r);
  }
  const fl = new Map();
  for (const f of [...(old.flights || []), ...flights]) {
    if (f && f.fileName) fl.set(f.fileName, f);   // 手元のものを後に置き、手元を優先する
  }
  return {
    format: BACKUP_FORMAT, version: 1, savedAt: new Date().toISOString(),
    inspections: [...insp.values()], flights: [...fl.values()],
    // 設定は項目ごとに新しく変えた方（入れ直したばかりのiPhoneの初期値で上書きしない）
    sync: settingsSync.merge(old.sync, sync),
  };
}

async function digestOf(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Googleドライブのバックアップから戻す。手元に無いもの・手元より新しいものだけを入れる
 * （手元で直した内容を古いバックアップで上書きしない）。
 */
export async function restoreFromBackup() {
  const conf = await getConfig();
  if (!conf) throw new GasError("Googleドライブ同期が未設定です");
  const { backup } = await call(conf, "getBackup");
  if (!backup || backup.format !== BACKUP_FORMAT) throw new GasError("バックアップがありません");

  const mine = new Map((await db.getAllInspections()).map((r) => [r.id, r]));
  const insp = (backup.inspections || []).filter((r) => r && r.id
    && (!mine.has(r.id) || String(r.updatedAt) > String(mine.get(r.id).updatedAt)));
  await db.putInspections(insp);

  const have = new Set((await db.getAllFlights()).map((f) => f.fileName));
  const flights = (backup.flights || []).filter((f) => f && f.fileName && !have.has(f.fileName));
  await db.putFlights(flights);
  for (const f of flights) await db.ensureAircraft(f.aircraftSn, f.aircraftName);

  // 設定は、このiPhoneより後に変えたもの（と、このiPhoneでまだ決めていないもの）を戻す
  const restoredSettings = (await settingsSync.applyRemote(backup.sync)).length;
  return { inspections: insp.length, flights: flights.length, settings: restoredSettings,
           savedAt: backup.savedAt };
}
