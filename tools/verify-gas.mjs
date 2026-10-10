// Googleドライブ同期（GAS）の検証。
//
//   node tools/verify-gas.mjs <検証用GASサーバーのURL> <合言葉>
//
// 検証用サーバーは Mac版の gas/mock-server.mjs（Code.gs を手元で動かすもの）。
// ブラウザからは本物と同じ https://script.google.com/... を呼び（CSP の許可も確かめる）、
// Playwright で手元のサーバーへつなぐ。本物は結果を 302 で別のURLへ転送して返すが、
// Playwright の WebKit はつなぎ替えで 302 を返せないので、転送後の結果をそのまま返す
// （転送をたどることはブラウザの標準の動作。Mac版のテストでは転送も確かめている）。
//
// 確かめること:
//   設定コードを貼る → Macの日誌を自動で受け取る → 点検を保存すると自動で送られる
//   → バックアップが取られる → iPhoneの中身が消えてもGoogleドライブから戻せる

import { webkit, devices } from "playwright";
import { readFileSync } from "node:fs";

const URL = process.env.APP_URL || "http://localhost:8310/";
const [mock, token] = process.argv.slice(2);
const SCRIPT = "https://script.google.com/macros/s/TESTDEPLOYMENT/exec";
const setupCode = "DJILOG1:" + Buffer.from(JSON.stringify({ url: SCRIPT, token }))
  .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const callMock = async (action, payload = {}) =>
  (await fetch(`${mock}/exec`, { method: "POST", body: JSON.stringify({ token, action, ...payload }) })).json();

// Mac版が携行用の日誌を送ったところから始める
const carry = JSON.parse(readFileSync(new globalThis.URL("../tests/fixtures/carry-sample.json", import.meta.url)));
carry.generatedAt = new Date().toISOString();
await callMock("putCarry", { data: carry });

const browser = await webkit.launch();
// サービスワーカー経由の通信には Playwright のつなぎ替えが効かないので、検証では止める
const context = await browser.newContext({ ...devices["iPhone 15"], serviceWorkers: "block" });
const problems = [];
let calls = 0;
const actions = [];
await context.route("https://script.google.com/**", async (route) => {
  calls++;
  actions.push(JSON.parse(route.request().postData() || "{}").action);
  const r = await fetch(`${mock}/exec`, { method: "POST", body: route.request().postData() });
  await route.fulfill({ status: 200, contentType: "application/json",
    headers: { "access-control-allow-origin": "*" }, body: await r.text() });
});

const page = await context.newPage();
const isHarnessNoise = (t) => t.includes("Refused to apply a stylesheet");
page.on("pageerror", (e) => problems.push(`実行時エラー: ${e}`));
page.on("console", (m) => {
  if (m.type() === "error" && !isHarnessNoise(m.text())) problems.push(`コンソール: ${m.text()}`);
});
const dialogs = [];
page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });

await page.goto(URL, { waitUntil: "networkidle" });
await page.click('.tab-btn[data-view="settings"]');
await page.fill("#gas-code", setupCode);
await page.click("#gas-save");
await page.waitForFunction(() => !document.getElementById("gas-set").hidden);
await page.waitForFunction(() => /受信|変更/.test(document.getElementById("gas-status").textContent), null, { timeout: 15000 });
const afterSetup = await page.textContent("#gas-status");
const carryInfo = await page.textContent("#carry-info");

// 点検を記録すると、自動で送られる
await page.click('.tab-btn[data-view="inspections"]');
await page.click("#insp-new");
await page.selectOption("#in-aircraft", "SN-TEST-0001");
await page.click("text=すべて「正常」");
await page.click("#insp-save");
await page.waitForFunction(() => /送信済み/.test(document.getElementById("insp-list").textContent), null, { timeout: 15000 });
// 何も変わっていなければ、同期してもバックアップを送り直さない（通信を減らす）
await page.click('.tab-btn[data-view="settings"]');
const beforeIdle = actions.length;
await page.click("#gas-sync");
await page.waitForFunction(() => /変更はありません/.test(document.getElementById("gas-status").textContent), null, { timeout: 15000 });
const idleActions = actions.slice(beforeIdle);
// 飛行記録を読み込むと、原本がMac版へ送られる（読み込みの解析は別の検証で確かめる。
// ここでは、読み込んだときに呼ぶ「送る順番待ちに入れる」から先を確かめる）
const LOG_NAME = "DJIFlightRecord_2026-07-14_[10-00-00].txt";
const logBytes = Array.from({ length: 300000 }, (_, i) => (i * 7) % 256);   // 文字にならない値も含む
await page.evaluate(async ({ name, bytes }) => {
  const gas = await import("./js/gas.js");
  await gas.queueFlightLog(new File([new Uint8Array(bytes)], name));
}, { name: LOG_NAME, bytes: logBytes });
await page.click("#gas-sync");
await page.waitForFunction(() => /飛行記録 1件を送信/.test(document.getElementById("gas-status").textContent), null, { timeout: 15000 });
const logs = (await callMock("listFlightLogs")).items || [];
const got = logs.length ? await callMock("getFlightLog", { id: logs[0].id }) : {};
const sameBytes = got.data === Buffer.from(logBytes).toString("base64");
const outboxLeft = await page.evaluate(async () => (await (await import("./js/db.js")).getOutboxKeys()).length);

