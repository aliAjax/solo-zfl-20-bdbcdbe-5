const { readFile, writeFile, mkdir, rename } = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, "..", "data", "db.json");

const STORAGE_COLLECTIONS = [
  "locations",
  "storagePeriods",
  "readings",
  "anomalyPeriods"
];

const now = () => new Date().toISOString();

const initialData = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕",
      createdAt: now()
    }
  ],
  damages: [
    {
      id: "damage_demo_1",
      rubbingId: "rubbing_demo",
      position: "左上角第3列题字旁",
      type: "虫蛀孔",
      beforePhotoUrl: "https://example.local/before-014-1.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: now(),
      repairedAt: null
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: now(),
      repairedAt: null
    }
  ],
  batches: [],
  locations: [],
  storagePeriods: [],
  readings: [],
  anomalyPeriods: []
};

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

// 追加迁移：只补齐新集合，绝不动 rubbings / damages / batches 原有数据
function migrate(db) {
  let changed = false;
  for (const collection of STORAGE_COLLECTIONS) {
    if (!Array.isArray(db[collection])) {
      db[collection] = [];
      changed = true;
    }
  }
  return changed;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    // 文件缺失或损坏：写入含全部集合的初始库
    await atomicWrite(initialData);
  }
  // 注意：旧库缺新集合时不在此处重写文件——迁移在 readDb/mutate 中惰性完成，
  // 直到首次新功能写入才落盘，保证只读使用时原有文件原样不变。
}

async function atomicWrite(data) {
  const tmp = `${DB_FILE}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, DB_FILE);
}

// 读不加锁；调用方拿到的是独立快照
async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  migrate(db);
  return db;
}

// 读-改-写必须持锁，避免并发请求互相覆盖
let writeChain = Promise.resolve();
function mutate(updater) {
  const run = writeChain.then(async () => {
    const db = await readDb();
    const result = await updater(db);
    await atomicWrite(db);
    return result;
  });
  // 单个请求失败不应卡死后续请求
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

module.exports = { DB_FILE, STORAGE_COLLECTIONS, initialData, makeId, readDb, mutate, atomicWrite, ensureDb };
