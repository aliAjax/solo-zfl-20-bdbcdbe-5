const { test, before, after } = require("node:test");
const assert = require("node:assert");
const h = require("../test-support/helpers");

before(async () => {
  await h.startServer();
});
after(h.stopServer);

test("健康检查列出全部新旧路由", async () => {
  const res = await h.get("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  for (const route of [
    "POST /batches",
    "GET /readings?rubbingId=&locationId=&breached=&from=&to=&limit=",
    "GET /anomalies?rubbingId=&locationId=&status=",
    "POST /locations/:id/readings"
  ]) {
    assert.ok(res.body.routes.includes(route), `缺少路由 ${route}`);
  }
});

test("原有数据不变：预置拓片与缺损项保持原样", async () => {
  const res = await h.get("/rubbings");
  assert.equal(res.status, 200);
  const demo = res.body.data.find((r) => r.id === "rubbing_demo");
  assert.ok(demo);
  assert.equal(demo.code, "TP-清-014");
  assert.equal(demo.source, "地方碑刻残页");
  assert.equal(demo.paperSize, "42x68cm");
  assert.equal(demo.note, "边缘有旧折痕");
  assert.equal(demo.damageCount, 2);
  assert.equal(demo.pendingDamages, 2);

  const damages = await h.get("/rubbings/rubbing_demo/damages");
  assert.equal(damages.body.data.length, 2);
  for (const id of ["damage_demo_1", "damage_demo_2"]) {
    const d = damages.body.data.find((item) => item.id === id);
    assert.ok(d, `缺少预置缺损项 ${id}`);
    assert.equal(d.status, "pending");
    assert.equal(d.batchId, null);
    assert.equal(d.repairedAt, null);
    assert.equal(d.afterPhotoUrl, "");
  }
});

test("旧接口回归：拓片登记", async () => {
  const created = await h.post("/rubbings", { code: "TP-测-001", source: "测试来源", paperSize: "20x30cm" });
  assert.equal(created.status, 201);
  assert.ok(created.body.data.id.startsWith("rubbing_"));
  assert.equal(created.body.data.note, "");

  const missing = await h.post("/rubbings", { code: "x" });
  assert.equal(missing.status, 400);
  const list = await h.get("/rubbings");
  assert.ok(list.body.data.some((r) => r.id === created.body.data.id));
});

test("旧接口回归：缺损项创建、筛选与修补", async () => {
  const add = await h.post("/rubbings/rubbing_demo/damages", {
    position: "右上角",
    type: "虫蛀孔",
    beforePhotoUrl: "https://example.local/x.jpg"
  });
  assert.equal(add.status, 201);
  assert.equal(add.body.data.status, "pending");

  const notFound = await h.post("/rubbings/no-such/damages", {
    position: "x",
    type: "y",
    beforePhotoUrl: "z"
  });
  assert.equal(notFound.status, 404);

  const byType = await h.get("/damages?type=虫蛀孔");
  assert.ok(byType.body.data.length >= 2);
  assert.ok(byType.body.data.every((d) => d.type === "虫蛀孔"));

  const patched = await h.patch(`/damages/${add.body.data.id}`, { status: "repaired", repairNote: "已补" });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.status, "repaired");
  assert.ok(patched.body.data.repairedAt);
});

test("旧接口回归：批次创建到完成的完整闭环", async () => {
  const batch = await h.post("/batches", { name: "测试批次", damageIds: ["damage_demo_1", "damage_demo_2"] });
  assert.equal(batch.status, 201);
  assert.equal(batch.body.data.status, "open");
  assert.equal(batch.body.data.total, 2);
  assert.equal(batch.body.data.pending, 2);

  const dmg = (await h.get("/damages")).body.data.find((d) => d.id === "damage_demo_1");
  assert.equal(dmg.status, "in_repair");
  assert.equal(dmg.batchId, batch.body.data.id);

  const invalid = await h.post("/batches", { name: "坏批次", damageIds: ["nope"] });
  assert.equal(invalid.status, 400);
  const empty = await h.post("/batches", { name: "空批次", damageIds: [] });
  assert.equal(empty.status, 400);

  const getBatch = await h.get(`/batches/${batch.body.data.id}`);
  assert.equal(getBatch.status, 200);

  const complete = await h.post(`/batches/${batch.body.data.id}/complete`, {
    defaultRepairNote: "整体修复完成"
  });
  assert.equal(complete.status, 200);
  assert.equal(complete.body.data.status, "completed");
  assert.ok(complete.body.data.completedAt);
  assert.equal(complete.body.data.repaired, 2);
  assert.equal(complete.body.data.pending, 0);

  const repaired = (await h.get("/damages?status=repaired")).body.data;
  assert.ok(repaired.some((d) => d.id === "damage_demo_1"));
  assert.ok(repaired.some((d) => d.id === "damage_demo_2"));
});

test("新增集合不影响旧数据结构，且未知路由返回404路由表", async () => {
  const res = await h.get("/no-such-path");
  assert.equal(res.status, 404);
  assert.ok(Array.isArray(res.body.routes));
});
