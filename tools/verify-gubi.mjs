// 具備資料をiPhoneで直す検証。
//
//   node tools/verify-gubi.mjs <携行用.json> <追加基準とDJIの公表値.json>
//
// 確かめること:
//   具備資料の無い機体でも作れる（空欄はDJIの公表値で埋める）
//   写真は「写真を撮る」（カメラが開く capture 付き）と「写真を選ぶ」から入れられ、縮小した JPEG になる
//   飛行形態・適／否・代替措置を選べる
//   保存すると部分ごとに「未送信」で残り、携行タブの具備資料に反映される（PDFは後で、と知らせる）
//   Macの日誌に入ったら（Macの時刻が追いついたら）、このiPhoneの分は消える
//   写真を消せる。古い形の日誌（追加基準の一覧が無い）では、直せないことを知らせる

import { webkit, devices } from "playwright";
import { readFileSync } from "node:fs";

const URL = process.env.APP_URL || "http://localhost:8310/";
const carry = JSON.parse(readFileSync(process.argv[2], "utf-8"));
const extra = JSON.parse(readFileSync(process.argv[3], "utf-8"));
const SN = "SN-NEO2-0001";

// 8x8 の PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP438CAFWEXHbQSAKmzX8FBxi1QAAAAAElFTkSuQmCC", "base64");

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

const fresh = { ...carry, generatedAt: new Date().toISOString(),
  documents: { ...carry.documents, rules: extra.rules, dji_models: extra.dji_models } };

await page.goto(URL, { waitUntil: "networkidle" });
await page.evaluate(async () => {
  const db = await import("./js/db.js");
  await db.ensureAircraft("SN-NEO2-0001", "DJI Neo 2");
  await db.putFlight({ fileName: "DJIFlightRecord_2026-07-20_[10-00-00].txt", aircraftSn: "SN-NEO2-0001",
    aircraftName: "DJI Neo 2", takeoffTime: "2026-07-20T10:00:00+09:00", landingTime: "2026-07-20T10:05:00+09:00",
    durationSeconds: 300, totalDistanceM: 200, maxAltitudeM: 20, hasGps: true, lat: 35, lon: 135, place: "" });
});
await page.evaluate(async (data) => (await import("./js/carry.js")).acceptCarry(data), fresh);
await page.click('.tab-btn[data-view="carry"]');
await page.click('#carry-body .chip:has-text("DJI Neo 2")');
await page.click('#carry-body summary:has-text("具備資料（機体）")');
await page.click('#carry-body button:has-text("具備資料を作る")');
await page.waitForSelector("#gubi-editor:not([hidden])");

// 空欄はDJIの公表値で埋める
const weight = await page.inputValue("#gb-weight_kg");
if (weight !== "0.160") fail(`DJIの公表値で埋めていない: ${weight}`);
if (!dialogs.length && !/公表値/.test(await page.textContent("#gubi-body"))) fail("公表値で埋めたことを知らせていない");
await page.fill("#gb-controller_name", "DJI RC-N3");

// 写真：カメラで撮る入力（capture 付き）と、選ぶ入力がある
const inputs = await page.$$eval('#gubi-body input[type=file][data-slot="front"]',
  (xs) => xs.map((x) => ({ capture: x.getAttribute("capture"), accept: x.accept })));
if (inputs.length !== 2 || inputs[0].capture !== "environment" || inputs[1].capture !== null) {
  fail(`写真の入力が違う: ${JSON.stringify(inputs)}`);
}
await page.setInputFiles('#gubi-body input[type=file][data-slot="front"][capture]',
  { name: "front.png", mimeType: "image/png", buffer: PNG });
await page.waitForSelector('#gubi-body .gubi-photo[data-slot="front"] img');

// 追加基準：DID上空を選び、目視外で「否」（自分で書く）
await page.check('#gubi-body input[data-category="did"]');
await page.check('#gubi-body input[data-category="bvlos"]');
await page.click('#gubi-body label:has(input[name="gb-res-did-1"][value="適"])');
await page.click('#gubi-body label:has(input[name="gb-res-bvlos-1"][value="否"])');
await page.selectOption("#gb-alt-bvlos-1", "other");
await page.fill("#gb-other-bvlos-1", "補助者が常に周囲を監視し、操縦者に助言する。");
await page.click("#gubi-save");
await page.waitForSelector("#gubi-editor[hidden]", { state: "attached" });

