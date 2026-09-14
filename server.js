const http = require("http");
const { readDb, mutate, makeId } = require("./lib/db");
const storage = require("./lib/storage");

const PORT = Number(process.env.PORT || 3020);

const routes = [
  // 原有接口（拓片登记 / 缺损项 / 修补批次）
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete",
  // 保存环境巡护
  "GET /locations",
  "POST /locations",
  "GET /locations/:id",
  "PATCH /locations/:id",
  "GET /storage-periods?rubbingId=&locationId=&active=",
  "POST /rubbings/:id/storage-periods",
  "POST /storage-periods/:id/close",
  "POST /locations/:id/readings",
  "GET /readings?rubbingId=&locationId=&breached=&from=&to=&limit=",
  "GET /anomalies?rubbingId=&locationId=&status="
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) {
    const error = new Error("拓片不存在");
    error.status = 404;
    throw error;
  }
  return rubbing;
}

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  return {
    ...batch,
    damages,
    total: damages.length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    pending: damages.filter((item) => item.status !== "repaired").length
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const q = (name) => url.searchParams.get(name);

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  // ---- 拓片登记（原有接口，行为不变）-------------------------------------

  if (req.method === "GET" && pathname === "/rubbings") {
    const db = await readDb();
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== "repaired").length
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = await mutate((db) => {
      const item = {
        id: makeId("rubbing"),
        code: body.code,
        source: body.source,
        paperSize: body.paperSize,
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      db.rubbings.push(item);
      return item;
    });
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    const db = await readDb();
    findRubbing(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const damage = await mutate((db) => {
      findRubbing(db, rubbingId);
      const item = {
        id: makeId("damage"),
        rubbingId,
        position: body.position,
        type: body.type,
        beforePhotoUrl: body.beforePhotoUrl,
        afterPhotoUrl: "",
        status: "pending",
        repairNote: "",
        batchId: null,
        createdAt: new Date().toISOString(),
        repairedAt: null
      };
      db.damages.push(item);
      return item;
    });
    return send(res, 201, { data: damage });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = q("status");
    const type = q("type");
    const db = await readDb();
    const data = db.damages.filter((item) => (!status || item.status === status) && (!type || item.type === type));
    return send(res, 200, { data });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const body = await parseBody(req);
    const result = await mutate((db) => {
      const damage = db.damages.find((item) => item.id === damagePatchMatch[1]);
      if (!damage) return { status: 404, error: "缺损项不存在" };
      Object.assign(damage, {
        position: body.position ?? damage.position,
        type: body.type ?? damage.type,
        beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
        afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
        status: body.status ?? damage.status,
        repairNote: body.repairNote ?? damage.repairNote
      });
      damage.repairedAt = damage.status === "repaired" ? new Date().toISOString() : damage.repairedAt;
      return { status: 200, data: damage };
    });
    return send(res, result.status, result.error ? result : { data: result.data });
  }

  // ---- 修补批次（原有接口，行为不变）-------------------------------------

  if (req.method === "GET" && pathname === "/batches") {
    const db = await readDb();
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) {
      return send(res, 400, { error: "damageIds必须是非空数组" });
    }
    const result = await mutate((db) => {
      const invalid = body.damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
      if (invalid.length) return { status: 400, error: `缺损项不存在：${invalid.join(", ")}` };
      const batch = {
        id: makeId("batch"),
        name: body.name,
        status: "open",
        damageIds: body.damageIds,
        note: body.note || "",
        createdAt: new Date().toISOString(),
        completedAt: null
      };
      db.batches.push(batch);
      db.damages.forEach((damage) => {
        if (body.damageIds.includes(damage.id)) {
          damage.batchId = batch.id;
          damage.status = "in_repair";
        }
      });
      return { status: 201, data: enrichBatch(db, batch) };
    });
    return send(res, result.status, result.error ? result : { data: result.data });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const db = await readDb();
    const batch = db.batches.find((item) => item.id === batchMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const body = await parseBody(req);
    const results = Array.isArray(body.results) ? body.results : [];
    const result = await mutate((db) => {
      const batch = db.batches.find((item) => item.id === completeMatch[1]);
      if (!batch) return { status: 404, error: "修补批次不存在" };
      batch.status = "completed";
      batch.completedAt = new Date().toISOString();
      batch.note = body.note ?? batch.note;
      db.damages.forEach((damage) => {
        if (!batch.damageIds.includes(damage.id)) return;
        const item = results.find((entry) => entry.damageId === damage.id) || {};
        damage.status = "repaired";
        damage.afterPhotoUrl = item.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
        damage.repairNote = item.repairNote || body.defaultRepairNote || damage.repairNote;
        damage.repairedAt = new Date().toISOString();
      });
      return { status: 200, data: enrichBatch(db, batch) };
    });
    return send(res, result.status, result.error ? result : { data: result.data });
  }

  // ---- 保存位置与温湿度/光照阈值 -----------------------------------------

  if (req.method === "GET" && pathname === "/locations") {
    const db = await readDb();
    return send(res, 200, { data: db.locations });
  }

  if (req.method === "POST" && pathname === "/locations") {
    const body = await parseBody(req);
    const location = await mutate((db) => storage.createLocation(db, body, makeId));
    return send(res, 201, { data: location });
  }

  const locationMatch = pathname.match(/^\/locations\/([^/]+)$/);
  if (locationMatch && req.method === "GET") {
    const db = await readDb();
    const location = storage.findLocation(db, locationMatch[1]);
    return send(res, 200, { data: location });
  }

  if (locationMatch && req.method === "PATCH") {
    const body = await parseBody(req);
    const location = await mutate((db) => storage.updateLocation(db, locationMatch[1], body));
    return send(res, 200, { data: location });
  }

  // ---- 保存时段 ----------------------------------------------------------

  if (req.method === "GET" && pathname === "/storage-periods") {
    const db = await readDb();
    const data = storage
      .listStoragePeriods(db, {
        rubbingId: q("rubbingId"),
        locationId: q("locationId"),
        active: q("active")
      })
      .map((period) => storage.enrichStoragePeriod(db, period));
    return send(res, 200, { data });
  }

  const rubbingPeriodsMatch = pathname.match(/^\/rubbings\/([^/]+)\/storage-periods$/);
  if (rubbingPeriodsMatch && req.method === "GET") {
    const rubbingId = rubbingPeriodsMatch[1];
    const db = await readDb();
    findRubbing(db, rubbingId);
    const data = storage
      .listStoragePeriods(db, { rubbingId })
      .map((period) => storage.enrichStoragePeriod(db, period));
    return send(res, 200, { data });
  }

  if (rubbingPeriodsMatch && req.method === "POST") {
    const rubbingId = rubbingPeriodsMatch[1];
    const body = await parseBody(req);
    const period = await mutate((db) =>
      storage.createStoragePeriod(db, { ...body, rubbingId }, makeId)
    );
    return send(res, 201, { data: period });
  }

  const periodCloseMatch = pathname.match(/^\/storage-periods\/([^/]+)\/close$/);
  if (periodCloseMatch && req.method === "POST") {
    const body = await parseBody(req);
    const period = await mutate((db) => storage.closeStoragePeriod(db, periodCloseMatch[1], body));
    return send(res, 200, { data: period });
  }

  // ---- 位置传感器读数 ----------------------------------------------------

  const readingsMatch = pathname.match(/^\/locations\/([^/]+)\/readings$/);
  if (readingsMatch && req.method === "POST") {
    const body = await parseBody(req);
    const result = await mutate((db) =>
      storage.addReading(db, { ...body, locationId: readingsMatch[1] }, makeId)
    );
    return send(res, 201, {
      data: result.reading,
      anomalyEvent: result.anomalyEvent,
      anomalyPeriod: result.anomalyPeriod
    });
  }

  if (req.method === "GET" && pathname === "/readings") {
    const db = await readDb();
    const data = storage.listReadings(db, {
      rubbingId: q("rubbingId"),
      locationId: q("locationId"),
      breached: q("breached"),
      from: q("from") ?? undefined,
      to: q("to") ?? undefined,
      limit: q("limit") ?? undefined
    });
    return send(res, 200, { data });
  }

  // ---- 异常时段查询 ------------------------------------------------------

  if (req.method === "GET" && pathname === "/anomalies") {
    const db = await readDb();
    const data = storage.listAnomalies(db, {
      rubbingId: q("rubbingId"),
      locationId: q("locationId"),
      status: q("status")
    });
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((error) =>
      send(res, error.status || 500, { error: error.message || "服务器错误" })
    );
  });
}

module.exports = { createServer, routes, handle };

if (require.main === module) {
  const instance = createServer().listen(PORT, () => {
    const address = instance.address();
    const actualPort = address && typeof address === "object" ? address.port : PORT;
    console.log(`Rubbing repair API running at http://127.0.0.1:${actualPort}`);
  });
}
