// 国土交通省 様式1「飛行記録」準拠の Excel 出力。
// SheetJS(vendor/xlsx.mini.min.js) を使い、機体ごとにシートを分ける。

import { display } from "./constants.js";
import { isFlight, floorMinutes } from "./db.js";
import { formatPlace } from "./geocode.js";

const HEADERS = [
  "飛行年月日", "飛行させた者の氏名", "飛行の目的", "特定飛行", "飛行経路",
  "離陸場所", "着陸場所", "離陸時刻", "着陸時刻", "飛行時間", "総飛行時間",
  "飛行の安全に影響のあった事項", "対応", "記事",
];
const WIDTHS = [12, 14, 18, 26, 24, 26, 26, 8, 8, 10, 10, 28, 20, 28];

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

const safeSheetName = (s) => (s || "不明").replace(/[:\\/?*[\]]/g, "").slice(0, 31) || "不明";

/**
 * 様式1のExcelを組み立てて Blob を返す。
 * 総飛行時間は、各飛行を分に切り捨ててから積算する（飛行時間列の合計と一致させるため）。
 */
export function buildLogbook(flights, aircraftList, settings) {
  const XLSX = window.XLSX;
  const { distanceThresholdM: dist, altitudeThresholdM: alt, pilotName } = settings;
  const aircraftBySerial = Object.fromEntries((aircraftList || []).map((a) => [a.serial, a]));

  const target = flights
    .filter((f) => isFlight(f, dist, alt))
    .sort((a, b) => a.takeoffTime.localeCompare(b.takeoffTime));

  // 機体ごとに分ける（飛行日誌は機体ごとに備えるため）
  const groups = new Map();
  for (const f of target) {
    const ac = aircraftBySerial[f.aircraftSn];
    const key = (ac && (ac.registration || ac.name)) || f.aircraftName || "不明";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  if (groups.size === 0) groups.set("飛行記録", []);

  const wb = XLSX.utils.book_new();
  const usedNames = new Set();

  for (const [key, rows] of groups) {
    const ac = aircraftBySerial[rows[0]?.aircraftSn] || {};
    const aoa = [
      ["飛行記録（様式1）"],
      ["無人航空機の登録記号", ac.registration || ""],
      ["型式", ac.model || rows[0]?.aircraftName || ""],
      [],
      HEADERS,
    ];

    let cumulativeMin = floorMinutes(ac.initialFlightSeconds || 0);
    for (const f of rows) {
      cumulativeMin += floorMinutes(f.durationSeconds);
      const place = formatPlace(f.place, f.lat, f.lon);
      aoa.push([
        fmtDate(f.takeoffTime),
        pilotName || "",
        display(f.purpose),
        display(f.specifiedFlight),
        f.route || "",
        place,
        place, // 離陸地点に戻る運用が基本。異なる場合は「飛行経路」に記す
        fmtTime(f.takeoffTime),
        fmtTime(f.landingTime),
        fmtDuration(f.durationSeconds),
        `${Math.floor(cumulativeMin / 60)}:${pad(cumulativeMin % 60)}`,
        f.issues || "",
        f.issueResponse || "",
        f.remarks || "",
      ]);
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = WIDTHS.map((w) => ({ wch: w }));

    let name = safeSheetName(key);
    let n = 2;
    while (usedNames.has(name)) name = `${safeSheetName(key).slice(0, 27)} (${n++})`;
    usedNames.add(name);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }

  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function fileNameFor(aircraftLabel) {
  const parts = ["飛行記録"];
  if (aircraftLabel) parts.push(aircraftLabel);
  const d = new Date();
  parts.push(`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`);
  return `${parts.join("_").replace(/[\\/:*?"<>|]/g, "")}.xlsx`;
}

export { fmtDate, fmtTime, fmtDuration };
