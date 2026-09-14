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

test("并发登记重叠保存时段：恰好一个成功，其余 409", async () => {
  const rubbing = await h.createRubbing();
  const loc = await h.createLocation();
  const payload = {
    locationId: loc.id,
    startAt: "2026-10-01T00:00:00Z",
    endAt: "2026-10-05T00:00:00Z"
  };
  const results = await Promise.all(
    Array.from({ length: 10 }, () => h.post(`/rubbings/${rubbing.id}/storage-periods`, payload))
  );
  const created = results.filter((r) => r.status === 201);
  const conflicts = results.filter((r) => r.status === 409);
  assert.equal(created.length, 1, "重叠时段必须只有一条创建成功");
  assert.equal(conflicts.length, 9);

  const list = (await h.get(`/rubbings/${rubbing.id}/storage-periods`)).body.data;
  assert.equal(list.length, 1);
});

test("并发登记互不重叠的相邻时段：首尾相接全部成功", async () => {
  const rubbing = await h.createRubbing();
  const loc = await h.createLocation();
  const days = [1, 2, 3, 4, 5];
  const results = await Promise.all(
    days.map((d) =>
      h.post(`/rubbings/${rubbing.id}/storage-periods`, {
        locationId: loc.id,
        startAt: `2026-10-0${d}T00:00:00Z`,
        endAt: `2026-10-0${d + 1}T00:00:00Z`
      })
    )
  );
  // 注意：这些时段两两首尾相接但并发时可能乱序处理，乱序不影响“不重叠”判定
  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));
  const list = (await h.get(`/rubbings/${rubbing.id}/storage-periods`)).body.data;
  assert.equal(list.length, 5);
});

test("并发上报同一位置同一时间戳读数：恰好一条入库，其余按重复拒绝", async () => {
  const loc = await h.createLocation();
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      h.post(`/locations/${loc.id}/readings`, { ts: "2026-10-01T08:00:00Z", temperature: 20 })
    )
  );
  const created = results.filter((r) => r.status === 201);
  const dups = results.filter((r) => r.status === 409);
  assert.equal(created.length, 1);
  assert.equal(dups.length, 11);
  assert.match(dups[0].body.error, /重复/);

  const list = (await h.get(`/readings?locationId=${loc.id}`)).body.data;
  assert.equal(list.length, 1);
});

test("并发写不同位置读数互不覆盖（无丢失更新）", async () => {
  const locs = [];
  for (let i = 0; i < 5; i += 1) locs.push(await h.createLocation({ name: `并发库${i}` }));

  const PER_LOC = 8;
  const tasks = [];
  locs.forEach((loc, li) => {
    for (let i = 0; i < PER_LOC; i += 1) {
      // 每个位置使用各自递增的时间戳；同位置的请求也并发发出，
      // 时间戳间隔足够大。即使乱序被拒，最终按“每个位置仅一个时间戳集合”校验：
      tasks.push(
        h.post(`/locations/${loc.id}/readings`, {
          ts: `2026-10-01T0${li}:${String(i * 5).padStart(2, "0")}:00Z`,
          temperature: 20
        })
      );
    }
  });
  const results = await Promise.all(tasks);
  const serverErrors = results.filter((r) => r.status >= 500);
  assert.equal(serverErrors.length, 0);

  // 关键不变量：每个位置的读数全部保留、没有被其他位置的写覆盖
  for (const loc of locs) {
    const list = (await h.get(`/readings?locationId=${loc.id}`)).body.data;
    const tsSet = new Set(list.map((r) => r.ts));
    assert.equal(tsSet.size, list.length, "同位置不得出现重复时间戳");
    assert.ok(list.every((r) => r.locationId === loc.id), "读数不得串位置");
    // 乱序处理可能导致部分请求 409；但已成功的时间戳必须全部可查
    const succeeded = results
      .filter((r) => r.status === 201 && r.body.data.locationId === loc.id)
      .map((r) => r.body.data.ts);
    for (const ts of succeeded) assert.ok(tsSet.has(ts), `成功写入的读数丢失：${ts}`);
  }

  const totalListed = (await h.get("/readings")).body.data.length;
  const totalCreated = results.filter((r) => r.status === 201).length;
  assert.equal(totalListed, totalCreated, "总数一致，无丢失更新");
});

