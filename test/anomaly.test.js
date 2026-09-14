const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const h = require("../test-support/helpers");

before(async () => {
  await h.startServer();
});
after(h.stopServer);
beforeEach(async () => {
  await h.resetDb();
});

// 用一条正常读数打底，避免“首次越限”与序列起点混淆
async function seedNormal(loc) {
  await h.addReading(loc.id, "2026-09-09T20:00:00Z", { temperature: 20 });
}

test("孤立尖峰：关闭态下单次越限不开异常，随后一切如常", async () => {
  const loc = await h.createLocation({ thresholds: { temperature: { min: 15, max: 22 } } });
  await seedNormal(loc);

  const spike = await h.addReading(loc.id, "2026-09-10T10:00:00Z", { temperature: 35 });
  assert.equal(spike.status, 201);
  assert.equal(spike.body.anomalyEvent, null);
  assert.equal(spike.body.anomalyPeriod, null);

  // 尖峰之后直接正常：无任何异常
  const back = await h.addReading(loc.id, "2026-09-10T11:00:00Z", { temperature: 20 });
  assert.equal(back.body.anomalyEvent, null);

  const anomalies = await h.get("/anomalies");
  assert.equal(anomalies.body.data.length, 0);
  const open = await h.get("/anomalies?status=open");
  assert.equal(open.body.data.length, 0);
});

test("开启状态需要连续两次越限：越限-正常-越限仍是关闭态（第一次计数被正常打断）", async () => {
  const loc = await h.createLocation();
  await seedNormal(loc);

  await h.addReading(loc.id, "2026-09-10T10:00:00Z", { temperature: 30 }); // 越限1
  await h.addReading(loc.id, "2026-09-10T11:00:00Z", { temperature: 20 }); // 正常，打断
  const third = await h.addReading(loc.id, "2026-09-10T12:00:00Z", { temperature: 30 }); // 仅“第1次”
  assert.equal(third.body.anomalyEvent, null);
  assert.equal((await h.get("/anomalies")).body.data.length, 0);

  // 再来一次连续越限 -> 开启
  const opened = await h.addReading(loc.id, "2026-09-10T13:00:00Z", { temperature: 31 });
  assert.equal(opened.body.anomalyEvent, "opened");
  assert.equal(opened.body.anomalyPeriod.status, "open");
  assert.equal(opened.body.anomalyPeriod.startAt, "2026-09-10T12:00:00.000Z"); // 起自第一次
});

test("跨日越限：23:50 与次日 00:10 连续越限，异常跨日开启", async () => {
  const loc = await h.createLocation({ thresholds: { temperature: { min: 15, max: 22 } } });
  await h.addReading(loc.id, "2026-09-10T20:00:00Z", { temperature: 20 });

  const first = await h.addReading(loc.id, "2026-09-10T23:50:00Z", { temperature: 23.5 });
  assert.equal(first.body.anomalyEvent, null);
  const second = await h.addReading(loc.id, "2026-09-11T00:10:00Z", { temperature: 24 });
  assert.equal(second.body.anomalyEvent, "opened");

  const period = second.body.anomalyPeriod;
  assert.equal(period.startAt, "2026-09-10T23:50:00.000Z");
  assert.equal(period.endAt, null);
  assert.equal(period.breachCount, 2);
  assert.deepEqual(period.breachMetrics, ["temperature"]);
});

