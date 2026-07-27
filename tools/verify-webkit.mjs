// iPhone実機に触らずに WebKit（Safariと同じエンジン）で検証する。
//
//   npm install          # 初回のみ
//   npx playwright install webkit
//   python3 -m http.server 8310 --directory . &
//   node tools/verify-webkit.mjs [検証用ログの.txtへのパス]
//
// Xcode は不要。実機でしか確かめられないのは、DJI Fly のフォルダから
// ファイルを選ぶ操作と、ホーム画面に追加したときの挙動だけ。

import { webkit, devices } from "playwright";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const URL = process.env.APP_URL || "http://localhost:8310/";
const samplePath = process.argv[2];

const browser = await webkit.launch();
const context = await browser.newContext({ ...devices["iPhone 15"] });
const page = await context.newPage();

const problems = [];
// Playwright はスクリーンショット時にCSSを注入するため、CSPの
// スタイル違反が1件出る。アプリ側の問題ではないので除く。
const isHarnessNoise = (t) => t.includes("Refused to apply a stylesheet");

page.on("pageerror", (e) => problems.push(`実行時エラー: ${e}`));
page.on("console", (m) => {
  if (m.type() === "error" && !isHarnessNoise(m.text())) {
    problems.push(`コンソール: ${m.text()}`);
  }
});

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

const env = await page.evaluate(() => ({
  WASM: typeof WebAssembly !== "undefined",
  IndexedDB: "indexedDB" in window,
  共有API: !!navigator.canShare,
}));

let imported = null;
if (samplePath) {
  const bytes = await readFile(samplePath);
  const name = basename(samplePath);
  // ファイル選択と同じ経路に流し込む
  await page.evaluate(async ({ name, b64 }) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([arr], name));
    const input = document.getElementById("file-input");
    input.files = dt.files;
    input.dispatchEvent(new Event("change"));
  }, { name, b64: bytes.toString("base64") });

  await page.waitForFunction(
    () => /追加しました|読めなかった/.test(document.getElementById("import-text")?.textContent || ""),
    { timeout: 60000 },
  ).catch(() => problems.push("読み込みが時間内に終わりませんでした"));

  imported = await page.evaluate(() => {
    const row = document.querySelector("#flight-list .row");
    return {
      結果: document.getElementById("import-text")?.textContent,
      一覧の先頭: row ? row.innerText.split("\n").join(" / ") : null,
    };
  });

  const xlsx = await page.evaluate(async () => {
    const [ex, db] = await Promise.all([import("./js/export.js"), import("./js/db.js")]);
    const blob = ex.buildLogbook(
      await db.getAllFlights(), await db.getAllAircraft(), await db.getSettings());
    return Math.round(blob.size / 1024);
  }).catch((e) => { problems.push(`Excel生成: ${e}`); return null; });
  if (xlsx) imported.ExcelサイズKB = xlsx;
}

// レイアウト崩れ（横スクロールと文字のはみ出し）を実測する
const layout = await page.evaluate(() => {
  const overflow = [...document.querySelectorAll(".chk")]
    .filter((l) => l.scrollWidth > l.clientWidth + 1).length;
  return {
    横スクロール量: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    はみ出したラベル: overflow,
  };
});

await page.screenshot({ path: "webkit-shot.png", fullPage: true });
await browser.close();

console.log(JSON.stringify({ URL, 環境: env, 取り込み: imported, レイアウト: layout, 問題: problems }, null, 2));
console.log("\nスクリーンショット: webkit-shot.png");
process.exit(problems.length ? 1 : 0);
