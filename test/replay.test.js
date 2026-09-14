// 确定性重放：由全部读数重建异常时段，必须与在线状态机落盘结果一致，且重放幂等
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs/promises");

const DB_FILE = path.join(
  os.tmpdir(),
  `rubbing-replay-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`
);
process.env.DB_FILE = DB_FILE;

const db = require("../lib/db");
const storage = require("../lib/storage");

function normalize(periods) {
  // 重放结果使用合成 id / createdAt，比较业务字段
  return periods
    .map((p) => ({
      locationId: p.locationId,
      seq: p.seq,
      status: p.status,
      startAt: p.startAt,
      endAt: p.endAt,
      firstNormalAfterAt: p.firstNormalAfterAt,
      breachCount: p.breachCount,
      breachMetrics: p.breachMetrics,
      breachReadings: p.breachReadings
    }))
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
}

test("在线状态机结果 === 读数重放结果（含跨日开闭、尖峰、打断重计）", async () => {
  await db.atomicWrite(db.initialData);
  const snapshot = await db.mutate((d) => {
    const loc = storage.createLocation(d, { name: "重放库" }, db.makeId);
    const seq = [
      ["2026-09-10T20:00:00Z", 20, false],
      ["2026-09-10T23:30:00Z", 30, true],
      ["2026-09-11T00:30:00Z", 31, true], // open（跨日）
      ["2026-09-11T01:00:00Z", 20, false],
      ["2026-09-11T02:00:00Z", 20, false], // close（跨日）
      ["2026-09-11T03:00:00Z", 30, true], // 关闭态孤立尖峰
      ["2026-09-11T04:00:00Z", 31, true], // open
      ["2026-09-11T05:00:00Z", 20, false],
      ["2026-09-11T06:00:00Z", 30, true], // 打断关闭确认
      ["2026-09-11T07:00:00Z", 20, false],
      ["2026-09-11T08:00:00Z", 20, false] // close
    ];
    for (const [ts, temperature] of seq) {
      storage.addReading(d, { locationId: loc.id, ts, temperature }, db.makeId);
    }
    return loc.id;
  });

  const fresh = await db.readDb();
  const online = normalize(fresh.anomalyPeriods);
  const replayed = normalize(storage.rebuildLocationAnomalies(fresh, snapshot));
  assert.deepEqual(replayed, online);

  // 关键状态断言
  assert.equal(online.length, 2);
  assert.deepEqual(
    online.map((p) => p.status),
    ["closed", "closed"]
  );
  assert.equal(online[0].startAt, "2026-09-10T23:30:00.000Z");
  assert.equal(online[0].endAt, "2026-09-11T02:00:00.000Z");
  assert.equal(online[1].startAt, "2026-09-11T03:00:00.000Z");
  assert.equal(online[1].endAt, "2026-09-11T08:00:00.000Z");
  // 第二段异常包含打断那次越限，共 3 次
  assert.equal(online[1].breachCount, 3);

  // 重放幂等：再重放一次完全一致
  const replayed2 = normalize(storage.rebuildLocationAnomalies(fresh, snapshot));
  assert.deepEqual(replayed2, replayed);

  await fs.rm(DB_FILE, { force: true });
});

test("重放开放异常：序列末尾停在 open / 等待第二次正常，均正确还原", async () => {
  await db.atomicWrite(db.initialData);
  const { locId } = await db.mutate((d) => {
    const loc = storage.createLocation(d, { name: "开放库" }, db.makeId);
    for (const [ts, t] of [
      ["2026-09-10T10:00:00Z", 20],
      ["2026-09-10T11:00:00Z", 30],
      ["2026-09-10T12:00:00Z", 31], // open
      ["2026-09-10T13:00:00Z", 20] // 第一次正常，仍 open
    ]) {
      storage.addReading(d, { locationId: loc.id, ts, temperature: t }, db.makeId);
    }
    return { locId: loc.id };
  });
  const fresh = await db.readDb();
  const online = normalize(fresh.anomalyPeriods);
  const replayed = normalize(storage.rebuildLocationAnomalies(fresh, locId));
  assert.deepEqual(replayed, online);
  assert.equal(online.length, 1);
  assert.equal(online[0].status, "open");
  assert.equal(online[0].endAt, null);
  assert.equal(online[0].firstNormalAfterAt, "2026-09-10T13:00:00.000Z");
  await fs.rm(DB_FILE, { force: true });
});
