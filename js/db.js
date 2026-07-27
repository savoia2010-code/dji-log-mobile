// IndexedDB への保存。飛行記録・設定・機体をブラウザ内に持つ（サーバー不要）。

const DB_NAME = "dji-log-mobile";
const DB_VERSION = 1;

let dbPromise = null;

export class StorageUnavailable extends Error {}

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    // プライベートブラウズや空き容量不足では IndexedDB が開けない。
    // 無言で固まらないよう、判別できる例外にして画面に出す。
    if (!("indexedDB" in window) || !indexedDB) {
      reject(new StorageUnavailable("この環境では記録を保存できません"));
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(new StorageUnavailable(String(e)));
      return;
    }
    req.onblocked = () =>
      reject(new StorageUnavailable("他のタブで開かれているため保存できません"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("flights")) {
        db.createObjectStore("flights", { keyPath: "fileName" });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("aircraft")) {
        db.createObjectStore("aircraft", { keyPath: "serial" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new StorageUnavailable(String(req.error)));
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const getAllFlights = () => tx("flights", "readonly", (s) => s.getAll());
export const getFlight = (fileName) => tx("flights", "readonly", (s) => s.get(fileName));
export const putFlight = (flight) => tx("flights", "readwrite", (s) => s.put(flight));
export const deleteFlight = (fileName) => tx("flights", "readwrite", (s) => s.delete(fileName));

export async function putFlights(flights) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction("flights", "readwrite");
    const store = t.objectStore("flights");
    for (const f of flights) store.put(f);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function hasFlight(fileName) {
  return (await getFlight(fileName)) !== undefined;
}

const DEFAULT_SETTINGS = {
  pilotName: "",
  distanceThresholdM: 8,
  altitudeThresholdM: 0,
};

export async function getSettings() {
  const rows = await tx("settings", "readonly", (s) => s.getAll());
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows || []) out[r.key] = r.value;
  return out;
}

export async function setSetting(key, value) {
  return tx("settings", "readwrite", (s) => s.put({ key, value }));
}

export const getAllAircraft = () => tx("aircraft", "readonly", (s) => s.getAll());
export const putAircraft = (a) => tx("aircraft", "readwrite", (s) => s.put(a));

/** 記録の取り込み時に機体を自動登録する（登録記号などは後から利用者が補う）。 */
export async function ensureAircraft(serial, name) {
  if (!serial) return;
  const existing = await tx("aircraft", "readonly", (s) => s.get(serial));
  if (existing) {
    if (!existing.name && name) await putAircraft({ ...existing, name });
    return;
  }
  await putAircraft({
    serial, name: name || "", registration: "", model: "", initialFlightSeconds: 0,
  });
}

/** 日誌に載せる「飛行」か。累積移動距離で判定し、高度しきい値は任意で併用。 */
export function isFlight(f, distanceThreshold, altitudeThreshold = 0) {
  if (f.manualOverride !== null && f.manualOverride !== undefined) return !!f.manualOverride;
  if ((f.totalDistanceM || 0) >= distanceThreshold) return true;
  return altitudeThreshold > 0 && (f.maxAltitudeM || 0) >= altitudeThreshold;
}

export const floorMinutes = (sec) => Math.floor((sec || 0) / 60);