test("异常期间第一次正常不关闭；连续第二次正常才关闭（跨日）", async () => {
  const loc = await h.createLocation();
  await seedNormal(loc);
  await h.addReading(loc.id, "2026-09-10T22:00:00Z", { temperature: 30 });
  const opened = await h.addReading(loc.id, "2026-09-10T23:00:00Z", { temperature: 31 });
  assert.equal(opened.body.anomalyEvent, "opened");
  const anomalyId = opened.body.anomalyPeriod.id;

  // 异常中再多几次越限，只累计
  await h.addReading(loc.id, "2026-09-11T00:00:00Z", { temperature: 32 });
  await h.addReading(loc.id, "2026-09-11T01:00:00Z", { humidity: 30 }); // 湿度过低，另一指标

  const normal1 = await h.addReading(loc.id, "2026-09-11T02:00:00Z", { temperature: 20, humidity: 50 });
  assert.equal(normal1.body.anomalyEvent, null);
  assert.equal(normal1.body.anomalyPeriod.status, "open");
  assert.equal(normal1.body.anomalyPeriod.firstNormalAfterAt, "2026-09-11T02:00:00.000Z");

  // 查询 open 仍有一条
  assert.equal((await h.get("/anomalies?status=open")).body.data.length, 1);
  assert.equal((await h.get("/anomalies?status=closed")).body.data.length, 0);

  const normal2 = await h.addReading(loc.id, "2026-09-11T03:00:00Z", { temperature: 20, humidity: 50 });
  assert.equal(normal2.body.anomalyEvent, "closed");
  assert.equal(normal2.body.anomalyPeriod.status, "closed");
  assert.equal(normal2.body.anomalyPeriod.endAt, "2026-09-11T03:00:00.000Z");
  assert.equal(normal2.body.anomalyPeriod.id, anomalyId);

  // 期间共 4 次越限（30/31/32 + 湿度30），两个指标
  assert.equal(normal2.body.anomalyPeriod.breachCount, 4);
  assert.deepEqual(normal2.body.anomalyPeriod.breachMetrics.sort(), ["humidity", "temperature"]);
});

test("关闭确认中的两次正常被越限打断则作废：正常-越限-正常-正常才关闭", async () => {
  const loc = await h.createLocation();
  await seedNormal(loc);
  await h.addReading(loc.id, "2026-09-10T10:00:00Z", { temperature: 30 });
  await h.addReading(loc.id, "2026-09-10T11:00:00Z", { temperature: 31 }); // opened

  const n1 = await h.addReading(loc.id, "2026-09-10T12:00:00Z", { temperature: 20 });
  assert.equal(n1.body.anomalyPeriod.status, "open");
  await h.addReading(loc.id, "2026-09-10T13:00:00Z", { temperature: 31 }); // 越限打断
  const n1Again = await h.addReading(loc.id, "2026-09-10T14:00:00Z", { temperature: 20 });
  assert.equal(n1Again.body.anomalyEvent, null);
  assert.equal(n1Again.body.anomalyPeriod.status, "open");
  const n2 = await h.addReading(loc.id, "2026-09-10T15:00:00Z", { temperature: 20 });
  assert.equal(n2.body.anomalyEvent, "closed");
  assert.equal(n2.body.anomalyPeriod.endAt, "2026-09-10T15:00:00.000Z");
});

test("异常期间的孤立正常尖峰不关闭：正常-越限-越限-正常-正常", async () => {
  const loc = await h.createLocation();
  await seedNormal(loc);
  await h.addReading(loc.id, "2026-09-10T10:00:00Z", { temperature: 30 });
  await h.addReading(loc.id, "2026-09-10T11:00:00Z", { temperature: 31 }); // opened

  // 只来一次正常就又越限 -> 不关闭
  await h.addReading(loc.id, "2026-09-10T12:00:00Z", { temperature: 20 });
  await h.addReading(loc.id, "2026-09-10T13:00:00Z", { temperature: 31 });
  assert.equal((await h.get("/anomalies?status=open")).body.data.length, 1);

  await h.addReading(loc.id, "2026-09-10T14:00:00Z", { temperature: 20 });
  const close = await h.addReading(loc.id, "2026-09-10T15:00:00Z", { temperature: 20 });
  assert.equal(close.body.anomalyEvent, "closed");
});

test("光照越限同样驱动状态机", async () => {
  const loc = await h.createLocation({ thresholds: { lux: { min: 0, max: 50 } } });
  await h.addReading(loc.id, "2026-09-10T08:00:00Z", { lux: 10 });
  await h.addReading(loc.id, "2026-09-10T09:00:00Z", { lux: 120 }); // 第1次
  const opened = await h.addReading(loc.id, "2026-09-10T10:00:00Z", { lux: 200 }); // 第2次
  assert.equal(opened.body.anomalyEvent, "opened");
  assert.deepEqual(opened.body.anomalyPeriod.breachMetrics, ["lux"]);
});

// ---- 查询：拓片 / 位置 / 异常状态 -----------------------------------------

