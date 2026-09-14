// 保存环境巡护领域逻辑：位置/阈值、保存时段、传感器读数、异常时段状态机
// 本模块只操作传入的 db 快照（纯函数风格），持久化与并发由 lib/db.js 负责。

const METRICS = {
  temperature: {
    label: "温度",
    unit: "°C",
    physicalMin: -50,
    physicalMax: 100,
    defaultMin: 15,
    defaultMax: 22
  },
  humidity: {
    label: "湿度",
    unit: "%RH",
    physicalMin: 0,
    physicalMax: 100,
    defaultMin: 45,
    defaultMax: 60
  },
  lux: {
    label: "光照",
    unit: "lx",
    physicalMin: 0,
    physicalMax: 200000,
    defaultMin: 0,
    defaultMax: 50
  }
};
const METRIC_KEYS = Object.keys(METRICS);

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (message) => new ApiError(400, message);
const conflict = (message) => new ApiError(409, message);
const notFound = (message) => new ApiError(404, message);

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// 接受 ISO 8601 日期/日期时间字符串或毫秒时间戳。
// 关键：不存在的公历日期（如 2026-02-31、13 月、非闰年 02-29、25:00:00）一律拒绝，
// 绝不依赖 Date.parse 的静默进位（那会把 02-31 滚到 03-03）。
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?$/;

function daysInMonth(year, month) {
  // month 为 1..12；Date.UTC(y, month, 0) 返回该月天数
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validateCalendar(year, month, day, hour, minute, second) {
  if (month < 1 || month > 12) throw badRequest(`公历月份超出范围：${month}月（输入日期不存在，禁止滚动）`);
  if (day < 1 || day > daysInMonth(year, month)) {
    throw badRequest(`公历日期不存在：${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}（禁止滚动到相邻月/日）`);
  }
  if (hour !== undefined && (hour < 0 || hour > 23)) throw badRequest(`小时超出范围：${hour}`);
  if (minute !== undefined && (minute < 0 || minute > 59)) throw badRequest(`分钟超出范围：${minute}`);
  if (second !== undefined && (second < 0 || second > 59)) throw badRequest(`秒超出范围：${second}`);
}

function parseTs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw badRequest("时间戳必须是正整数毫秒");
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const text = value.trim();

    const dateOnly = text.match(DATE_ONLY_RE);
    if (dateOnly) {
      const [, y, mo, d] = dateOnly.map(Number);
      validateCalendar(y, mo, d);
      return Date.UTC(y, mo - 1, d);
    }

    const dt = text.match(DATE_TIME_RE);
    if (dt) {
      const [, y, mo, d, h, mi, s, frac, zone] = dt;
      const year = Number(y);
      const month = Number(mo);
      const day = Number(d);
      const hour = Number(h);
      const minute = Number(mi);
      const second = s === undefined ? undefined : Number(s);
      validateCalendar(year, month, day, hour, minute, second);
      const msPart = frac === undefined ? 0 : Number(frac.padEnd(3, "0").slice(0, 3));
      let ms = Date.UTC(year, month - 1, day, hour, minute, second || 0, msPart);
      // 无时区后缀按 UTC 处理；有偏移时换算回 UTC 毫秒
      if (zone && zone !== "Z") {
        const sign = zone[0] === "+" ? 1 : -1;
        const zh = Number(zone.slice(1, 3));
        const zm = Number(zone.slice(4, 6));
        if (zh > 23 || zm > 59) throw badRequest(`时区偏移超出范围：${zone}`);
        ms -= sign * ((zh * 60 + zm) * 60 * 1000);
      }
      return ms;
    }
  }
  throw badRequest("时间格式非法，需要 ISO 8601 字符串（如 2026-09-10T23:00:00Z）或毫秒时间戳");
}

const toIso = (ms) => new Date(ms).toISOString();

function defaultThresholds() {
  const t = {};
  for (const key of METRIC_KEYS) t[key] = { min: METRICS[key].defaultMin, max: METRICS[key].defaultMax };
  return t;
}

// 校验一组阈值（可部分提交）；物理量程内、min<=max
function validateThresholds(input, { partial = false } = {}) {
  const source = input && typeof input === "object" ? input : {};
  const present = METRIC_KEYS.filter((key) => source[key] !== undefined);
  if (!partial && present.length === 0) {
    throw badRequest(`至少需要配置一项阈值：${METRIC_KEYS.join(", ")}`);
  }
  const result = {};
  for (const key of present) {
    const spec = METRICS[key];
    const entry = source[key];
    if (!entry || typeof entry !== "object") throw badRequest(`${spec.label}阈值必须是对象 {min,max}`);
    const { min, max } = entry;
    if (!isFiniteNumber(min) || !isFiniteNumber(max)) throw badRequest(`${spec.label}阈值min/max必须是数字`);
    if (min < spec.physicalMin || max > spec.physicalMax) {
      throw badRequest(`${spec.label}阈值不得超出物理量程 ${spec.physicalMin}~${spec.physicalMax}${spec.unit}`);
    }
    if (min > max) throw badRequest(`${spec.label}阈值min不能大于max`);
    result[key] = { min, max };
  }
  return result;
}

