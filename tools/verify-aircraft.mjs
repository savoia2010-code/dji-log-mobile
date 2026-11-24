// 機体の「使用終了」と「記録ごと削除」の検証。
//
//   node tools/verify-aircraft.mjs <携行用.json> <解析済みの飛行.json>
//
// 確かめること:
//   使用終了 → 機体の絞り込みから外れ、記録は残り、Mac版と揃える時刻が付く → 再開できる
//   記録ごと削除 →「削除」と入れないと消さない → 消すと飛行・点検・送る順番待ちが消え、
//   消した機体として残る → バックアップ・Macの日誌・設定の同期から戻ってこない
//   Mac版で消した機体（携行用の日誌の erased_aircraft）は、iPhoneでも消える

import { webkit, devices } from "playwright";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const URL = process.env.APP_URL || "http://localhost:8310/";
const [carryPath, flightPath] = process.argv.slice(2);
const carry = JSON.parse(readFileSync(carryPath, "utf-8"));
const flight = JSON.parse(readFileSync(flightPath, "utf-8"));

const browser = await webkit.launch();
const context = await browser.newContext({ ...devices["iPhone 15"] });
const page = await context.newPage();
const problems = [];
const isHarnessNoise = (t) => t.includes("Refused to apply a stylesheet");
page.on("pageerror", (e) => problems.push(`実行時エラー: ${e}`));
page.on("console", (m) => {
  if (m.type() === "error" && !isHarnessNoise(m.text())) problems.push(`コンソール: ${m.text()}`);
});
let promptAnswer = "削除";
const dialogs = [];
page.on("dialog", (d) => { dialogs.push(d.message()); d.type() === "prompt" ? d.accept(promptAnswer) : d.accept(); });
const fail = (msg) => problems.push(msg);

await page.goto(URL, { waitUntil: "networkidle" });
await page.setInputFiles("#carry-input", {
  name: basename(carryPath), mimeType: "application/json", buffer: Buffer.from(JSON.stringify(carry)),
});
await page.waitForFunction(() => /Macで作成/.test(document.getElementById("carry-info").textContent));

// 2機ぶんの記録を入れる（もう1機は、このiPhoneだけにある機体）
const other = { ...flight, fileName: "DJIFlightRecord_2026-07-15_[09-00-00].txt", aircraftSn: "SN-OTHER-9",
  aircraftName: "よその機体", takeoffTime: "2026-07-15T09:00:00+09:00", landingTime: "2026-07-15T09:05:00+09:00" };
await page.evaluate(async ([f1, f2]) => {
  const db = await import("./js/db.js");
  for (const f of [f1, f2]) { await db.ensureAircraft(f.aircraftSn, f.aircraftName); await db.putFlight(f); }
  await db.putInspection({ id: crypto.randomUUID(), aircraftSerial: "SN-OTHER-9", aircraftName: "よその機体",
    date: "2026-07-15", results: {}, postResults: {}, itemRemarks: {}, updatedAt: new Date().toISOString() });
  await db.putOutbox({ fileName: f2.fileName, bytes: new ArrayBuffer(4), addedAt: new Date().toISOString() });
}, [flight, other]);
await page.reload({ waitUntil: "networkidle" });

const chips = () => page.$$eval("#aircraft-bar .chip", (els) => els.map((e) => e.textContent));
const before = await chips();
if (!before.some((t) => t.includes("よその機体"))) fail(`初めに機体の絞り込みに出ていない: ${before}`);

// ---- 使用終了 ----
await page.click('.tab-btn[data-view="settings"]');
const item = (name) => page.locator("#aircraft-list .aircraft-item", { hasText: name });
await item("テスト機").locator("text=使用終了にする").click();
await page.waitForFunction(() => /使用を再開する/.test(document.getElementById("aircraft-list").textContent));
const retired = await page.evaluate(async () => {
  const db = await import("./js/db.js");
  const a = (await db.getAllAircraft()).find((x) => x.serial === "SN-TEST-0001");
  return { retired: a.retired, stamp: ((await db.getSettings()).syncAt || {})["aircraft:SN-TEST-0001:retired"],
    flights: (await db.getAllFlights()).filter((f) => f.aircraftSn === "SN-TEST-0001").length };
});
if (!retired.retired || !retired.stamp) fail(`使用終了にならない・時刻が付かない: ${JSON.stringify(retired)}`);
if (retired.flights !== 1) fail("使用終了で記録が消えた");
await page.click('.tab-btn[data-view="list"]');
const afterRetire = await chips();
if (afterRetire.some((t) => t.includes("テスト機"))) fail(`使用終了の機体が絞り込みに残る: ${afterRetire}`);
// 新しい点検の機体の候補からも外れる
await page.click('.tab-btn[data-view="inspections"]');
await page.click("#insp-new");
const choices = await page.$$eval("#in-aircraft option", (os) => os.map((o) => o.value));
if (choices.includes("SN-TEST-0001")) fail("使用終了の機体が点検の候補に出る");
await page.click("#insp-close");
// 再開できる
await page.click('.tab-btn[data-view="settings"]');
await item("テスト機").locator("text=使用を再開する").click();
await page.waitForFunction(() => !/使用を再開する/.test(document.getElementById("aircraft-list").textContent));