// 前に読み込んだ飛行でも、Macの日誌に無ければ、読み込み直したときに原本を送る
const OLD_NAME = "DJIFlightRecord_2026-08-22_[10-00-00].txt";
await page.evaluate(async (name) => {
  const db = await import("./js/db.js");
  await db.putFlight({ fileName: name, aircraftSn: "SN-TEST-0001", aircraftName: "テスト機",
    takeoffTime: "2026-08-22T01:00:00.000Z", landingTime: "2026-08-22T01:05:00.000Z",
    durationSeconds: 300, totalDistanceM: 500, maxAltitudeM: 30, hasGps: true, lat: 0, lon: 0, place: "" });
}, OLD_NAME);
await page.setInputFiles("#file-input", { name: OLD_NAME, mimeType: "text/plain", buffer: Buffer.from("old log") });
await page.waitForFunction(() => /Macへ送ります/.test(document.getElementById("import-text").textContent), null, { timeout: 15000 });
for (let i = 0; i < 100; i++) {
  if (((await callMock("listFlightLogs")).items || []).some((x) => x.name === OLD_NAME)) break;
  await page.waitForTimeout(100);
}
const resentOld = ((await callMock("listFlightLogs")).items || []).some((x) => x.name === OLD_NAME);

const inbox = (await callMock("listInbox")).items || [];
const sentRecords = inbox.flatMap((i) => JSON.parse(i.content).inspections || []);
const backup = (await callMock("getBackup")).backup;

// Macで変えた「飛行とみなす距離」が、携行用の日誌と一緒に届いて合わさる
const carry2 = { ...carry, generatedAt: new Date(Date.now() + 1000).toISOString(),
  criteria: { distanceThresholdM: 6, altitudeThresholdM: 0, updatedAt: new Date().toISOString() } };
await callMock("putCarry", { data: carry2 });
await page.click('.tab-btn[data-view="settings"]');
await page.click("#gas-sync");
await page.waitForFunction(() => document.getElementById("dist-threshold").value === "6", null, { timeout: 15000 }).catch(() => {});
const fromMac = await page.inputValue("#dist-threshold");

// このiPhoneで変えると、変えた時刻と一緒にバックアップに入る（Mac版がそれを見て合わせる）。
// 機体の情報（Macに無い、使い始める前の飛行時間）もバックアップに残る
await page.evaluate(async () => {
  const db = await import("./js/db.js");
  const a = (await db.getAllAircraft()).find((x) => x.serial === "SN-TEST-0001");
  await db.putAircraft({ ...a, initialFlightSeconds: 3600 });
});
await page.fill("#dist-threshold", "5");
await page.click("#save-settings");
for (let i = 0; i < 100; i++) {
  const b = (await callMock("getBackup")).backup;
  if (b && b.settings && b.settings.distanceThresholdM === 5) break;
  await page.waitForTimeout(100);
}
const backedUpSettings = ((await callMock("getBackup")).backup || {}).settings || {};

