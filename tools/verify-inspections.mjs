// 日常点検の入力から「Macへ送る」までを WebKit（Safariと同じエンジン）で検証する。
//
//   python3 -m http.server 8310 --directory . &
//   node tools/verify-inspections.mjs [書き出したファイルの保存先.json]
//
// 実機でしか確かめられないのは、共有メニューから iCloud Drive に保存する操作だけ。
// WebKit は JSON ファイルの共有に対応している（canShare が true）ので、実機と同じ
// 共有の経路を通る。ただし共有メニューの画面は出ないため、navigator.share を
// 差し替えて、渡されたファイルを受け取る。

import { webkit, devices } from "playwright";
import { writeFileSync } from "node:fs";

const URL = process.env.APP_URL || "http://localhost:8310/";
const outPath = process.argv[2];
// 画面写真は書き出し先と同じフォルダに置く
const shot = (name) => outPath ? outPath.replace(/[^/]*$/, name) : null;

const browser = await webkit.launch();
const context = await browser.newContext({
  ...devices["iPhone 15"],
  acceptDownloads: true,
  permissions: ["geolocation"],
  geolocation: { latitude: 34.4097, longitude: 133.2012 }, // 尾道市内（陸上）
});
const page = await context.newPage();
await page.addInitScript(() => {
  navigator.share = async ({ files }) => {
    window.__shared = { name: files[0].name, type: files[0].type, text: await files[0].text() };
  };
});

const problems = [];
const isHarnessNoise = (t) => t.includes("Refused to apply a stylesheet");
page.on("pageerror", (e) => problems.push(`実行時エラー: ${e}`));
page.on("console", (m) => {
  if (m.type() === "error" && !isHarnessNoise(m.text())) problems.push(`コンソール: ${m.text()}`);
});
page.on("dialog", (d) => d.accept());

await page.goto(URL, { waitUntil: "networkidle" });
await page.click('.tab-btn[data-view="inspections"]');
await page.click("#insp-new");

// 機体がまだ無い状態なので「一覧にない機体」で名前を入れる
await page.selectOption("#in-aircraft", "__other__");
await page.fill("#in-aircraft-name", "DJI Neo");
await page.click("text=現在地の住所を入れる");
await page.waitForFunction(() => document.getElementById("in-place").value !== "", null,
  { timeout: 20000 });
const place = await page.inputValue("#in-place");
await page.click("text=すべて「正常」");
await page.check('input[name="res-1"][value="異常"]');
await page.fill("#rem-1", "先端に小さな欠け");
await page.click(`text=を追記`);
if (shot("insp-form.png")) await page.screenshot({ path: shot("insp-form.png") });
await page.click("#insp-save");
await page.waitForFunction(() => /未送信/.test(document.getElementById("insp-list").textContent));

const before = await page.textContent("#insp-list");
const sendLabel = await page.textContent("#insp-send");

await page.click("#insp-send");
await page.waitForFunction(() => window.__shared);
const shared = await page.evaluate(() => window.__shared);
const fileName = `${shared.name} (${shared.type})`;
if (outPath) writeFileSync(outPath, shared.text);
await page.waitForFunction(() => /送信済み/.test(document.getElementById("insp-list").textContent));
const after = await page.textContent("#insp-list");
if (shot("insp-list.png")) await page.screenshot({ path: shot("insp-list.png") });

// 開き直しても残っているか（IndexedDB に保存されたか）
await page.reload({ waitUntil: "networkidle" });
await page.click('.tab-btn[data-view="inspections"]');
const persisted = await page.textContent("#insp-list");

console.log(JSON.stringify({
  place, before, sendLabel, fileName, after, persisted: persisted.includes("DJI Neo"), problems,
}, null, 1));
await browser.close();
process.exit(problems.length ? 1 : 0);