let parts = await page.evaluate(async () => (await (await import("./js/db.js")).getAllGubi())
  .map((p) => ({ section: p.section, sentAt: p.sentAt, data: p.data, deleted: !!p.deleted })));
const sections = parts.map((p) => p.section).sort().join();
if (sections !== "compliance,photo:front,spec") fail(`保存した部分が違う: ${sections}`);
const photo = parts.find((p) => p.section === "photo:front");
if (!photo || !String(photo.data.dataUrl).startsWith("data:image/jpeg;base64,")) fail("写真が JPEG になっていない");
const comp = (parts.find((p) => p.section === "compliance") || {}).data || {};
if (String(comp.categories) !== "did,bvlos" || comp.answers["bvlos-1"].alt_selection !== "other") {
  fail(`適合性の中身が違う: ${JSON.stringify(comp)}`);
}
if (parts.some((p) => p.sentAt)) fail("未送信になっていない");

// 携行タブに反映（PDFは後でと知らせる）
// 保存して描き直しても、具備資料の欄は開いたまま
const docsBox = page.locator("#carry-body details", { has: page.locator("summary", { hasText: "具備資料（機体）" }) });
if (!(await docsBox.evaluate((d) => d.open))) {
  fail("保存したあと、具備資料の欄が閉じた");
}
const shown = await page.textContent("#carry-body");
if (!/0\.160/.test(shown) || !/DJI RC-N3/.test(shown)) fail("携行タブの具備資料に入らない");
if (!/提出用のPDFにも反映/.test(shown)) fail("Macに届くまでPDFは古いと知らせていない");
if (!/補助者が常に周囲を監視/.test(shown)) fail("代替措置が出ない");
if (!(await page.$('#carry-body .doc-photo img'))) fail("写真が出ない");
// 「Macへ送る」の数にも入る
await page.click('.tab-btn[data-view="inspections"]');
await page.waitForTimeout(300);
// （飛行のあった日の日常点検が自動で1件できているので、それと合わせて4件）
if (!/未送信 4件/.test(await page.textContent("#insp-send"))) fail(`送る数に入らない: ${await page.textContent("#insp-send")}`);

// 写真を消す（入力画面を開き直す）
await page.click('.tab-btn[data-view="carry"]');
await page.click('#carry-body button:has-text("具備資料を直す")');
await page.click('#gubi-body .gubi-photo[data-slot="front"] button:has-text("削除")');
await page.click("#gubi-save");
await page.waitForTimeout(300);
parts = await page.evaluate(async () => (await (await import("./js/db.js")).getAllGubi()));
if (!parts.some((p) => p.section === "photo:front" && p.deleted)) fail("写真を消せない");

// Macの日誌に入ったら（Macの時刻が追いついたら）、このiPhoneの分を消す
const later = new Date(Date.now() + 60000).toISOString();
const fromMac = structuredClone(fresh);
fromMac.generatedAt = later;
fromMac.documents.aircraft[SN] = { serial: SN, label: "DJI Neo 2", registration: "", spec: { name: "DJI Neo 2", weight_kg: "0.160" },
  categories: [], category_ids: ["did", "bvlos"], answers: {}, photos: {}, pdf: "", pdf_name: "",
  sync: { spec: later, compliance: later, "photo:front": later } };
await page.evaluate(async (data) => (await import("./js/carry.js")).acceptCarry(data), fromMac);
parts = await page.evaluate(async () => (await (await import("./js/db.js")).getAllGubi()));
if (parts.length) fail(`Macに入ったあとも残る: ${parts.map((p) => p.section)}`);

// 古い形の日誌（追加基準の一覧が無い）では、直せないことを知らせる
await page.evaluate(async (data) => (await import("./js/carry.js")).acceptCarry(data),
  { ...carry, generatedAt: new Date(Date.now() + 120000).toISOString() });
const before = dialogs.length;
await page.evaluate(async () => (await import("./js/gubiEdit.js")).openGubiEditor("SN-TEST-0001"));
if (!(dialogs.length > before && /Mac版/.test(dialogs[dialogs.length - 1]))) fail("古い日誌で直せないことを知らせない");

console.log(JSON.stringify({ weight, inputs, sections, problems }, null, 1));
await browser.close();
process.exit(problems.length ? 1 : 0);