// iPhoneの中身が消えた場合: 保存先を消して開き直し、設定し直して戻す
// アプリが保存先を開いたままだと消せないので、アプリの無いページ（同じ場所）へ移ってから消す
await page.goto(new globalThis.URL("manifest.webmanifest", URL).href);
const deleted = await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.deleteDatabase("dji-log-mobile");
  r.onsuccess = () => res(true); r.onerror = () => res(false);
}));
if (!deleted) problems.push("検証の準備: 保存先を消せませんでした");
await page.goto(URL, { waitUntil: "networkidle" });
await page.click('.tab-btn[data-view="settings"]');
// 貼り付けで先頭が小文字になったり、改行が混ざったりしても受け付ける（実機で起きた）
await page.fill("#gas-code", ` ${setupCode.replace("DJILOG1:", "djilog1:")}\n`);
await page.click("#gas-save");
await page.waitForFunction(() => !document.getElementById("gas-set").hidden);
const before = dialogs.length;
await page.click("#gas-restore");
// 確認と結果の2つの案内が出終わるのを待つ
for (let i = 0; i < 50 && dialogs.length < before + 2; i++) await page.waitForTimeout(100);
await page.click('.tab-btn[data-view="inspections"]');
await page.waitForFunction(() => /全項目 正常/.test(document.getElementById("insp-list").textContent),
  null, { timeout: 10000 }).catch(() => {});
const restored = await page.textContent("#insp-list");
const restoredSettings = await page.evaluate(async () => {
  const db = await import("./js/db.js");
  const a = (await db.getAllAircraft()).find((x) => x.serial === "SN-TEST-0001");
  return { 距離: (await db.getSettings()).distanceThresholdM, 使い始める前の飛行時間: a && a.initialFlightSeconds,
           画面の距離: document.getElementById("dist-threshold").value };
});

// 合言葉が違う設定コードでは同期できないことを知らせる
const wrong = "DJILOG1:" + Buffer.from(JSON.stringify({ url: SCRIPT, token: "wrong" }))
  .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
await page.click('.tab-btn[data-view="settings"]');
await page.click("#gas-clear");
await page.fill("#gas-code", wrong);
await page.click("#gas-save");
await page.waitForFunction(() => /合言葉/.test(document.getElementById("gas-status").textContent), null, { timeout: 15000 });
const wrongStatus = await page.textContent("#gas-status");

// QRコードで開いた場合（アドレスの #setup= に設定コード）。受け取ったらアドレスから消え、
// Safariで開いたときの案内から設定できる
const qr = await context.newPage();
const qrDialogs = [];
qr.on("dialog", (d) => { qrDialogs.push(d.message()); d.accept(); });
await qr.goto(`${URL}#setup=${encodeURIComponent(setupCode)}`, { waitUntil: "networkidle" });
await qr.waitForSelector(".setup-card", { timeout: 10000 });
const hashGone = !qr.url().includes("setup=");
const copyOffered = await qr.isVisible("text=設定コードをコピー");
await qr.click(".setup-card >> text=ここに設定する");
for (let i = 0; i < 50 && !qrDialogs.length; i++) await qr.waitForTimeout(100);

const result = {
  設定後: afterSetup, 日誌の受信: carryInfo.includes("Macで作成"),
  送られた点検: sentRecords.length, バックアップの点検: backup ? backup.inspections.length : 0,
  戻したあと: restored.includes("全項目 正常"), 合言葉違い: wrongStatus,
  読み込み直しで原本を送った: resentOld,
  Macの判定が届いた: fromMac, バックアップの設定: backedUpSettings, 戻した設定: restoredSettings,
  空のときに戻すか聞いた: dialogs.some((m) => m.includes("バックアップがあります")),
  変更なしの同期: idleActions,
  飛行記録の送信: { 件数: logs.length, 名前: logs[0] && logs[0].name, 中身が同じ: sameBytes, 残り: outboxLeft },
  受け取った日誌の時刻: backup ? backup.carryGeneratedAt === carry.generatedAt : false,
  QRコード: { アドレスから消えた: hashGone, コピーの案内: copyOffered, 結果: qrDialogs[0] || "" },
  呼び出し回数: calls, dialogs, problems,
};
console.log(JSON.stringify(result, null, 1));
await browser.close();
const ok = result.日誌の受信 && result.送られた点検 === 1 && result.バックアップの点検 === 1
  && result.戻したあと && result.空のときに戻すか聞いた && restoredSettings.距離 === 5 && fromMac === "6"
  && !!backedUpSettings.criteriaUpdatedAt
  && restoredSettings.使い始める前の飛行時間 === 3600 && restoredSettings.画面の距離 === "5" && resentOld && !idleActions.includes("putBackup") && idleActions.includes("getCarry")
  && result.受け取った日誌の時刻 && logs.length === 1 && logs[0].name === LOG_NAME && sameBytes && outboxLeft === 0 && /合言葉/.test(wrongStatus) && !problems.length
  && hashGone && copyOffered && /設定しました/.test(qrDialogs[0] || "");
process.exit(ok ? 0 : 1);
