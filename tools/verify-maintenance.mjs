// 点検整備記録（様式3）をiPhoneで記録する検証。
//
//   node tools/verify-maintenance.mjs <携行用.json> <解析済みの飛行.json>
//
// 確かめること:
//   「点検」タブから記録でき、内容が空では保存しない
//   総飛行時間は空欄なら暫定の値（それまでの飛行から）、入れたらその値
//   携行タブ・提出用の日誌（様式3）に「iPhoneのみ」として載る。Macから同じ識別子で
//   届いたら1件のまま（新しい方を見せる）
//   直す・消すことができる

import { webkit, devices } from "playwright";
import { readFileSync } from "node:fs";

const URL = process.env.APP_URL || "http://localhost:8310/";
const carry = JSON.parse(readFileSync(process.argv[2], "utf-8"));
const flight = JSON.parse(readFileSync(process.argv[3], "utf-8"));
const SN = flight.aircraftSn;

const browser = await webkit.launch();
const context = await browser.newContext({ ...devices["iPhone 15"] });
const page = await context.newPage();
const problems = [];
const fail = (m) => problems.push(m);
const isHarnessNoise = (t) => t.includes("Refused to apply a stylesheet");
page.on("pageerror", (e) => fail(`実行時エラー: ${e}`));
page.on("console", (m) => { if (m.type() === "error" && !isHarnessNoise(m.text())) fail(`コンソール: ${m.text()}`); });
const dialogs = [];
page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });

await page.goto(URL, { waitUntil: "networkidle" });
await page.evaluate(async (f) => {
  const db = await import("./js/db.js");
  await db.setSetting("pilotName", "山田太郎");
  await db.ensureAircraft(f.aircraftSn, f.aircraftName);
  await db.putFlight(f);
}, flight);
await page.reload({ waitUntil: "networkidle" });
await page.click('.tab-btn[data-view="inspections"]');

// 内容が空では保存しない
await page.click("#maint-new");
await page.selectOption("#mt-aircraft", SN);
await page.fill("#mt-date", "2026-07-20");
await page.click("#maint-save");
if (!dialogs.some((m) => m.includes("内容を入力"))) fail("内容が空でも保存した");
if (await page.isHidden("#maint-editor")) fail("内容が空なのに入力画面が閉じた");
const estimate = await page.textContent("#mt-estimate");
if (!/0:06/.test(estimate)) fail(`空欄のときの総飛行時間（暫定）が違う: ${estimate}`);

await page.fill("#mt-detail", "プロペラ4枚を交換（純正品）");
await page.fill("#mt-reason", "飛行前点検でプロペラの欠けを発見したため");
await page.click("#maint-save");
await page.waitForFunction(() => /プロペラ4枚/.test(document.getElementById("maint-list").textContent), null, { timeout: 5000 })
  .catch(() => fail("一覧に出ない"));
let recs = await page.evaluate(async () => (await import("./js/db.js")).getAllMaintenance());
const r = recs[0] || {};
if (recs.length !== 1 || r.aircraftSerial !== SN || r.totalFlightSeconds !== null || r.engineer !== "山田太郎"
  || !/^[0-9a-f-]{36}$/.test(r.id) || !r.updatedAt) fail(`保存した中身が違う: ${JSON.stringify(r)}`);
if (!/未送信/.test(await page.textContent("#maint-list"))) fail("未送信と出ない");

// 携行タブ（Macの日誌）にも載る
const merged = async (data) => page.evaluate(async ([d, sn]) => {
  const a = (await (await import("./js/carry.js")).mergedAircraft(d)).find((x) => x.serial === sn);
  return a ? a.maintenance : null;
}, [data, SN]);
// 見本の日誌には、Macで記録した点検整備が1件と、総飛行時間 1:10 までの飛行がある。
// このiPhoneの飛行（6分）を足した 1:16 が暫定の値になる
const mine = (rows) => (rows || []).filter((m) => m.id === r.id);
let rows = await merged(carry);
if (rows.length !== 2 || mine(rows).length !== 1 || !mine(rows)[0].localOnly
  || mine(rows)[0].total_time !== "1:16（暫定）") {
  fail(`携行用の日誌に載らない・総飛行時間が違う: ${JSON.stringify(rows)}`);
}

// 直す（総飛行時間を手で入れる）
await page.click("#maint-list .row .body");
await page.fill("#mt-hours", "1");
await page.fill("#mt-minutes", "30");
await page.click("#maint-save");
await page.waitForTimeout(300);
recs = await page.evaluate(async () => (await import("./js/db.js")).getAllMaintenance());
if (recs.length !== 1 || recs[0].totalFlightSeconds !== 5400) fail(`直した内容が違う: ${JSON.stringify(recs)}`);
rows = await merged(carry);
if ((mine(rows)[0] || {}).total_time !== "1:30") fail(`手で入れた総飛行時間が載らない: ${JSON.stringify(mine(rows))}`);

// Macに届いたあと（同じ識別子）は1件のまま。Macで後から直した方を見せる
const fromMac = structuredClone(carry);
fromMac.aircraft[0].maintenance = [...carry.aircraft[0].maintenance, { id: recs[0].id, updatedAt: "2099-01-01T00:00:00+09:00", date: "2026-07-20",
  total_time: "1:30", detail: "Macで直した内容", reason: "", place: "", engineer: "山田太郎", remarks: "" }];
rows = await merged(fromMac);
if (rows.length !== 2 || mine(rows).length !== 1 || mine(rows)[0].detail !== "Macで直した内容" || mine(rows)[0].localOnly) {
  fail(`Macから届いたあと二重になる: ${JSON.stringify(rows)}`);
}

// 提出用の日誌（様式3）にも入る
const sheet = await page.evaluate(async ([d, sn]) => {
  const a = (await (await import("./js/carry.js")).mergedAircraft(d)).find((x) => x.serial === sn);
  return a.maintenance.map((m) => [m.date, m.total_time, m.detail]);
}, [carry, SN]);
if (!sheet.some((x) => x[0] === "2026-07-20" && x[1] === "1:30" && x[2] === "プロペラ4枚を交換（純正品）")) {
  fail(`様式3に入らない: ${JSON.stringify(sheet)}`);
}

// 消す
await page.click("#maint-list .row .body");
await page.click("text=この点検整備記録を削除");
await page.waitForTimeout(300);
recs = await page.evaluate(async () => (await import("./js/db.js")).getAllMaintenance());
if (recs.length) fail("消せない");

console.log(JSON.stringify({ estimate, dialogs: dialogs.length, problems }, null, 1));
await browser.close();
process.exit(problems.length ? 1 : 0);
