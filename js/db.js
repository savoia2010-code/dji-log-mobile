// IndexedDB への保存。飛行記録・設定・機体をブラウザ内に持つ（サーバー不要）。

const DB_NAME = "dji-log-mobile";
// 2: 日常点検記録（inspections）を追加
// 3: Mac版から受け取った携行用の飛行日誌（carry）を追加
// 4: Mac版へ送る飛行記録の原本（outbox。送ったら消す）を追加
const DB_VERSION = 4;

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
      if (!db.objectStoreNames.contains("inspections")) {
        db.createObjectStore("inspections", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("carry")) {
        db.createObjectStore("carry", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("outbox")) {
        db.createObjectStore("outbox", { keyPath: "fileName" });
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

// Mac版へ送る飛行記録の原本 { fileName, bytes(ArrayBuffer), addedAt }
export const putOutbox = (item) => tx("outbox", "readwrite", (s) => s.put(item));
export const getOutboxKeys = () => tx("outbox", "readonly", (s) => s.getAllKeys());
export const getOutbox = (fileName) => tx("outbox", "readonly", (s) => s.get(fileName));
export const deleteOutbox = (fileName) => tx("outbox", "readwrite", (s) => s.delete(fileName));

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

// 日常点検記録。id は端末で作る識別子で、Mac版へ送ったときの重複防止に使う。
export const getAllInspections = () => tx("inspections", "readonly", (s) => s.getAll());
export const getInspection = (id) => tx("inspections", "readonly", (s) => s.get(id));
export const putInspection = (r) => tx("inspections", "readwrite", (s) => s.put(r));
export const deleteInspection = (id) => tx("inspections", "readwrite", (s) => s.delete(id));

export async function putInspections(records) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction("inspections", "readwrite");
    const store = t.objectStore("inspections");
    for (const r of records) store.put(r);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// Mac版から受け取った携行用の飛行日誌。常に最新の1つだけを持つ。
export const getCarry = () => tx("carry", "readonly", (s) => s.get("latest"));
export const putCarry = (data) =>
  tx("carry", "readwrite", (s) => s.put({ key: "latest", data, receivedAt: new Date().toISOString() }));

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

/** 利用者が実際に保存した設定だけ（初期値で補わない）。バックアップに使う。 */
export async function getStoredSettings() {
  const rows = await tx("settings", "readonly", (s) => s.getAll());
  return Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
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

/**
 * Mac版から受け取った機体を登録する。日常点検でその機体を選べるようにするため。
 * 登録記号・型式はMac版の値で更新する（記録の大元はMac版にあるため）。
 */
export async function mergeAircraftFromMac(list) {
  for (const a of list) {
    if (!a.serial) continue;
    const existing = await tx("aircraft", "readonly", (s) => s.get(a.serial));
    await putAircraft({
      serial: a.serial,
      name: (existing && existing.name) || a.name || "",
      registration: a.registration || (existing && existing.registration) || "",
      model: a.model || (existing && existing.model) || "",
      initialFlightSeconds: (existing && existing.initialFlightSeconds) || 0,
    });
  }
}

/** 日誌に載せる「飛行」か。累積移動距離で判定し、高度しきい値は任意で併用。 */
export function isFlight(f, distanceThreshold, altitudeThreshold = 0) {
  if (f.manualOverride !== null && f.manualOverride !== undefined) return !!f.manualOverride;
  if ((f.totalDistanceM || 0) >= distanceThreshold) return true;
  return altitudeThreshold > 0 && (f.maxAltitudeM || 0) >= altitudeThreshold;
}

export const floorMinutes = (sec) => Math.floor((sec || 0) / 60);
