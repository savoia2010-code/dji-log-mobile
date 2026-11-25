// 飛行のあった日に、日常点検の記録を自動で作る検証。
//
//   node tools/verify-auto-inspection.mjs <携行用.json> <解析済みの飛行.json>
//
// 確かめること:
//   識別子が Mac版（inspections.auto_id）と同じ値になる
//   起動すると、飛行のあった「日×機体」に飛行前・飛行後とも全項目「正常」の記録ができる
//   （実施場所はその日の最初の飛行、実施者は既定の操縦者）。何度動いても増えない
//   消した自動の記録は作り直さない
//   手で入れた記録がある日は作らず、飛行後点検が空なら埋める（飛行前に異常があれば埋めない）
//   手で新しく記録したら、同じ日の自動の記録と置き換わる。直した自動の記録は自動でなくなる
//   Macの日誌に手で入れた記録がある日の、このiPhoneの自動の記録は外す

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
page.on("pageerror", (e) => fail(`実行時エラー: ${e}`));
page.on("dialog", (d) => d.accept());

const at = (day, hms) => ({
  ...flight, fileName: `DJIFlightRecord_${day}_[${hms.replaceAll(":", "-")}].txt`,
  takeoffTime: `${day}T${hms}+09:00`, landingTime: `${day}T${hms.slice(0, 3)}59:00+09:00`,
});
const daily = () => page.evaluate(async () => (await (await import("./js/db.js")).getAllInspections())
  .sort((a, b) => a.date.localeCompare(b.date)));

await page.goto(URL, { waitUntil: "networkidle" });
const id = await page.evaluate(async () => (await import("./js/autoInspect.js")).autoId("SN-A", "2026-07-14"));
if (id !== "94d13b63-90f0-5fa4-81f9-9ccbed2d2887") fail(`識別子がMac版と違う: ${id}`);

// 2日分の飛行（7/14は2回。最初の飛行は別の場所）と、飛行とみなさない記録だけの日
const flights = [
  { ...at("2026-07-14", "09:00:00"), place: "広島県尾道市A町付近" },
  at("2026-07-14", "15:00:00"),
  at("2026-07-15", "10:00:00"),
  { ...at("2026-07-16", "10:00:00"), totalDistanceM: 0.5, durationSeconds: 20 },
];
await page.evaluate(async (fs) => {
  const db = await import("./js/db.js");
  await db.setSetting("pilotName", "山田太郎");
  for (const f of fs) { await db.ensureAircraft(f.aircraftSn, f.aircraftName); await db.putFlight(f); }
}, flights);
await page.reload({ waitUntil: "networkidle" });   // 起動したときに作る
await page.waitForTimeout(500);

let recs = await daily();
if (recs.map((r) => r.date).join() !== "2026-07-14,2026-07-15") fail(`自動の記録の日が違う: ${recs.map((r) => r.date)}`);
const r14 = recs[0] || {};
const allOk = (o) => Object.keys(o || {}).length === 9 && Object.values(o).every((v) => v === "正常");
if (!allOk(r14.results) || !allOk(r14.postResults)) fail("飛行前・飛行後が全項目「正常」になっていない");
if (r14.place !== "広島県尾道市A町付近" || r14.inspector !== "山田太郎") fail(`場所・実施者が違う: ${r14.place} / ${r14.inspector}`);
if (!r14.auto || r14.id !== await page.evaluate(async (sn) => (await import("./js/autoInspect.js")).autoId(sn, "2026-07-14"), SN)) {
  fail("自動の記録の印・識別子が違う");
}
const again = await page.evaluate(async () => (await import("./js/autoInspect.js")).autoInspect());
if (again !== 0 || (await daily()).length !== 2) fail("2回目で記録が増えた");

// 点検の一覧に「自動」と出る
await page.click('.tab-btn[data-view="inspections"]');
const badges = await page.$$eval("#view-inspections .badge", (b) => b.filter((x) => x.textContent === "自動").length);
if (badges !== 2) fail(`点検の一覧の「自動」の印が ${badges} 個`);

