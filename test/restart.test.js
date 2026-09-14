const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const os = require("os");
const path = require("path");
const fs = require("fs/promises");

const SERVER = path.join(__dirname, "..", "server.js");
const DB_FILE = path.join(
  os.tmpdir(),
  `rubbing-restart-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`
);

let children = [];

async function startServerProcess() {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DB_FILE, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"]
  });
  children.push(child);
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 5000);
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on("exit", (code) => reject(new Error(`服务意外退出 code=${code}`)));
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

async function stopServerProcess(child) {
  await new Promise((resolve) => {
    child.on("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 2000);
  });
  children = children.filter((c) => c !== child);
}

async function api(base, method, urlPath, body) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

const seq = [
  // [时间, 温度, 说明]
  ["2026-09-10T20:00:00Z", 20, "打底正常"],
  ["2026-09-10T23:30:00Z", 30, "跨日越限1"],
  ["2026-09-11T00:30:00Z", 31, "跨日越限2 -> open"],
  ["2026-09-11T01:00:00Z", 20, "第一次正常"],
  ["2026-09-11T02:00:00Z", 20, "第二次正常 -> closed"],
  ["2026-09-11T03:00:00Z", 30, "关闭态孤立尖峰"],
  ["2026-09-11T04:00:00Z", 31, "再次连续越限 -> open(重启时保持open)"]
];

let snapshot;

test("准备旧格式库文件（无巡护集合），首次启动自动迁移且原有数据不变", async () => {
  await fs.rm(DB_FILE, { force: true });
  const legacy = {
    rubbings: [
      {
        id: "rubbing_legacy",
        code: "TP-旧-001",
        source: "旧库来源",
        paperSize: "10x10cm",
        note: "迁移前已存在",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    damages: [
      {
        id: "damage_legacy_1",
        rubbingId: "rubbing_legacy",
        position: "正中",
        type: "霉斑",
        beforePhotoUrl: "https://example.local/legacy.jpg",
        afterPhotoUrl: "",
        status: "pending",
        repairNote: "",
        batchId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        repairedAt: null
      }
    ],
    batches: []
  };
  await fs.writeFile(DB_FILE, JSON.stringify(legacy, null, 2));
  const { child, base } = await startServerProcess();

  const rubbings = await api(base, "GET", "/rubbings");
  const { damageCount, pendingDamages, ...legacyRubbing } = rubbings.body.data.find(
    (r) => r.id === "rubbing_legacy"
  );
  assert.deepEqual(legacyRubbing, legacy.rubbings[0]);
  assert.equal(damageCount, 1);
  const damages = await api(base, "GET", "/rubbings/rubbing_legacy/damages");
  assert.deepEqual(damages.body.data, legacy.damages);

  // 迁移后新集合可用且为空
  assert.deepEqual((await api(base, "GET", "/locations")).body.data, []);
  assert.deepEqual((await api(base, "GET", "/anomalies")).body.data, []);

  // 只读访问不改动旧库文件：磁盘内容与迁移前逐字节一致
  const onDiskAfterReads = await fs.readFile(DB_FILE, "utf8");
  assert.equal(onDiskAfterReads, JSON.stringify(legacy, null, 2));

  globalThis.__first = { child, base };
});

test("重启前写入完整跨日状态机序列并留存快照", async () => {
  const { base } = globalThis.__first;
  const loc = await api(base, "POST", "/locations", { name: "重启测试库" });
  const locationId = loc.body.data.id;
  const period = await api(base, "POST", "/rubbings/rubbing_legacy/storage-periods", {
    locationId,
    startAt: "2026-09-10T00:00:00Z"
  });
  assert.equal(period.status, 201);

  const events = [];
  for (const [ts, temperature] of seq) {
    const r = await api(base, "POST", `/locations/${locationId}/readings`, { ts, temperature });
    assert.equal(r.status, 201, `${ts} 应入库`);
    events.push(r.body.anomalyEvent);
  }
  assert.deepEqual(events, [null, null, "opened", null, "closed", null, "opened"]);

  snapshot = {
    readings: (await api(base, "GET", `/readings?locationId=${locationId}`)).body,
    anomalies: (await api(base, "GET", `/anomalies?locationId=${locationId}`)).body,
    anomaliesOpen: (await api(base, "GET", `/anomalies?locationId=${locationId}&status=open`)).body,
    anomaliesClosed: (await api(base, "GET", `/anomalies?locationId=${locationId}&status=closed`)).body,
    periods: (await api(base, "GET", "/storage-periods")).body,
    rubbingReadings: (await api(base, "GET", "/readings?rubbingId=rubbing_legacy")).body
  };
  assert.equal(snapshot.anomalies.data.length, 2);
  assert.equal(snapshot.anomaliesOpen.data.length, 1);
  assert.equal(snapshot.anomaliesClosed.data.length, 1);
  assert.equal(snapshot.anomaliesOpen.data[0].startAt, "2026-09-11T03:00:00.000Z");
  assert.equal(snapshot.anomaliesClosed.data[0].endAt, "2026-09-11T02:00:00.000Z");
});

test("杀掉进程后以同一数据文件重启：查询结果逐字节语义一致", async () => {
  const { child, base: base1 } = globalThis.__first;
  await stopServerProcess(child);

  const second = await startServerProcess();
  globalThis.__second = second;
  const { base } = second;

  const locationId = snapshot.readings.data[0].locationId;
  const after = {
    readings: (await api(base, "GET", `/readings?locationId=${locationId}`)).body,
    anomalies: (await api(base, "GET", `/anomalies?locationId=${locationId}`)).body,
    anomaliesOpen: (await api(base, "GET", `/anomalies?locationId=${locationId}&status=open`)).body,
    anomaliesClosed: (await api(base, "GET", `/anomalies?locationId=${locationId}&status=closed`)).body,
    periods: (await api(base, "GET", "/storage-periods")).body,
    rubbingReadings: (await api(base, "GET", "/readings?rubbingId=rubbing_legacy")).body
  };
  assert.deepEqual(after, snapshot);

  // 重启不影响旧数据
  const damages = await api(base, "GET", "/damages?status=pending");
  assert.ok(damages.body.data.some((d) => d.id === "damage_legacy_1"));

  // 重启后状态机从持久化状态继续：open 异常需要“连续两次正常”才关闭
  const n1 = await api(base, "POST", `/locations/${locationId}/readings`, {
    ts: "2026-09-11T05:00:00Z",
    temperature: 20
  });
  assert.equal(n1.body.anomalyEvent, null);
  assert.equal(n1.body.anomalyPeriod.status, "open");
  const n2 = await api(base, "POST", `/locations/${locationId}/readings`, {
    ts: "2026-09-11T06:00:00Z",
    temperature: 20
  });
  assert.equal(n2.body.anomalyEvent, "closed");
  assert.equal(n2.body.anomalyPeriod.endAt, "2026-09-11T06:00:00.000Z");

  // 重启后旧的拒绝规则仍然生效
  const dup = await api(base, "POST", `/locations/${locationId}/readings`, {
    ts: "2026-09-11T06:00:00Z",
    temperature: 20
  });
  assert.equal(dup.status, 409);
});

after(async () => {
  for (const child of children) await stopServerProcess(child);
  await fs.rm(DB_FILE, { force: true });
});
