// 飛行日誌の出力で共通に使う書き方（日付・時刻・時間・操縦者）。
// 様式1〜3のExcelは submit.js（Macの日誌とこのiPhoneの記録を合わせて作る）。

import { floorMinutes } from "./db.js";

const pad = (n) => String(n).padStart(2, "0");
const fmtDate = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fmtTime = (iso) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
// 取扱要領 7.(1) i)/j) のとおり1分単位（1分未満は切り捨て）
const fmtDuration = (sec) => {
  const m = floorMinutes(sec);
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
};

/** 着陸時刻。日をまたいだ飛行は、それが分かるように書く（取扱要領 7.(1)h)。Mac版と同じ）。 */
export function fmtLanding(takeoffIso, landingIso) {
  if (!landingIso) return "";
  const days = Math.round((new Date(fmtDate(landingIso)) - new Date(fmtDate(takeoffIso || landingIso))) / 86400000);
  if (days === 0) return fmtTime(landingIso);
  if (days === 1) return `翌日 ${fmtTime(landingIso)}`;
  return `${fmtDate(landingIso)} ${fmtTime(landingIso)}`;
}

/** 「飛行させた者の氏名」欄。技能証明を受けていれば番号も添える（取扱要領 7.(1)c)。Mac版と同じ）。 */
export function pilotLabel(settings) {
  const name = (settings && settings.pilotName) || "";
  const num = String((settings && settings.pilotCertificate) || "").trim();
  return num ? `${name}（技能証明 ${num}）` : name;
}

export { fmtDate, fmtTime, fmtDuration };
