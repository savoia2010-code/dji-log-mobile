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
await context.route("https://script.google.com/**", async (route) => {
  calls++;
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
const inbox = (await callMock("listInbox")).items || [];
const sentRecords = inbox.flatMap((i) => JSON.parse(i.content).inspections || []);
const backup = (await callMock("getBackup")).backup;

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
await page.fill("#gas-code", setupCode);
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

// 合言葉が違う設定コードでは同期できないことを知らせる
const wrong = "DJILOG1:" + Buffer.from(JSON.stringify({ url: SCRIPT, token: "wrong" }))
  .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
await page.click('.tab-btn[data-view="settings"]');
await page.click("#gas-clear");
await page.fill("#gas-code", wrong);
await page.click("#gas-save");
await page.waitForFunction(() => /合言葉/.test(document.getElementById("gas-status").textContent), null, { timeout: 15000 });
const wrongStatus = await page.textContent("#gas-status");

const result = {
  設定後: afterSetup, 日誌の受信: carryInfo.includes("Macで作成"),
  送られた点検: sentRecords.length, バックアップの点検: backup ? backup.inspections.length : 0,
  戻したあと: restored.includes("全項目 正常"), 合言葉違い: wrongStatus,
  呼び出し回数: calls, dialogs, problems,
};
console.log(JSON.stringify(result, null, 1));
await browser.close();
const ok = result.日誌の受信 && result.送られた点検 === 1 && result.バックアップの点検 === 1
  && result.戻したあと && /合言葉/.test(wrongStatus) && !problems.length;
process.exit(ok ? 0 : 1);
