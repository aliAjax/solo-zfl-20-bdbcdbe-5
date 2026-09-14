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

// ---- 保存位置与阈值 -------------------------------------------------------

test("位置创建：缺省阈值自动补齐，三项指标齐全", async () => {
  const loc = await h.createLocation({ name: "善本库A柜", thresholds: { temperature: { min: 16, max: 20 } } });
  assert.equal(loc.thresholds.temperature.min, 16);
  assert.equal(loc.thresholds.temperature.max, 20);
  assert.deepEqual(loc.thresholds.humidity, { min: 45, max: 60 });
  assert.deepEqual(loc.thresholds.lux, { min: 0, max: 50 });
});

test("位置校验：名称冲突 409，阈值非法 400", async () => {
  await h.createLocation({ name: "固定名", code: "C1" });
  const dup = await h.post("/locations", { name: "固定名" });
  assert.equal(dup.status, 409);
  const dupCode = await h.post("/locations", { name: "另一个", code: "C1" });
  assert.equal(dupCode.status, 409);

  const noName = await h.post("/locations", {});
  assert.equal(noName.status, 400);
  const badRange = await h.post("/locations", { name: "x", thresholds: { temperature: { min: 22, max: 15 } } });
  assert.equal(badRange.status, 400);
  const outOfPhysical = await h.post("/locations", { name: "y", thresholds: { humidity: { min: -1, max: 50 } } });
  assert.equal(outOfPhysical.status, 400);
});

test("阈值修改只影响后续读数，历史读数 breached 不回溯", async () => {
  const loc = await h.createLocation({ thresholds: { temperature: { min: 15, max: 25 } } });
  await h.addReading(loc.id, "2026-09-10T10:00:00Z", { temperature: 24 }); // 旧阈值下正常
  const patch = await h.patch(`/locations/${loc.id}`, { thresholds: { temperature: { min: 15, max: 22 } } });
  assert.equal(patch.status, 200);
  await h.addReading(loc.id, "2026-09-10T11:00:00Z", { temperature: 24 }); // 新阈值下越限

  const list = (await h.get(`/readings?locationId=${loc.id}`)).body.data;
  assert.equal(list[0].breached, false);
  assert.equal(list[1].breached, true);
});

// ---- 保存时段 -------------------------------------------------------------