test("并发混合：非法日期/越量程/重复请求一律不写库，合法请求不丢失", async () => {
  const loc = await h.createLocation();
  const tasks = [
    // 合法（不同时间戳）
    h.post(`/locations/${loc.id}/readings`, { ts: "2026-11-01T08:00:00Z", temperature: 20 }),
    h.post(`/locations/${loc.id}/readings`, { ts: "2026-11-01T08:05:00Z", temperature: 21 }),
    // 非法公历日期：11 月没有 31 日，会滚到 12-01 —— 必须拒绝
    h.post(`/locations/${loc.id}/readings`, { ts: "2026-11-31T08:10:00Z", temperature: 20 }),
    // 非闰年 02-29
    h.post(`/locations/${loc.id}/readings`, { ts: "2026-02-29T08:15:00Z", temperature: 20 }),
    // 越量程
    h.post(`/locations/${loc.id}/readings`, { ts: "2026-11-01T08:20:00Z", temperature: 999 }),
    // 与第一条同时间戳的重复
    h.post(`/locations/${loc.id}/readings`, { ts: "2026-11-01T08:00:00Z", temperature: 22 }),
    // 合法
    h.post(`/locations/${loc.id}/readings`, { ts: "2026-11-01T08:25:00Z", temperature: 19 })
  ];
  const results = await Promise.all(tasks);
  const byStatus = (code) => results.filter((r) => r.status === code);
  assert.equal(byStatus(201).length, 3);
  assert.equal(byStatus(400).length, 3); // 2 非法日期 + 1 越量程
  assert.equal(byStatus(409).length, 1); // 重复

  // 恰好 3 条合法读数落库，时间戳无 12-01 幽灵数据
  const list = (await h.get(`/readings?locationId=${loc.id}`)).body.data;
  assert.deepEqual(
    list.map((r) => r.ts),
    ["2026-11-01T08:00:00.000Z", "2026-11-01T08:05:00.000Z", "2026-11-01T08:25:00.000Z"]
  );
  const ghost = await h.get(`/readings?locationId=${loc.id}&from=2026-12-01T00:00:00Z&to=2026-12-02T00:00:00Z`);
  assert.deepEqual(ghost.body.data, []);
});

test("并发上报两条相邻时间戳读数：不会产生重复异常时段", async () => {
  const loc = await h.createLocation();
  // 两个并发请求分别提交 08:00 / 08:05 的越限读数。
  // 合法结果有两种：两条都入库（按序处理）-> 1 个异常；
  // 或 08:05 先到导致 08:00 被倒序拒绝 -> 孤立尖峰，0 个异常。
  // 无论哪种，都绝不能出现 2 个异常时段。
  const results = await Promise.all([
    h.post(`/locations/${loc.id}/readings`, { ts: "2026-10-01T08:00:00Z", temperature: 30 }),
    h.post(`/locations/${loc.id}/readings`, { ts: "2026-10-01T08:05:00Z", temperature: 31 })
  ]);
  const serverErrors = results.filter((r) => r.status >= 500);
  assert.equal(serverErrors.length, 0);

  const anomalies = (await h.get(`/anomalies?locationId=${loc.id}`)).body.data;
  assert.ok(anomalies.length <= 1, "并发下异常时段至多一个");
  if (results.every((r) => r.status === 201)) {
    assert.equal(anomalies.length, 1);
    assert.equal(anomalies[0].status, "open");
    assert.equal(anomalies[0].startAt, "2026-10-01T08:00:00.000Z");
  }
});