// ---- 記録ごと削除 ----
promptAnswer = "けす";
await item("よその機体").locator("text=記録ごと削除").click();
await page.waitForFunction(() => true);
await page.waitForTimeout(300);
const kept = await page.evaluate(async () => (await (await import("./js/db.js")).getAllFlights()).length);
if (kept !== 2) fail(`「削除」と入れていないのに消えた（${kept}件）`);
promptAnswer = "削除";
await item("よその機体").locator("text=記録ごと削除").click();
await page.waitForFunction(() => !/よその機体/.test(document.getElementById("aircraft-list").textContent), null, { timeout: 5000 })
  .catch(() => fail("削除しても機体が一覧に残る"));
const erased = await page.evaluate(async () => {
  const db = await import("./js/db.js");
  const erase = await import("./js/erase.js");
  return {
    flights: (await db.getAllFlights()).map((f) => f.aircraftSn),
    inspections: (await db.getAllInspections()).filter((r) => r.aircraftSerial === "SN-OTHER-9").length,
    outbox: (await db.getOutboxKeys()).length,
    marks: Object.keys(await erase.marks()),
  };
});
if (erased.flights.includes("SN-OTHER-9") || !erased.flights.includes("SN-TEST-0001")) fail(`飛行の消え方が違う: ${erased.flights}`);
if (erased.inspections || erased.outbox) fail(`点検・送る順番待ちが残る: ${JSON.stringify(erased)}`);
if (!erased.marks.includes("SN-OTHER-9")) fail("消した機体として残っていない");

// 消した機体の記録は、バックアップ・設定の同期・バックアップからの復元で戻ってこない
const back = await page.evaluate(async ([f2]) => {
  const gas = await import("./js/gas.js");
  const settingsSync = await import("./js/settingsSync.js");
  const erase = await import("./js/erase.js");
  const db = await import("./js/db.js");
  const remote = { format: "dji-log-mobile-backup", inspections: [
    { id: "x1", aircraftSerial: "SN-OTHER-9", date: "2026-07-15", updatedAt: "2026-07-15T00:00:00Z" }],
    flights: [f2], sync: { "aircraft:SN-OTHER-9:registration": { value: "JU000", at: "2026-07-01T00:00:00Z" } } };
  const merged = gas.mergeBackup(remote, [], [], { erased: await erase.marks() });
  const changed = await settingsSync.applyRemote({
    "aircraft:SN-OTHER-9:registration": { value: "JU999", at: "2099-01-01T00:00:00Z" } });
  return { flights: merged.flights.length, inspections: merged.inspections.length,
    syncKeys: Object.keys(merged.sync), erased: Object.keys(merged.erased || {}),
    recreated: (await db.getAllAircraft()).some((a) => a.serial === "SN-OTHER-9"), changed,
    blocked: erase.flightErased(await erase.marks(), f2.aircraftSn, f2.takeoffTime) };
}, [other]);
if (back.flights || back.inspections || back.syncKeys.length) fail(`バックアップに消した記録が残る: ${JSON.stringify(back)}`);
if (!back.erased.includes("SN-OTHER-9")) fail("バックアップに消した機体が入らない（Mac版が知れない）");
if (back.recreated) fail("設定の同期で消した機体が作り直された");
if (!back.blocked) fail("読み込み直した記録を止められない");

// ---- Mac版で消した機体（携行用の日誌で届く）----
const fromMac = { ...carry, generatedAt: new Date().toISOString(), erased_aircraft: { "SN-TEST-0001": new Date().toISOString() } };
await page.evaluate(async (data) => { await (await import("./js/carry.js")).acceptCarry(data); }, fromMac);
const macErased = await page.evaluate(async (data) => {
  const db = await import("./js/db.js");
  const carry = await import("./js/carry.js");
  return { flights: (await db.getAllFlights()).length, aircraft: (await db.getAllAircraft()).length,
    shown: (await carry.mergedAircraft(data)).map((a) => a.serial) };
}, fromMac);
if (macErased.flights || macErased.aircraft) fail(`Mac版で消した機体がiPhoneに残る: ${JSON.stringify(macErased)}`);
if (macErased.shown.length) fail(`Macの日誌（消す前のもの）が表示に残る: ${macErased.shown}`);

console.log(JSON.stringify({ before, afterRetire, retired, erased, back, macErased, dialogs: dialogs.length, problems }, null, 1));
await browser.close();
process.exit(problems.length ? 1 : 0);
