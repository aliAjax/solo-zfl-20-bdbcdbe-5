// 数据边界：非法公历日期拒绝（禁止滚动）、按拓片查询严格落在保存时段内、位置复用
const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs/promises");
const h = require("../test-support/helpers");

before(async () => {
  await h.startServer();
});
after(h.stopServer);
beforeEach(async () => {
  await h.resetDb();
});

// ---- 非法公历日期：不得静默滚动，不得写库 ----------------------------------

test("非法日期拒绝：不存在的日/月/时间分量全部 400", async () => {
  const loc = await h.createLocation();
  const rubbing = await h.createRubbing();
  const badDates = [
    "2026-02-31T10:00:00Z", // 2 月没有 31 日（会被 Date.parse 滚到 03-03）
    "2026-02-29T10:00:00Z", // 2026 非闰年
    "2026-02-30", // 日期型同样拒绝
    "2026-04-31T00:00:00Z", // 4 月只有 30 天
    "2026-06-31T00:00:00Z",
    "2026-09-00T00:00:00Z",
    "2026-13-01T00:00:00Z", // 月越界
    "2026-00-10T00:00:00Z",
    "2026-09-10T25:00:00Z", // 时越界
    "2026-09-10T23:60:00Z", // 分越界
    "2026-09-10T23:59:60Z" // 秒越界（不接受闰秒写法）
  ];

  let i = 0;
  for (const ts of badDates) {
    const res = await h.addReading(loc.id, ts, { temperature: 20 });
    assert.equal(res.status, 400, `非法日期应 400：${ts}`);
    i += 1;

    // 保存时段创建同样拒绝
    const period = await h.post(`/rubbings/${rubbing.id}/storage-periods`, {
      locationId: loc.id,
      startAt: ts
    });
    assert.equal(period.status, 400, `非法日期不能登记保存时段：${ts}`);
  }
  assert.equal(i, badDates.length);

  // 没有任何数据写库
  assert.equal((await h.get(`/readings?locationId=${loc.id}`)).body.data.length, 0);
  assert.equal((await h.get(`/rubbings/${rubbing.id}/storage-periods`)).body.data.length, 0);
});

test("合法边界日期接受：闰年 02-29、月末、12-31、时区偏移", async () => {
  const loc = await h.createLocation();
  // 同一位置要求时间戳递增，按时间顺序给出
  const okDates = [
    "2024-02-29", // 闰年日期型
    "2024-02-29T12:00:00Z", // 闰年
    "2026-02-28T23:59:59Z",
    "2026-04-30T00:00:00Z",
    "2026-09-10T08:30:00+08:00", // 显式时区偏移
    "2026-12-31T23:59:59Z"
  ];
  for (const ts of okDates) {
    const res = await h.addReading(loc.id, ts, { temperature: 20 });
    assert.equal(res.status, 201, `合法日期应接受：${ts} -> ${res.status} ${JSON.stringify(res.body.error)}`);
  }
  // 非闰年 02-29 被拒后再补一条 03-01：验证 02-29 没有被静默滚成 03-01
  const leapReject = await h.addReading(loc.id, "2026-02-29T12:00:00Z", { temperature: 20 });
  assert.equal(leapReject.status, 400);
  const tss = (await h.get(`/readings?locationId=${loc.id}`)).body.data.map((r) => r.ts);
  assert.ok(tss.includes("2024-02-29T00:00:00.000Z"));
  assert.ok(tss.includes("2024-02-29T12:00:00.000Z"));
  assert.ok(!tss.some((ts) => ts.startsWith("2026-03-01")), "被拒日期不得滚动后落库");
});

test("跨月滚动防护：2026-02-31 被拒后，3 月 3 日无幽灵数据", async () => {
  const loc = await h.createLocation();
  const rejected = await h.addReading(loc.id, "2026-02-31T10:00:00Z", { temperature: 99 });
  assert.equal(rejected.status, 400);
  const march = (await h.get(`/readings?locationId=${loc.id}&from=2026-03-01T00:00:00Z&to=2026-03-05T00:00:00Z`)).body.data;
  assert.deepEqual(march, []);

  // 查询参数本身用非法日期也应明确 400，而不是静默按 03-03 过滤
  const badQuery = await h.get(`/readings?locationId=${loc.id}&from=2026-02-31T00:00:00Z`);
  assert.equal(badQuery.status, 400);
});

