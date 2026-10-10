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

const PREFIX = "DJILOG1:";
const SCRIPT_URL = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
const MIN_INTERVAL_MS = 60 * 1000;   // 画面の切り替えのたびに呼ばないよう間隔を空ける
const BACKUP_FORMAT = "dji-log-mobile-backup";

let running = null;
let lastRun = 0;

export class GasError extends Error {}

/** Mac版の「設定コード」を読み取る。 */
export function parseSetupCode(code) {
  const text = String(code || "").trim();
  if (!text.startsWith(PREFIX)) throw new GasError("設定コードの形式が違います（DJILOG1: で始まる1行を貼ってください）");
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

export async function getConfig() {
  const s = await db.getSettings();
  return s.gasUrl && s.gasToken ? { url: s.gasUrl, token: s.gasToken } : null;
}

export async function saveConfig(code) {
  const conf = parseSetupCode(code);
  await db.setSetting("gasUrl", conf.url);
  await db.setSetting("gasToken", conf.token);
  return conf;
}

export async function clearConfig() {
  await db.setSetting("gasUrl", "");
  await db.setSetting("gasToken", "");
  await db.setSetting("gasStatus", null);
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
    const status = { time: new Date().toISOString(), ok: true, sent: 0, received: false, message: "" };
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

      // 2. このiPhoneの中身をバックアップする（消えたときに戻せるように）。
      //    置き換えずに、Googleドライブにあるバックアップと合わせる。置き換えると、
      //    中身が消えたiPhoneで設定し直したときに、空の中身でバックアップを
      //    上書きしてしまう（戻したいバックアップが消える）。
      const remote = (await call(conf, "getBackup")).backup;
      await call(conf, "putBackup", {
        data: mergeBackup(remote, await db.getAllInspections(), await db.getAllFlights()),
      });

      // 3. Mac版の携行用の日誌が新しくなっていれば受け取る
      const saved = await db.getCarry();
      const got = await call(conf, "getCarry", { since: saved ? saved.data.generatedAt : "" });
      if (got.carry) {
        const { acceptCarry } = await import("./carry.js");
        status.received = await acceptCarry(got.carry);
      }
      const parts = [];
      if (status.sent) parts.push(`点検 ${status.sent}件を送信`);
      if (status.received) parts.push("Macの日誌を受信");
      status.message = parts.join("、") || "変更はありませんでした";
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
export function mergeBackup(remote, inspections, flights) {
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
  };
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
  return { inspections: insp.length, flights: flights.length, savedAt: backup.savedAt };
}
