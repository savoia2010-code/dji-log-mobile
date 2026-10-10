// 携行タブ（Mac版から受け取った飛行日誌の提示）を WebKit で検証する。
//
//   python3 -m http.server 8310 --directory . &
//   node tools/verify-carry.mjs <Mac版が書き出した 飛行日誌_携行用.json> [画面写真の保存先.png]
//
// 受け取り → 機体ごとの3記録の表示 → このiPhoneだけにある点検の併記
// → 開き直しても残るか、を確かめる。

import { webkit, devices } from "playwright";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const URL = process.env.APP_URL || "http://localhost:8310/";
const [carryPath, shotPath] = process.argv.slice(2);
if (!carryPath) { console.error("携行用ファイルを指定してください"); process.exit(2); }

const browser = await webkit.launch();
const context = await browser.newContext({ ...devices["iPhone 15"] });
const page = await context.newPage();
const problems = [];
const isHarnessNoise = (t) => t.includes("Refused to apply a stylesheet");
page.on("pageerror", (e) => problems.push(`実行時エラー: ${e}`));
page.on("console", (m) => {
  if (m.type() === "error" && !isHarnessNoise(m.text())) problems.push(`コンソール: ${m.text()}`);
});
const dialogs = [];
page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });

await page.goto(URL, { waitUntil: "networkidle" });
const firstView = await page.evaluate(() => !document.getElementById("view-carry").hidden);
const warningShown = await page.evaluate(
  () => !document.querySelector(".install-warning").hidden);

await page.setInputFiles("#carry-input", {
  name: basename(carryPath), mimeType: "application/json", buffer: readFileSync(carryPath),
});
await page.waitForFunction(() => /Macで作成/.test(document.getElementById("carry-info").textContent));

const sections = await page.$$eval("#carry-body .section-title", (n) => n.map((x) => x.textContent));
// 具備資料（あれば）: 機体の書類・許可書を開くボタン・今日の記録の許可書の行
const documents = await page.evaluate(() => ({
  機体の書類: !!document.querySelector("#carry-body .doc-title"),
  許可書を開く: [...document.querySelectorAll("#carry-body button")].some((b) => b.textContent.includes("許可書のPDFを開く")),
  今日の許可書: [...document.querySelectorAll("#carry-today .today-row")].map((r) => r.textContent).find((t) => t.startsWith("許可書")) || null,
}));
const pills = await page.$$eval("#carry-body .chip", (n) => n.map((x) => x.textContent));

// 点検整備の記録がある機体を選び、このiPhoneで点検を1件記録して併記されるか
const data = JSON.parse(readFileSync(carryPath, "utf-8"));
const target = data.aircraft.find((a) => a.maintenance.length) || data.aircraft[0];
await page.click('.tab-btn[data-view="inspections"]');
await page.click("#insp-new");
await page.selectOption("#in-aircraft", target.serial);
await page.click("text=すべて「正常」");
await page.click("#insp-save");
await page.click('.tab-btn[data-view="carry"]');
if (pills.length) await page.click(`#carry-body .chip >> text=${target.label}`);
await page.waitForSelector("text=iPhoneのみ");
const sectionsAfter = await page.$$eval("#carry-body .section-title", (n) => n.map((x) => x.textContent));
const layout = await page.evaluate(() => ({
  横スクロール量: document.documentElement.scrollWidth - document.documentElement.clientWidth,
}));
if (shotPath) await page.screenshot({ path: shotPath, fullPage: true });

await page.reload({ waitUntil: "networkidle" });
const persisted = await page.evaluate(() => document.getElementById("carry-info").textContent);

console.log(JSON.stringify({
  起動時に携行タブ: firstView, ホーム画面追加の案内: warningShown, 機体: pills,
  表示: sections, 具備資料: documents, 点検追加後: sectionsAfter, ...layout, 開き直し後: persisted, dialogs, problems,
}, null, 1));
await browser.close();
// 具備資料を含むファイルなら、表示されていなければ失敗にする
const expectDocs = !!data.documents && Object.keys(data.documents.aircraft || {}).length > 0;
const docsOk = !expectDocs || (documents.機体の書類 && documents.許可書を開く && documents.今日の許可書);
process.exit(problems.length || !docsOk ? 1 : 0);