function findLocation(db, locationId) {
  const location = db.locations.find((item) => item.id === locationId);
  if (!location) throw notFound("保存位置不存在");
  return location;
}

function findRubbingOrThrow(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) throw notFound("拓片不存在");
  return rubbing;
}

// ---- 保存位置 -------------------------------------------------------------

function createLocation(db, body, makeId) {
  if (!body || !body.name || typeof body.name !== "string") throw badRequest("缺少字段：name");
  if (db.locations.some((item) => item.name === body.name)) {
    throw conflict(`保存位置名称已存在：${body.name}`);
  }
  if (body.code && db.locations.some((item) => item.code === body.code)) {
    throw conflict(`保存位置编码已存在：${body.code}`);
  }
  const thresholds = { ...defaultThresholds(), ...validateThresholds(body.thresholds, { partial: true }) };
  const location = {
    id: makeId("location"),
    name: body.name,
    code: body.code || "",
    thresholds,
    note: body.note || "",
    createdAt: toIso(Date.now())
  };
  db.locations.push(location);
  return location;
}

function updateLocation(db, locationId, body) {
  const location = findLocation(db, locationId);
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) throw badRequest("name不能为空");
    if (db.locations.some((item) => item.id !== location.id && item.name === body.name)) {
      throw conflict(`保存位置名称已存在：${body.name}`);
    }
    location.name = body.name;
  }
  if (body.code !== undefined) {
    if (db.locations.some((item) => item.id !== location.id && item.code === body.code)) {
      throw conflict(`保存位置编码已存在：${body.code}`);
    }
    location.code = body.code || "";
  }
  if (body.thresholds !== undefined) {
    // 新阈值只影响后续读数，不回溯修改历史判定
    Object.assign(location.thresholds, validateThresholds(body.thresholds, { partial: true }));
  }
  if (body.note !== undefined) location.note = body.note;
  return location;
}

// ---- 保存时段 -------------------------------------------------------------

// 半开区间 [start, end)：首尾相接（a.end == b.start）不算重叠
function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function createStoragePeriod(db, body, makeId) {
  if (!body || typeof body !== "object") throw badRequest("请求体必须是对象");
  if (!body.rubbingId || !body.locationId) throw badRequest("缺少字段：rubbingId, locationId");
  findRubbingOrThrow(db, body.rubbingId);
  findLocation(db, body.locationId);
  const startMs = parseTs(body.startAt);
  const endMs = body.endAt === undefined || body.endAt === null ? null : parseTs(body.endAt);
  if (endMs !== null && endMs <= startMs) throw badRequest("endAt必须晚于startAt");

  const periods = db.storagePeriods.filter((item) => item.rubbingId === body.rubbingId);
  for (const period of periods) {
    const pStart = parseTs(period.startAt);
    const pEnd = period.endAt === null ? Infinity : parseTs(period.endAt);
    const nextEnd = endMs === null ? Infinity : endMs;
    if (intervalsOverlap(startMs, nextEnd, pStart, pEnd)) {
      throw conflict(`与该拓片已有时段 ${period.id} 重叠（同一拓片保存时段不得重叠）`);
    }
  }

  const storagePeriod = {
    id: makeId("period"),
    rubbingId: body.rubbingId,
    locationId: body.locationId,
    startAt: toIso(startMs),
    endAt: endMs === null ? null : toIso(endMs),
    note: body.note || "",
    createdAt: toIso(Date.now())
  };
  db.storagePeriods.push(storagePeriod);
  return storagePeriod;
}

function closeStoragePeriod(db, periodId, body) {
  const period = db.storagePeriods.find((item) => item.id === periodId);
  if (!period) throw notFound("保存时段不存在");
  if (period.endAt !== null) throw conflict("保存时段已结束，不能重复关闭");
  const endMs = body && body.endAt !== undefined ? parseTs(body.endAt) : Date.now();
  const startMs = parseTs(period.startAt);
  if (endMs <= startMs) throw badRequest("结束时间必须晚于开始时间");
  const sameRubbing = db.storagePeriods.filter(
    (item) => item.rubbingId === period.rubbingId && item.id !== period.id
  );
  for (const other of sameRubbing) {
    const oStart = parseTs(other.startAt);
    const oEnd = other.endAt === null ? Infinity : parseTs(other.endAt);
    if (intervalsOverlap(startMs, endMs, oStart, oEnd)) {
      throw conflict(`结束时间会与时段 ${other.id} 重叠`);
    }
  }
  period.endAt = toIso(endMs);
  return period;
}

