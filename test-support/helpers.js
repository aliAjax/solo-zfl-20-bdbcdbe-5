// 测试公共辅助：每个测试文件使用独立的临时 DB 文件（node --test 按文件起独立进程）
const os = require("os");
const path = require("path");
const fs = require("fs/promises");

const TMP_DB = path.join(
  os.tmpdir(),
  `rubbing-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`
);
process.env.DB_FILE = TMP_DB;

const { createServer } = require("../server");
const db = require("../lib/db");

let server;
let baseUrl;

async function startServer() {
  await resetDb();
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  return baseUrl;
}

async function stopServer() {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = null;
  await fs.rm(TMP_DB, { force: true });
}

async function resetDb() {
  await db.atomicWrite(db.initialData);
}

async function request(method, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

const get = (p) => request("GET", p);
const post = (p, body) => request("POST", p, body ?? {});
const patch = (p, body) => request("PATCH", p, body ?? {});

async function createLocation(overrides = {}) {
  const res = await post("/locations", { name: `库_${Math.random().toString(36).slice(2, 7)}`, ...overrides });
  if (res.status !== 201) throw new Error(`createLocation failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

async function createRubbing(overrides = {}) {
  const res = await post("/rubbings", {
    code: `TP-T-${Math.random().toString(36).slice(2, 7)}`,
    source: "测试来源",
    paperSize: "30x40cm",
    ...overrides
  });
  if (res.status !== 201) throw new Error(`createRubbing failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

async function addReading(locationId, ts, values = { temperature: 20 }) {
  return post(`/locations/${locationId}/readings`, { ts, ...values });
}

module.exports = {
  TMP_DB,
  startServer,
  stopServer,
  resetDb,
  request,
  get,
  post,
  patch,
  createLocation,
  createRubbing,
  addReading
};
