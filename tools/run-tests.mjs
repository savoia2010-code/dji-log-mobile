// iPhone版の自動検証をまとめて実行する（npm test）。
//
// 一時的にローカルサーバーを立て、WebKit（Safariと同じエンジン）で
// 点検の記録・携行用ファイルの受け取り・その日の飛行の扱いを確かめる。
// 使うのは tests/fixtures/ の架空のデータだけで、実際の飛行記録は要らない。

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 8390 + Math.floor(Math.random() * 100);
const url = `http://localhost:${port}/`;
const out = mkdtempSync(join(tmpdir(), "dji-log-mobile-test-"));
const fx = (name) => join(root, "tests", "fixtures", name);

const server = spawn("python3", ["-m", "http.server", String(port), "--directory", root],
  { stdio: "ignore" });
const stop = () => server.kill();
process.on("exit", stop);

for (let i = 0; i < 50; i++) {
  try { if ((await fetch(url)).ok) break; } catch { /* 起動待ち */ }
  await new Promise((r) => setTimeout(r, 100));
}

const checks = [
  ["日常点検の記録と送信", ["tools/verify-inspections.mjs", join(out, "sent.json")]],
  ["携行用ファイルの受け取りと提示", ["tools/verify-carry.mjs", fx("carry-sample.json")]],
  // 前の飛行の総飛行時間 1:10 ＋ 6分40秒（→6分）＝ 1:16
  ["その日の飛行の扱い", ["tools/verify-today.mjs", fx("carry-sample.json"),
    fx("flight-sample.json"), "2026-07-14T15:10:00+09:00", "1:16"]],
];

let failed = 0;
for (const [label, args] of checks) {
  const r = spawnSync("node", args, { cwd: root, env: { ...process.env, APP_URL: url },
    encoding: "utf-8", timeout: 180000 });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) console.log((r.stdout || "") + (r.stderr || ""));
}
stop();
console.log(failed ? `\n${failed} 件失敗しました` : "\nすべて通りました");
process.exit(failed ? 1 : 0);