// ---- 按拓片查询：只返回落在保存时段内的记录 --------------------------------

// 构造场景：
//  拓片 R 在库 L 的保存时段为 [09-10 08:00, 09-12 08:00)（半开）
//  读数时间轴（全部在 L）：
//    09-09 23:00  越限   （时段前）
//    09-10 08:00  正常   （= startAt，应包含）
//    09-10 09:00  越限
//    09-10 10:00  越限   （异常 A：09-10 09:00 开启）
//    09-10 11:00  正常
//    09-10 12:00  正常   （异常 A 关闭）
//    09-11 09:00  正常   （时段内，第二天）
//    09-12 08:00  越限   （= endAt，应排除）
//    09-12 09:00  越限   （时段后）
//    09-12 10:00  越限   （异常 B：09-12 09:00 开启，时段外）
async function seedBoundaryScene() {
  const rubbing = await h.createRubbing();
  const loc = await h.createLocation({ name: "边界库" });
  const period = await h.post(`/rubbings/${rubbing.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-10T08:00:00Z",
    endAt: "2026-09-12T08:00:00Z"
  });
  assert.equal(period.status, 201);

  const seq = [
    ["2026-09-09T23:00:00Z", 30],
    ["2026-09-10T08:00:00Z", 20],
    ["2026-09-10T09:00:00Z", 30],
    ["2026-09-10T10:00:00Z", 31],
    ["2026-09-10T11:00:00Z", 20],
    ["2026-09-10T12:00:00Z", 20],
    ["2026-09-11T09:00:00Z", 20],
    ["2026-09-12T08:00:00Z", 30],
    ["2026-09-12T09:00:00Z", 30],
    ["2026-09-12T10:00:00Z", 31]
  ];
  for (const [ts, t] of seq) {
    const r = await h.addReading(loc.id, ts, { temperature: t });
    assert.equal(r.status, 201, `${ts} ${r.status} ${JSON.stringify(r.body.error)}`);
  }
  return { rubbing, loc };
}

test("按拓片查询读数：严格落在保存时段 [start,end) 内，时段前后及 endAt 整点均排除", async () => {
  const { rubbing, loc } = await seedBoundaryScene();

  const byRubbing = (await h.get(`/readings?rubbingId=${rubbing.id}`)).body.data;
  const inPeriod = [
    "2026-09-10T08:00:00.000Z",
    "2026-09-10T09:00:00.000Z",
    "2026-09-10T10:00:00.000Z",
    "2026-09-10T11:00:00.000Z",
    "2026-09-10T12:00:00.000Z",
    "2026-09-11T09:00:00.000Z"
  ];
  assert.deepEqual(byRubbing.map((r) => r.ts), inPeriod);

  // startAt 整点包含、endAt 整点排除
  const tss = new Set(byRubbing.map((r) => r.ts));
  assert.ok(tss.has("2026-09-10T08:00:00.000Z"), "startAt 整点应包含");
  assert.ok(!tss.has("2026-09-12T08:00:00.000Z"), "endAt 整点应排除（半开区间）");
  assert.ok(!tss.has("2026-09-09T23:00:00.000Z"), "时段前读数排除");
  assert.ok(!tss.has("2026-09-12T09:00:00.000Z"), "时段后读数排除");

  // 同一位置直查仍能看到全部 10 条
  const byLocation = (await h.get(`/readings?locationId=${loc.id}`)).body.data;
  assert.equal(byLocation.length, 10);

  // 拓片 + 位置 组合：仍按保存时段裁剪
  const combo = (await h.get(`/readings?rubbingId=${rubbing.id}&locationId=${loc.id}`)).body.data;
  assert.deepEqual(combo.map((r) => r.ts), inPeriod);

  // breached 过滤与时间裁剪叠加
  const breachedInPeriod = (await h.get(`/readings?rubbingId=${rubbing.id}&breached=true`)).body.data;
  assert.deepEqual(
    breachedInPeriod.map((r) => r.ts),
    ["2026-09-10T09:00:00.000Z", "2026-09-10T10:00:00.000Z"]
  );
});

test("按拓片查询异常：仅返回与保存时段有交集的异常（时段内 A 返回，时段外 B 不返回）", async () => {
  const { rubbing, loc } = await seedBoundaryScene();

  const anomalies = (await h.get(`/anomalies?rubbingId=${rubbing.id}`)).body.data;
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].startAt, "2026-09-10T09:00:00.000Z");
  assert.equal(anomalies[0].endAt, "2026-09-10T12:00:00.000Z");
  assert.equal(anomalies[0].status, "closed");

  // 位置直查能看到两个异常（A 在时段内、B 在时段后开启且未关闭）
  const byLocation = (await h.get(`/anomalies?locationId=${loc.id}`)).body.data;
  assert.equal(byLocation.length, 2);
  const bAnomaly = byLocation.find((a) => a.startAt === "2026-09-12T08:00:00.000Z");
  assert.ok(bAnomaly, "位置直查应包含时段外开启的异常 B");
  assert.equal(bAnomaly.status, "open");
  assert.equal(bAnomaly.endAt, null);

  // 拓片维度查 open：B 虽 open 但整段在保存时段后，不得返回
  const openForRubbing = (await h.get(`/anomalies?rubbingId=${rubbing.id}&status=open`)).body.data;
  assert.deepEqual(openForRubbing, []);
});

test("异常跨保存时段边界：endAt 落在时段内但起点在时段前 → 不算该拓片的异常", async () => {
  // 单独构造：异常在保存时段开始前开启并持续——若异常 [aStart,aEnd] 与 [pStart,pEnd)
  // 仅在 pStart 之前存在（aEnd <= pStart），必须排除。
  const rubbing = await h.createRubbing();
  const loc = await h.createLocation({ name: "贴边库" });
  await h.post(`/rubbings/${rubbing.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-10T12:00:00Z",
    endAt: "2026-09-12T00:00:00Z"
  });
  // 异常 09:00 开、11:00 关（整点贴边：aEnd == pStart）
  for (const [ts, t] of [
    ["2026-09-10T08:00:00Z", 20],
    ["2026-09-10T09:00:00Z", 30],
    ["2026-09-10T10:00:00Z", 31],
    ["2026-09-10T11:00:00Z", 20],
    ["2026-09-10T11:30:00Z", 20]
  ]) {
    await h.addReading(loc.id, ts, { temperature: t });
  }
  const forRubbing = (await h.get(`/anomalies?rubbingId=${rubbing.id}`)).body.data;
  assert.deepEqual(forRubbing, []);
  const readings = (await h.get(`/readings?rubbingId=${rubbing.id}`)).body.data;
  assert.deepEqual(readings, []);
});