test("按拓片查询读数与异常：只覆盖该拓片保存时段涉及的位置", async () => {
  const r1 = await h.createRubbing();
  const r2 = await h.createRubbing();
  const l1 = await h.createLocation({ name: "位置1" });
  const l2 = await h.createLocation({ name: "位置2" });

  await h.post(`/rubbings/${r1.id}/storage-periods`, {
    locationId: l1.id,
    startAt: "2026-09-10T08:00:00Z",
    endAt: "2026-09-12T08:00:00Z"
  });
  await h.post(`/rubbings/${r2.id}/storage-periods`, {
    locationId: l2.id,
    startAt: "2026-09-10T08:00:00Z",
    endAt: "2026-09-12T08:00:00Z"
  });

  await h.addReading(l1.id, "2026-09-10T10:00:00Z", { temperature: 30 });
  await h.addReading(l1.id, "2026-09-10T11:00:00Z", { temperature: 31 }); // l1 开异常
  await h.addReading(l2.id, "2026-09-10T10:00:00Z", { temperature: 20 });
  await h.addReading(l2.id, "2026-09-10T11:00:00Z", { temperature: 31 }); // l2 孤立尖峰

  const r1Readings = (await h.get(`/readings?rubbingId=${r1.id}`)).body.data;
  assert.equal(r1Readings.length, 2);
  assert.ok(r1Readings.every((item) => item.locationId === l1.id));

  const r2Readings = (await h.get(`/readings?rubbingId=${r2.id}`)).body.data;
  assert.equal(r2Readings.length, 2);
  assert.ok(r2Readings.every((item) => item.locationId === l2.id));

  const r1Anomalies = (await h.get(`/anomalies?rubbingId=${r1.id}`)).body.data;
  assert.equal(r1Anomalies.length, 1);
  assert.equal(r1Anomalies[0].locationId, l1.id);
  assert.equal(r1Anomalies[0].locationName, l1.name);

  const r2Anomalies = (await h.get(`/anomalies?rubbingId=${r2.id}`)).body.data;
  assert.equal(r2Anomalies.length, 0); // 孤立尖峰
});

test("readings 查询参数：breached / from / to / limit", async () => {
  const loc = await h.createLocation();
  await seedNormal(loc);
  await h.addReading(loc.id, "2026-09-10T10:00:00Z", { temperature: 30 });
  await h.addReading(loc.id, "2026-09-10T11:00:00Z", { temperature: 31 });
  await h.addReading(loc.id, "2026-09-10T12:00:00Z", { temperature: 20 });

  const breached = (await h.get(`/readings?locationId=${loc.id}&breached=true`)).body.data;
  assert.equal(breached.length, 2);
  const normal = (await h.get(`/readings?locationId=${loc.id}&breached=false`)).body.data;
  assert.equal(normal.length, 2); // 打底 + 收尾

  const range = (await h.get(`/readings?locationId=${loc.id}&from=2026-09-10T10:30:00Z&to=2026-09-10T11:30:00Z`)).body.data;
  assert.equal(range.length, 1);
  assert.equal(range[0].ts, "2026-09-10T11:00:00.000Z");

  const limited = (await h.get(`/readings?locationId=${loc.id}&limit=2`)).body.data;
  assert.equal(limited.length, 2);
  assert.equal(limited[0].ts, "2026-09-10T11:00:00.000Z");
  assert.equal(limited[1].ts, "2026-09-10T12:00:00.000Z");
});

test("rubbingId + 不属于该拓片的 locationId 返回空", async () => {
  const rubbing = await h.createRubbing();
  const l1 = await h.createLocation({ name: "其一位" });
  const l2 = await h.createLocation({ name: "其二位" });
  await h.post(`/rubbings/${rubbing.id}/storage-periods`, {
    locationId: l1.id,
    startAt: "2026-09-10T08:00:00Z"
  });
  await h.addReading(l1.id, "2026-09-10T10:00:00Z", { temperature: 20 });
  await h.addReading(l2.id, "2026-09-10T10:00:00Z", { temperature: 20 });

  const empty = (await h.get(`/readings?rubbingId=${rubbing.id}&locationId=${l2.id}`)).body.data;
  assert.equal(empty.length, 0);
  const anomalyEmpty = (await h.get(`/anomalies?rubbingId=${rubbing.id}&locationId=${l2.id}`)).body.data;
  assert.equal(anomalyEmpty.length, 0);
});
