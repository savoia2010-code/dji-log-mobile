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
  geolocation: { latitude: 34.3955, longitude: 132.4536 }, // 広島市の平和記念公園付近（公共の場所）
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

// 飛行後点検がまだの記録を開くと、「飛行後」の点検から見せる。切り替えると飛行前が見える
await page.click("#insp-list .row .body");
const openedPhase = await page.getAttribute("#insp-results", "data-phase");
const postVisible = await page.isVisible('#insp-results .phase-post');
await page.click('.phase-tabs label:has(input[value="pre"])');
const preAbnormal = await page.isChecked('input[name="res-1"][value="異常"]');
if (shot("insp-post.png")) await page.screenshot({ path: shot("insp-post.png") });
await page.click("#insp-save");

// 飛ばし終えたら、一覧から1回で飛行後点検を記録できる
const beforePost = await page.textContent("#insp-list");
await page.click("#insp-list .post-ok");
await page.waitForFunction(() => /飛行後：全項目 正常/.test(document.getElementById("insp-list").textContent));
const afterPost = await page.textContent("#insp-list");
// 飛行後点検を記録したので、また「未送信」になる（Macへ送り直す）
const resend = /未送信/.test(afterPost);
await page.click("#insp-send");
await page.waitForFunction((n) => window.__shared && window.__shared.text.includes("postResults"), null);
const sentPost = JSON.parse((await page.evaluate(() => window.__shared)).text).inspections[0].postResults;

// 開き直しても残っているか（IndexedDB に保存されたか）
await page.reload({ waitUntil: "networkidle" });
await page.click('.tab-btn[data-view="inspections"]');
const persisted = await page.textContent("#insp-list");

const result = {
  place, before, sendLabel, fileName, after, persisted: persisted.includes("DJI Neo"),
  飛行後の前: beforePost.includes("飛行後：未記録"), 飛行後の記録: afterPost.includes("飛行後：全項目 正常"),
  送り直し: resend, 送った飛行後点検: Object.keys(sentPost || {}).length,
  開いたときの点検: openedPhase, 飛行後が見える: postVisible, 飛行前の異常が残る: preAbnormal,
  problems,
};
console.log(JSON.stringify(result, null, 1));
await browser.close();
const ok = !problems.length && result.persisted && result.飛行後の前 && result.飛行後の記録
  && resend && result.送った飛行後点検 === 9 && openedPhase === "post" && postVisible && preAbnormal;
process.exit(ok ? 0 : 1);