test("保存时段：登记、列表与关闭", async () => {
  const rubbing = await h.createRubbing();
  const loc = await h.createLocation();
  const created = await h.post(`/rubbings/${rubbing.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-10T08:00:00Z"
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.endAt, null);

  const list = await h.get(`/rubbings/${rubbing.id}/storage-periods`);
  assert.equal(list.body.data[0].locationName, loc.name);
  assert.equal(list.body.data[0].rubbingCode, rubbing.code);

  const closed = await h.post(`/storage-periods/${created.body.data.id}/close`, {
    endAt: "2026-09-12T08:00:00Z"
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.data.endAt, "2026-09-12T08:00:00.000Z");

  const again = await h.post(`/storage-periods/${created.body.data.id}/close`, {});
  assert.equal(again.status, 409);
});

test("保存时段：同一拓片区间重叠被拒（409），首尾相接允许", async () => {
  const r1 = await h.createRubbing();
  const r2 = await h.createRubbing();
  const loc = await h.createLocation();

  const a = await h.post(`/rubbings/${r1.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-10T08:00:00Z",
    endAt: "2026-09-12T08:00:00Z"
  });
  assert.equal(a.status, 201);

  // 完全包含 -> 重叠
  const inside = await h.post(`/rubbings/${r1.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-11T00:00:00Z",
    endAt: "2026-09-11T12:00:00Z"
  });
  assert.equal(inside.status, 409);

  // 开放时段与任何后续时段重叠
  const openOverlap = await h.post(`/rubbings/${r1.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-13T00:00:00Z"
  });
  assert.equal(openOverlap.status, 201);
  const conflictWithOpen = await h.post(`/rubbings/${r1.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-14T00:00:00Z",
    endAt: "2026-09-15T00:00:00Z"
  });
  assert.equal(conflictWithOpen.status, 409);

  // 首尾相接（前一个 end == 后一个 start）不算重叠
  const adjacent = await h.post(`/rubbings/${r1.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-12T08:00:00Z",
    endAt: "2026-09-13T00:00:00Z"
  });
  assert.equal(adjacent.status, 201);

  // 不同拓片同时段允许
  const other = await h.post(`/rubbings/${r2.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-10T08:00:00Z",
    endAt: "2026-09-12T08:00:00Z"
  });
  assert.equal(other.status, 201);

  // 引用不存在的拓片/位置
  const noRubbing = await h.post(`/rubbings/missing/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-10T08:00:00Z"
  });
  assert.equal(noRubbing.status, 404);
  const noLocation = await h.post(`/rubbings/${r1.id}/storage-periods`, {
    locationId: "missing",
    startAt: "2026-09-10T08:00:00Z"
  });
  assert.equal(noLocation.status, 404);

  // endAt <= startAt
  const badTime = await h.post(`/rubbings/${r2.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-20T08:00:00Z",
    endAt: "2026-09-20T07:00:00Z"
  });
  assert.equal(badTime.status, 400);
});

test("关闭开放时段：结束时间早于开始 400；合法关闭 200", async () => {
  const rubbing = await h.createRubbing();
  const loc = await h.createLocation();
  // 封闭时段 A：09-01 ~ 09-10
  await h.post(`/rubbings/${rubbing.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-01T00:00:00Z",
    endAt: "2026-09-10T00:00:00Z"
  });
  // 开放时段 B：09-15 起（与 A 首尾相接规则之外，留了空档）
  const open = await h.post(`/rubbings/${rubbing.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-15T00:00:00Z"
  });
  assert.equal(open.status, 201);

  const beforeStart = await h.post(`/storage-periods/${open.body.data.id}/close`, {
    endAt: "2026-09-14T00:00:00Z"
  });
  assert.equal(beforeStart.status, 400);

  // 未关闭前 active=true
  let active = await h.get("/storage-periods?active=true");
  assert.equal(active.body.data.length, 1);

  const ok = await h.post(`/storage-periods/${open.body.data.id}/close`, {
    endAt: "2026-09-20T00:00:00Z"
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.endAt, "2026-09-20T00:00:00.000Z");
});

test("保存时段筛选：active 与 locationId", async () => {
  const rubbing = await h.createRubbing();
  const loc = await h.createLocation();
  const p = await h.post(`/rubbings/${rubbing.id}/storage-periods`, {
    locationId: loc.id,
    startAt: "2026-09-10T08:00:00Z"
  });
  let list = await h.get("/storage-periods?active=true");
  assert.equal(list.body.data.length, 1);
  list = await h.get("/storage-periods?active=false");
  assert.equal(list.body.data.length, 0);
  list = await h.get(`/storage-periods?locationId=${loc.id}`);
  assert.equal(list.body.data.length, 1);
  await h.post(`/storage-periods/${p.body.data.id}/close`, { endAt: "2026-09-11T08:00:00Z" });
  list = await h.get("/storage-periods?active=false");
  assert.equal(list.body.data.length, 1);
});

// ---- 读数校验：重复 / 倒序 / 越量程 ---------------------------------------

test("读数：重复时间戳 409", async () => {
  const loc = await h.createLocation();
  const first = await h.addReading(loc.id, "2026-09-10T10:00:00Z", { temperature: 20 });
  assert.equal(first.status, 201);
  const dup = await h.addReading(loc.id, "2026-09-10T10:00:00Z", { temperature: 21 });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /重复/);
  // 重复读数未入库
  const list = (await h.get(`/readings?locationId=${loc.id}`)).body.data;
  assert.equal(list.length, 1);
});

test("读数：倒序 409；不同位置互不影响顺序", async () => {
  const a = await h.createLocation({ name: "库A" });
  const b = await h.createLocation({ name: "库B" });
  await h.addReading(a.id, "2026-09-10T12:00:00Z", { temperature: 20 });
  const outOfOrder = await h.addReading(a.id, "2026-09-10T11:00:00Z", { temperature: 20 });
  assert.equal(outOfOrder.status, 409);
  assert.match(outOfOrder.body.error, /倒序/);
  // 库 B 从 11:00 开始完全合法
  const other = await h.addReading(b.id, "2026-09-10T11:00:00Z", { temperature: 20 });
  assert.equal(other.status, 201);
});

test("读数：越量程 400（温度/湿度/光照边界）", async () => {
  const loc = await h.createLocation();
  const cases = [
    { temperature: 250 },
    { temperature: -51 },
    { humidity: 101 },
    { humidity: -0.1 },
    { lux: 200001 }
  ];
  let i = 0;
  for (const values of cases) {
    const res = await h.addReading(loc.id, `2026-09-10T1${i}:00:00Z`, values);
    assert.equal(res.status, 400, `${JSON.stringify(values)} 应被拒绝`);
    i += 1;
  }
  // 物理量程边界合法
  const edge = await h.addReading(loc.id, "2026-09-10T20:00:00Z", { temperature: -50, humidity: 100, lux: 200000 });
  assert.equal(edge.status, 201);

  const noMetric = await h.addReading(loc.id, "2026-09-10T21:00:00Z", {});
  assert.equal(noMetric.status, 400);
  const badType = await h.addReading(loc.id, "2026-09-10T22:00:00Z", { temperature: "热" });
  assert.equal(badType.status, 400);
});

test("读数：时间格式非法 400；毫秒时间戳被接受", async () => {
  const loc = await h.createLocation();
  const bad = await h.addReading(loc.id, "not-a-time", { temperature: 20 });
  assert.equal(bad.status, 400);
  const ms = await h.addReading(loc.id, Date.parse("2026-09-10T10:00:00Z"), { temperature: 20 });
  assert.equal(ms.status, 201);
  assert.equal(ms.body.data.ts, "2026-09-10T10:00:00.000Z");
});