test("异常横跨边界（保存时段前开启、时段内仍在继续）应返回", async () => {
  const rubbing = await h.createRubbing();
  const loc = await h.createLocation({ name: "跨界库" });
  await h.post(`/rubbings/${rubbing.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-10T12:00:00Z",
    endAt: "2026-09-12T00:00:00Z"
  });
  // 09:00/10:00 连续越限开启，之后一直越限到 13:00（保存时段 12:00 开始后仍 open）
  for (const [ts, t] of [
    ["2026-09-10T09:00:00Z", 30],
    ["2026-09-10T10:00:00Z", 31],
    ["2026-09-10T13:00:00Z", 31]
  ]) {
    await h.addReading(loc.id, ts, { temperature: t });
  }
  const forRubbing = (await h.get(`/anomalies?rubbingId=${rubbing.id}`)).body.data;
  assert.equal(forRubbing.length, 1);
  assert.equal(forRubbing[0].status, "open");
  assert.equal(forRubbing[0].startAt, "2026-09-10T09:00:00.000Z");
  // 读数维度只统计时段内（12:00 之后）的一条
  const readings = (await h.get(`/readings?rubbingId=${rubbing.id}`)).body.data;
  assert.deepEqual(
    readings.map((r) => r.ts),
    ["2026-09-10T13:00:00.000Z"]
  );
});

test("位置复用：同一库位先后存放不同拓片，查询互不串数据；同拓片多段取并集", async () => {
  const r1 = await h.createRubbing();
  const r2 = await h.createRubbing();
  const loc = await h.createLocation({ name: "复用柜" });

  // r1: 09-01 ~ 09-03；r2: 09-05 ~ 09-07（中间空档 09-03~09-05）
  await h.post(`/rubbings/${r1.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-01T00:00:00Z",
    endAt: "2026-09-03T00:00:00Z"
  });
  await h.post(`/rubbings/${r2.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-05T00:00:00Z",
    endAt: "2026-09-07T00:00:00Z"
  });
  // r1 之后又回来：09-09 ~ 09-10（同拓片第二段，与第一段不重叠）
  await h.post(`/rubbings/${r1.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-09T00:00:00Z",
    endAt: "2026-09-10T00:00:00Z"
  });

  const seq = [
    ["2026-08-31T12:00:00Z", 20], // 无人存放
    ["2026-09-01T12:00:00Z", 20], // r1 段1
    ["2026-09-02T12:00:00Z", 20], // r1 段1（正常）
    ["2026-09-03T00:00:00Z", 30], // r1 段1 endAt 整点（排除），越限1
    ["2026-09-03T01:00:00Z", 31], // 空档越限2 -> 异常 A 开启于 endAt 整点
    ["2026-09-04T12:00:00Z", 31], // 空档越限，异常 A 持续
    ["2026-09-04T18:00:00Z", 20], // 空档正常1
    ["2026-09-04T20:00:00Z", 20], // 空档正常2 -> 异常 A 在空档内关闭
    ["2026-09-05T12:00:00Z", 20], // r2
    ["2026-09-06T12:00:00Z", 20], // r2
    ["2026-09-09T12:00:00Z", 20] // r1 段2
  ];
  for (const [ts, t] of seq) await h.addReading(loc.id, ts, { temperature: t });

  const r1Readings = (await h.get(`/readings?rubbingId=${r1.id}`)).body.data.map((r) => r.ts);
  assert.deepEqual(r1Readings, ["2026-09-01T12:00:00.000Z", "2026-09-02T12:00:00.000Z", "2026-09-09T12:00:00.000Z"]);

  const r2Readings = (await h.get(`/readings?rubbingId=${r2.id}`)).body.data.map((r) => r.ts);
  assert.deepEqual(r2Readings, ["2026-09-05T12:00:00.000Z", "2026-09-06T12:00:00.000Z"]);

  // 异常 A 为 [09-03T00:00, 09-04T20:00]：与 r1 段1 在端点相切（半开不算相交），
  // 与 r2 无交集，与 r1 段2 也无交集。故两个拓片都查不到异常，位置维度可见。
  assert.deepEqual((await h.get(`/anomalies?rubbingId=${r1.id}`)).body.data, []);
  assert.deepEqual((await h.get(`/anomalies?rubbingId=${r2.id}`)).body.data, []);
  const locAnomalies = (await h.get(`/anomalies?locationId=${loc.id}`)).body.data;
  assert.equal(locAnomalies.length, 1);
  assert.equal(locAnomalies[0].startAt, "2026-09-03T00:00:00.000Z");
  assert.equal(locAnomalies[0].endAt, "2026-09-04T20:00:00.000Z");

  // 全位置 11 条读数一条不少
  assert.equal((await h.get(`/readings?locationId=${loc.id}`)).body.data.length, 11);
});