// 消した自動の記録は作り直さない
await page.evaluate(async (rid) => (await import("./js/db.js")).deleteInspection(rid), recs[1].id);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(300);
if ((await daily()).some((r) => r.date === "2026-07-15")) fail("消した自動の記録が作り直された");

// 直した自動の記録は、手で入れた記録になる
await page.click('.tab-btn[data-view="inspections"]');
await page.click("#view-inspections .row .body");
await page.click("#insp-save");
await page.waitForTimeout(300);
if ((await daily()).find((r) => r.date === "2026-07-14").auto) fail("直した記録が自動のまま");

// 手で入れた記録がある日：飛行後点検だけ埋める（飛行前に異常があれば埋めない）
await page.evaluate(async (sn) => {
  const db = await import("./js/db.js");
  const ok = { 機体全般: "正常" };
  await db.putInspection({ id: crypto.randomUUID(), aircraftSerial: sn, date: "2026-07-20", results: ok,
    postResults: {}, itemRemarks: {}, notes: "", updatedAt: new Date().toISOString() });
  await db.putInspection({ id: crypto.randomUUID(), aircraftSerial: sn, date: "2026-07-21",
    results: { プロペラ: "異常" }, postResults: {}, itemRemarks: {}, notes: "", updatedAt: new Date().toISOString() });
}, SN);
await page.evaluate(async (fs) => {
  const db = await import("./js/db.js");
  for (const f of fs) await db.putFlight(f);
  return (await import("./js/autoInspect.js")).autoInspect();
}, [at("2026-07-20", "10:00:00"), at("2026-07-21", "10:00:00"), at("2026-07-22", "10:00:00")]);
recs = await daily();
const d20 = recs.filter((r) => r.date === "2026-07-20");
const d21 = recs.filter((r) => r.date === "2026-07-21");
if (d20.length !== 1 || !allOk(d20[0].postResults) || d20[0].auto) fail(`手の記録の飛行後点検を埋めていない: ${JSON.stringify(d20)}`);
if (d21.length !== 1 || Object.keys(d21[0].postResults).length) fail("飛行前に異常がある日の飛行後点検を埋めた");

// 手で新しく記録したら、同じ日の自動の記録と置き換わる
await page.click('.tab-btn[data-view="inspections"]');
await page.click("#insp-new");
await page.selectOption("#in-aircraft", SN);
await page.fill("#in-date", "2026-07-22");
await page.click("#insp-save");
await page.waitForTimeout(300);
const d22 = (await daily()).filter((r) => r.date === "2026-07-22");
if (d22.length !== 1 || d22[0].auto) fail(`手の記録と自動の記録が並んだ: ${d22.length}件`);

// Macの日誌に手で入れた記録がある日の、自動の記録は外す（7/23 はiPhoneで自動の記録を作ってから、Macの日誌が届く）
await page.evaluate(async (f) => {
  const db = await import("./js/db.js");
  await db.putFlight(f);
  await (await import("./js/autoInspect.js")).autoInspect();
}, at("2026-07-23", "10:00:00"));
if (!(await daily()).some((r) => r.date === "2026-07-23" && r.auto)) fail("7/23 の自動の記録ができていない");
const fromMac = structuredClone(carry);
fromMac.generatedAt = new Date().toISOString();
fromMac.aircraft[0].daily = [{ id: "mac-1", date: "2026-07-23", place: "Mac", inspector: "山田太郎",
  results: { 機体全般: "正常" }, postResults: { 機体全般: "正常" }, itemRemarks: {}, notes: "", updatedAt: "2026-07-23T12:00:00+09:00" }];
await page.evaluate(async (data) => (await import("./js/carry.js")).acceptCarry(data), fromMac);
if ((await daily()).some((r) => r.date === "2026-07-23")) fail("Macに手の記録がある日の、自動の記録が残った");

console.log(JSON.stringify({ id, dates: (await daily()).map((r) => `${r.date}${r.auto ? "(自動)" : ""}`), problems }, null, 1));
await browser.close();
process.exit(problems.length ? 1 : 0);