function listStoragePeriods(db, { rubbingId, locationId, active } = {}) {
  return db.storagePeriods
    .filter((item) => (!rubbingId || item.rubbingId === rubbingId))
    .filter((item) => (!locationId || item.locationId === locationId))
    .filter((item) => (active == null || (active === "true") === (item.endAt === null)))
    .sort((a, b) => parseTs(a.startAt) - parseTs(b.startAt));
}

// ---- 传感器读数与异常状态机 -----------------------------------------------

function evaluateReading(reading, thresholds) {
  for (const metric of METRIC_KEYS) {
    const value = reading[metric];
    if (value === undefined || value === null) continue;
    const limit = thresholds[metric];
    if (!limit) continue;
    if (value < limit.min || value > limit.max) {
      return { breached: true, breachMetric: metric };
    }
  }
  return { breached: false, breachMetric: null };
}

// 追加一条读数。重复、倒序、越量程一律拒绝（409/400）。
// 异常状态机：连续两次越限开启异常时段；连续两次正常关闭；孤立尖峰不改变状态。
function addReading(db, body, makeId) {
  if (!body || typeof body !== "object") throw badRequest("请求体必须是对象");
  if (!body.locationId) throw badRequest("缺少字段：locationId");
  const location = findLocation(db, body.locationId);
  const ts = parseTs(body.ts);

  const values = {};
  let provided = 0;
  for (const metric of METRIC_KEYS) {
    if (body[metric] === undefined || body[metric] === null) continue;
    provided += 1;
    const value = body[metric];
    if (!isFiniteNumber(value)) throw badRequest(`${METRICS[metric].label}读数必须是数字`);
    const spec = METRICS[metric];
    if (value < spec.physicalMin || value > spec.physicalMax) {
      throw badRequest(
        `${spec.label}读数越量程：${value}${spec.unit}，允许范围 ${spec.physicalMin}~${spec.physicalMax}${spec.unit}`
      );
    }
    values[metric] = value;
  }
  if (provided === 0) throw badRequest(`至少提供一项读数：${METRIC_KEYS.join(", ")}`);

  // 同位置同时间戳 = 重复
  if (db.readings.some((item) => item.locationId === location.id && parseTs(item.ts) === ts)) {
    throw conflict("重复读数：该位置在此时间点已有读数");
  }
  // 同位置时间戳必须严格递增 = 倒序拒绝
  const later = db.readings.some((item) => item.locationId === location.id && parseTs(item.ts) > ts);
  if (later) throw conflict("倒序读数：新读数时间戳早于该位置已有的最新读数");

  const { breached, breachMetric } = evaluateReading(values, location.thresholds);
  const reading = {
    id: makeId("reading"),
    locationId: location.id,
    ts: toIso(ts),
    ...values,
    breached,
    breachMetric,
    sensorId: body.sensorId || "",
    createdAt: toIso(Date.now())
  };
  db.readings.push(reading);

  const event = advanceAnomalyState(db, location, reading, ts, breached, breachMetric, makeId);
  return { reading, ...event };
}

