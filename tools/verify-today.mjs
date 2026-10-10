// 「今日の記録」の検証。その日に飛ばした分（Macにまだ無い飛行）を
// iPhoneで読み込んだとき、携行タブに並び、総飛行時間がMacの続きから数えられるか。
//
//   node tools/verify-today.mjs <携行用.json> <その日の飛行記録.txt> <その日時 ISO> [期待する総飛行時間 H:MM]
//
// 飛行記録の代わりに、解析済みの飛行を表す .json（tests/fixtures/flight-sample.json）を
// 渡すと、解析を通さずに端末内へ直接入れる（実データを使わずに確かめるため）。
//
// 実際に「今日」飛ばした記録は用意できないので、ブラウザの時計をその飛行の日に合わせる。

import { webkit, devices } from "playwright";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const URL = process.env.APP_URL || "http://localhost:8310/";
const [carryPath, logPath, nowIso, expectTotal] = process.argv.slice(2);

const browser = await webkit.launch();
const context = await browser.newContext({ ...devices["iPhone 15"] });
const page = await context.newPage();
await page.clock.setFixedTime(new Date(nowIso));
const problems = [];
const isHarnessNoise = (t) => t.includes("Refused to apply a stylesheet");
page.on("pageerror", (e) => problems.push(`実行時エラー: ${e}`));
page.on("console", (m) => {
  if (m.type() === "error" && !isHarnessNoise(m.text())) problems.push(`コンソール: ${m.text()}`);
});
page.on("dialog", (d) => d.accept());

const todayText = () => page.textContent("#carry-body .today");

await page.goto(URL, { waitUntil: "networkidle" });
const empty = await todayText();

await page.setInputFiles("#carry-input", {
  name: basename(carryPath), mimeType: "application/json", buffer: readFileSync(carryPath),
});
await page.waitForFunction(() => /Macで作成/.test(document.getElementById("carry-info").textContent));
const afterCarry = await todayText();

if (logPath.endsWith(".json")) {
  // 解析済みの飛行を、取り込みと同じ保存先に直接入れる
  const flight = JSON.parse(readFileSync(logPath, "utf-8"));
  await page.evaluate((f) => new Promise((resolve, reject) => {
    const req = indexedDB.open("dji-log-mobile");
    req.onsuccess = () => {
      const t = req.result.transaction("flights", "readwrite");
      t.objectStore("flights").put(f);
      t.oncomplete = () => { req.result.close(); resolve(); };
      t.onerror = () => reject(t.error);
    };
  }), flight);
} else {
  // 飛行が終わったので DJI Fly の記録を読み込む（「記録」タブの経路）
  await page.setInputFiles("#file-input", {
    name: basename(logPath), mimeType: "text/plain", buffer: readFileSync(logPath),
  });
  await page.waitForFunction(
    () => /追加しました|読めなかった/.test(document.getElementById("import-text")?.textContent || ""),
    null, { timeout: 120000 });
}
await page.click('.tab-btn[data-view="inspections"]');
await page.click('.tab-btn[data-view="carry"]');
const afterFlight = await todayText();

// その機体を選び、iPhoneのみの飛行の総飛行時間を確かめる
const local = await page.evaluate(async () => {
  const card = [...document.querySelectorAll("#carry-body .rec")]
    .find((d) => d.textContent.includes("iPhoneのみ") && d.textContent.includes("〜"));
  if (!card) return null;
  card.open = true;
  const kv = [...card.querySelectorAll(".kv")].map((k) => k.textContent);
  return { summary: card.querySelector("summary").textContent, total: kv.find((t) => t.startsWith("総飛行時間")) };
});

// 点検を記録すると「記録あり」になるか
await page.click("#carry-body .today >> text=点検を記録する");
await page.click("text=すべて「正常」");
await page.click("#insp-save");
await page.click('.tab-btn[data-view="carry"]');
const afterInspection = await todayText();

const totalOk = expectTotal ? (local?.total || "").includes(`${expectTotal}（暫定）`) : null;
console.log(JSON.stringify({ empty, afterCarry, afterFlight, local, afterInspection, totalOk, problems }, null, 1));
await browser.close();
process.exit(problems.length || totalOk === false ? 1 : 0);