test("关闭保存时段使用非法日期同样拒绝，且时段保持开放", async () => {
  const rubbing = await h.createRubbing();
  const loc = await h.createLocation();
  const period = await h.post(`/rubbings/${rubbing.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-10T00:00:00Z"
  });
  assert.equal(period.status, 201);

  const bad = await h.post(`/storage-periods/${period.body.data.id}/close`, { endAt: "2026-02-31T00:00:00Z" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /禁止滚动|不存在/);

  // 时段仍开放，未被写入错误 endAt
  const open = (await h.get("/storage-periods?active=true")).body.data;
  assert.equal(open.length, 1);
  assert.equal(open[0].endAt, null);

  // 合法关闭正常
  const ok = await h.post(`/storage-periods/${period.body.data.id}/close`, { endAt: "2026-09-12T00:00:00Z" });
  assert.equal(ok.status, 200);
});

test("开放保存时段：endAt 为空时其后读数按开放区间持续包含", async () => {
  const rubbing = await h.createRubbing();
  const loc = await h.createLocation({ name: "开放段库" });
  await h.post(`/rubbings/${rubbing.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-10T00:00:00Z"
  });
  for (const ts of ["2026-09-09T23:59:00Z", "2026-09-10T00:00:00Z", "2026-09-30T23:00:00Z"]) {
    await h.addReading(loc.id, ts, { temperature: 20 });
  }
  const rows = (await h.get(`/readings?rubbingId=${rubbing.id}`)).body.data.map((r) => r.ts);
  assert.deepEqual(rows, ["2026-09-10T00:00:00.000Z", "2026-09-30T23:00:00.000Z"]);
});