// 以刚追加的读数驱动该位置的异常时段状态机
function advanceAnomalyState(db, location, reading, ts, breached, breachMetric, makeId) {
  const open = db.anomalyPeriods.find(
    (item) => item.locationId === location.id && item.status === "open"
  );

  if (breached) {
    if (open) {
      // 越限打断“连续两次正常”的关闭确认，重新计数
      open.firstNormalAfterAt = null;
      open.breachCount += 1;
      open.breachReadings.push(reading.id);
      open.lastBreachAt = reading.ts;
      if (breachMetric && !open.breachMetrics.includes(breachMetric)) open.breachMetrics.push(breachMetric);
      return { anomalyEvent: null, anomalyPeriod: open };
    }
    // 关闭状态：需要“连续两次”越限，孤立尖峰不开异常
    const seq = locationReadings(db, location.id);
    const prev = seq[seq.length - 2];
    if (prev && prev.breached) {
      const seq2 = locationAnomalies(db, location.id).length;
      const period = {
        id: makeId("anomaly"),
        locationId: location.id,
        seq: seq2 + 1,
        status: "open",
        startAt: prev.ts, // 异常时段从第一次越限读数开始
        endAt: null,
        firstNormalAfterAt: null,
        closeAfterSecondNormal: true,
        breachCount: 2,
        breachMetrics: [prev.breachMetric, breachMetric].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i),
        breachReadings: [prev.id, reading.id],
        firstBreachAt: prev.ts,
        lastBreachAt: reading.ts,
        createdAt: toIso(Date.now())
      };
      db.anomalyPeriods.push(period);
      return { anomalyEvent: "opened", anomalyPeriod: period };
    }
    return { anomalyEvent: null, anomalyPeriod: null };
  }

  // 正常读数
  if (!open) return { anomalyEvent: null, anomalyPeriod: null };
  if (open.firstNormalAfterAt === null) {
    // 异常中的第一次正常：仍保持异常，等待第二次确认
    open.firstNormalAfterAt = reading.ts;
    return { anomalyEvent: null, anomalyPeriod: open };
  }
  // 连续两次正常 -> 关闭，结束于第二次正常读数
  open.status = "closed";
  open.endAt = reading.ts;
  return { anomalyEvent: "closed", anomalyPeriod: open };
}

function locationReadings(db, locationId) {
  return db.readings
    .filter((item) => item.locationId === locationId)
    .map((item) => ({ ...item, _ts: parseTs(item.ts) }))
    .sort((a, b) => a._ts - b._ts);
}

function locationAnomalies(db, locationId) {
  return db.anomalyPeriods
    .filter((item) => item.locationId === locationId)
    .map((item) => ({ ...item, _start: parseTs(item.startAt) }))
    .sort((a, b) => a._start - b._start);
}

// 由某位置全部读数确定性重放异常时段（测试与“重启结果一致”自检使用）
// 注意：判定以读数入库时保存的 breached 为准，事后修改阈值不改变历史。
function rebuildLocationAnomalies(db, locationId) {
  const readings = locationReadings(db, locationId);
  const periods = [];
  let open = null;
  let prev = null;
  let seq = 0;

  for (const reading of readings) {
    if (reading.breached) {
      if (open) {
        // 越限打断“连续两次正常”的关闭确认，重新计数
        open.firstNormalAfterAt = null;
        open.breachCount += 1;
        open.breachReadings.push(reading.id);
        open.lastBreachAt = reading.ts;
        if (reading.breachMetric && !open.breachMetrics.includes(reading.breachMetric)) {
          open.breachMetrics.push(reading.breachMetric);
        }
      } else if (prev && prev.breached) {
        seq += 1;
        open = {
          id: `rebuild_${locationId}_${seq}`,
          locationId,
          seq,
          status: "open",
          startAt: prev.ts,
          endAt: null,
          firstNormalAfterAt: null,
          closeAfterSecondNormal: true,
          breachCount: 2,
          breachMetrics: [prev.breachMetric, reading.breachMetric]
            .filter(Boolean)
            .filter((v, i, arr) => arr.indexOf(v) === i),
          breachReadings: [prev.id, reading.id],
          firstBreachAt: prev.ts,
          lastBreachAt: reading.ts,
          createdAt: reading.ts
        };
        periods.push(open);
      }
    } else if (open) {
      if (open.firstNormalAfterAt === null) {
        open.firstNormalAfterAt = reading.ts;
      } else {
        open.status = "closed";
        open.endAt = reading.ts;
        open = null;
      }
    }
    prev = reading;
  }
  return periods;
}

// ---- 查询 -----------------------------------------------------------------

// 某时刻拓片所在位置集合（重叠的保存时段理论上不存在，集合通常为 0/1）
function rubbingLocationIdsAt(db, rubbingId, ms) {
  const ids = new Set();
  for (const period of db.storagePeriods) {
    if (period.rubbingId !== rubbingId) continue;
    const start = parseTs(period.startAt);
    const end = period.endAt === null ? Infinity : parseTs(period.endAt);
    if (start <= ms && ms < end) ids.add(period.locationId);
  }
  return ids;
}

// 某拓片的保存时段区间（半开 [start,end)，开放时段 end=Infinity），按位置预解析
function rubbingIntervals(db, rubbingId) {
  return db.storagePeriods
    .filter((period) => period.rubbingId === rubbingId)
    .map((period) => ({
      locationId: period.locationId,
      start: parseTs(period.startAt),
      end: period.endAt === null ? Infinity : parseTs(period.endAt)
    }));
}

function readingLocationIdsForRubbing(db, rubbingId) {
  return new Set(rubbingIntervals(db, rubbingId).map((interval) => interval.locationId));
}

