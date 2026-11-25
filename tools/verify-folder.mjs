// 飛行記録をフォルダごと読み込む検証。
//
//   node tools/verify-folder.mjs <解析済みの飛行.json>
//
// 確かめること:
//   フォルダを選ぶと、飛行記録の名前（DJIFlightRecord_….txt）のものだけを読み込む（サブフォルダも）
//   読み込み済みの記録は飛ばす
//   飛行記録の無いフォルダを選んだら、そう知らせる
//   「今日の記録」のボタン（携行タブ）もフォルダを選べる
// 本物の飛行記録は要らない（中身の無いファイルは「読めなかったもの」に数えられる）。

import { webkit, devices } from "playwright";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL = process.env.APP_URL || "http://localhost:8310/";
const flight = JSON.parse(readFileSync(process.argv[2], "utf-8"));

const dir = mkdtempSync(join(tmpdir(), "flightrecords-"));
const folder = join(dir, "FlightRecords");
mkdirSync(join(folder, "old"), { recursive: true });
writeFileSync(join(folder, flight.fileName), "dummy");                                     // 読み込み済み
writeFileSync(join(folder, "DJIFlightRecord_2026-07-20_[09-00-00].txt"), "dummy");         // 新しい（読めない）
writeFileSync(join(folder, "old", "DJIFlightRecord_2026-07-01_[09-00-00].txt"), "dummy");  // サブフォルダ
writeFileSync(join(folder, "memo.txt"), "飛行記録ではない");
writeFileSync(join(folder, "cache.dat"), "x");
const empty = join(dir, "Empty");
mkdirSync(empty);
writeFileSync(join(empty, "memo.txt"), "x");

const browser = await webkit.launch();
const context = await browser.newContext({ ...devices["iPhone 15"] });
const page = await context.newPage();
const problems = [];
const fail = (m) => problems.push(m);
page.on("pageerror", (e) => fail(`実行時エラー: ${e}`));

await page.goto(URL, { waitUntil: "networkidle" });
const picked = await page.evaluate(async () => {
  const { pickFlightFiles } = await import("./js/app.js");
  const f = (name, rel = "") => { const x = new File(["x"], name); Object.defineProperty(x, "webkitRelativePath", { value: rel }); return x; };
  return {
    folder: pickFlightFiles([f("DJIFlightRecord_a.txt", "R/DJIFlightRecord_a.txt"), f("memo.txt", "R/memo.txt")]).map((x) => x.name),
    files: pickFlightFiles([f("DJIFlightRecord_a.txt"), f("renamed.txt"), f("a.dat")]).map((x) => x.name),
  };
});
if (picked.folder.join() !== "DJIFlightRecord_a.txt") fail(`フォルダから選ぶ記録が違う: ${picked.folder}`);
if (picked.files.join() !== "DJIFlightRecord_a.txt,renamed.txt") fail(`ファイルで選んだ記録が違う: ${picked.files}`);

await page.evaluate(async (f) => {
  const db = await import("./js/db.js");
  await db.ensureAircraft(f.aircraftSn, f.aircraftName);
  await db.putFlight(f);
}, flight);
await page.reload({ waitUntil: "networkidle" });

await page.click('.tab-btn[data-view="list"]');
const attrs = await page.$eval("#folder-input", (i) => ({ dir: i.webkitdirectory, visible: !!i.closest("label") }));
if (!attrs.dir) fail("フォルダを選ぶ入力になっていない");
await page.setInputFiles("#folder-input", folder);
await page.waitForFunction(() => /追加しました|ありませんでした/.test(document.getElementById("import-text").textContent), null, { timeout: 10000 });
const msg = await page.textContent("#import-text");
if (!/取り込み済み 1 件/.test(msg)) fail(`読み込み済みを飛ばしていない: ${msg}`);
if (!/読めなかったもの 2 件/.test(msg)) fail(`飛行記録だけ（サブフォルダも）を読んでいない: ${msg}`);

await page.setInputFiles("#folder-input", empty);
await page.waitForFunction(() => /見つかりませんでした/.test(document.getElementById("import-text").textContent), null, { timeout: 5000 })
  .catch(() => fail("飛行記録の無いフォルダで何も知らせない"));

// 携行タブの「今日の記録」から
const carryDir = await page.$eval("#carry-flight-input", (i) => i.webkitdirectory);
if (!carryDir) fail("「今日の記録」の読み込みがフォルダを選べない");

console.log(JSON.stringify({ picked, msg, problems }, null, 1));
await browser.close();
process.exit(problems.length ? 1 : 0);