// 读数事件时间是否落在该拓片某段保存时段内（含 startAt、不含 endAt）
function isWithinRubbingStorage(intervals, locationId, ms) {
  return intervals.some(
    (interval) => interval.locationId === locationId && interval.start <= ms && ms < interval.end
  );
}

// 异常时段与该拓片某段保存时段是否有交集；
// 开放异常以“起点之后”为界，仍在开放保存时段中则命中
function anomalyTouchesStorage(intervals, anomaly) {
  const aStart = parseTs(anomaly.startAt);
  const aEnd = anomaly.endAt === null ? Infinity : parseTs(anomaly.endAt);
  return intervals.some((interval) => {
    if (interval.locationId !== anomaly.locationId) return false;
    return aStart < interval.end && interval.start <= aEnd;
  });
}

function listReadings(db, query = {}) {
  const { rubbingId, locationId, breached, from, to, limit } = query;
  let intervals = null;
  let locationIds = null;
  if (rubbingId) {
    intervals = rubbingIntervals(db, rubbingId);
    if (locationId) {
      // 显式位置必须与拓片保存时段有关，否则直接为空
      if (!intervals.some((interval) => interval.locationId === locationId)) return [];
      locationIds = new Set([locationId]);
    } else {
      locationIds = new Set(intervals.map((interval) => interval.locationId));
    }
  } else if (locationId) {
    locationIds = new Set([locationId]);
  }
  const fromMs = from === undefined || from === null ? null : parseTs(from);
  const toMs = to === undefined || to === null ? null : parseTs(to);
  let rows = db.readings
    .filter((item) => !locationIds || locationIds.has(item.locationId))
    // 按拓片查询时：只保留事件时间落在对应保存时段（同位置）内的读数
    .filter((item) => !intervals || isWithinRubbingStorage(intervals, item.locationId, parseTs(item.ts)))
    .filter((item) => {
      const ms = parseTs(item.ts);
      if (fromMs !== null && ms < fromMs) return false;
      if (toMs !== null && ms > toMs) return false;
      return true;
    })
    .filter((item) => (breached == null ? true : String(item.breached) === String(breached)))
    .sort((a, b) => parseTs(a.ts) - parseTs(b.ts));
  if (limit !== undefined && limit !== null) {
    const n = Math.max(0, Number(limit) || 0);
    rows = rows.slice(-n);
  }
  return rows;
}

function enrichAnomaly(db, period) {
  const location = db.locations.find((item) => item.id === period.locationId);
  return {
    ...period,
    locationName: location ? location.name : null
  };
}

function listAnomalies(db, query = {}) {
  const { rubbingId, locationId, status } = query;
  let intervals = null;
  let locationIds = null;
  if (rubbingId) {
    intervals = rubbingIntervals(db, rubbingId);
    if (locationId) {
      if (!intervals.some((interval) => interval.locationId === locationId)) return [];
      locationIds = new Set([locationId]);
    } else {
      locationIds = new Set(intervals.map((interval) => interval.locationId));
    }
  } else if (locationId) {
    locationIds = new Set([locationId]);
  }
  return db.anomalyPeriods
    .filter((item) => !locationIds || locationIds.has(item.locationId))
    // 按拓片查询时：异常时段必须与该拓片某段保存时段（同位置）有交集
    .filter((item) => !intervals || anomalyTouchesStorage(intervals, item))
    .filter((item) => (!status || item.status === status))
    .sort((a, b) => parseTs(b.startAt) - parseTs(a.startAt))
    .map((period) => enrichAnomaly(db, period));
}

function enrichStoragePeriod(db, period) {
  const location = db.locations.find((item) => item.id === period.locationId);
  const rubbing = db.rubbings.find((item) => item.id === period.rubbingId);
  return {
    ...period,
    locationName: location ? location.name : null,
    rubbingCode: rubbing ? rubbing.code : null
  };
}

module.exports = {
  METRICS,
  METRIC_KEYS,
  ApiError,
  badRequest,
  conflict,
  notFound,
  isFiniteNumber,
  parseTs,
  toIso,
  defaultThresholds,
  validateThresholds,
  findLocation,
  findRubbingOrThrow,
  intervalsOverlap,
  createLocation,
  updateLocation,
  createStoragePeriod,
  closeStoragePeriod,
  listStoragePeriods,
  evaluateReading,
  addReading,
  rebuildLocationAnomalies,
  rubbingLocationIdsAt,
  readingLocationIdsForRubbing,
  listReadings,
  listAnomalies,
  enrichAnomaly,
  enrichStoragePeriod
};
