# 接口文档 · 古籍拓片缺损修补与保存环境巡护 API

零依赖 Node HTTP 服务，数据持久化在 `data/db.json`（可用环境变量 `DB_FILE` 覆盖路径）。
所有接口返回 JSON：成功为 `{"data": ...}`，错误为 `{"error": "..."}`，列表接口统一形如 `{"data": [...]}`。

- 启动：`PORT=3020 node server.js`
- 健康检查：`GET /health`（返回全部路由）
- 时间字段：ISO 8601 字符串（建议带时区，如 `2026-09-10T23:00:00Z`），也接受正整数毫秒时间戳；读数时间戳按位置**严格递增**

## 目录

- [一、原有接口（行为不变）](#一原有接口行为不变)
  - [1. 拓片登记](#1-拓片登记)
  - [2. 缺损项](#2-缺损项)
  - [3. 修补批次](#3-修补批次)
- [二、保存环境巡护（新增）](#二保存环境巡护新增)
  - [4. 保存位置与阈值](#4-保存位置与阈值)
  - [5. 保存时段](#5-保存时段)
  - [6. 传感器读数与异常状态机](#6-传感器读数与异常状态机)
  - [7. 查询接口](#7-查询接口)
- [三、错误码](#三错误码)

---

## 一、原有接口（行为不变）

### 1. 拓片登记

#### `GET /rubbings`
列出全部拓片，附带 `damageCount`、`pendingDamages`。

#### `POST /rubbings`
| 字段 | 必填 | 说明 |
|---|---|---|
| code | 是 | 拓片编号，如 `TP-清-014` |
| source | 是 | 来源 |
| paperSize | 是 | 纸张尺寸 |
| note | 否 | 备注 |

### 2. 缺损项

#### `GET /rubbings/:id/damages`
某拓片的全部缺损项；拓片不存在返回 404。

#### `POST /rubbings/:id/damages`
| 字段 | 必填 | 说明 |
|---|---|---|
| position | 是 | 缺损位置 |
| type | 是 | 类型，如 虫蛀孔/撕裂 |
| beforePhotoUrl | 是 | 修补前照片 |

新建缺损项状态为 `pending`。

#### `GET /damages?status=&type=`
按状态（`pending`/`in_repair`/`repaired`）与类型筛选。

#### `PATCH /damages/:id`
可更新 `position/type/beforePhotoUrl/afterPhotoUrl/status/repairNote`；
当 `status` 变为 `repaired` 时自动写入 `repairedAt`。

### 3. 修补批次

#### `GET /batches`
批次列表，每个批次附带 `damages/total/repaired/pending`。

#### `POST /batches`
| 字段 | 必填 | 说明 |
|---|---|---|
| name | 是 | 批次名称 |
| damageIds | 是 | 非空缺损项 ID 数组；任一不存在返回 400 |
| note | 否 | 备注 |

创建后批次为 `open`，相关缺损项置为 `in_repair` 并记录 `batchId`。

#### `GET /batches/:id`
批次详情（不存在返回 404）。

#### `POST /batches/:id/complete`
批次完成，关联缺损项全部置为 `repaired` 并写入修补后信息。

请求体可选：
```json
{
  "note": "批次备注",
  "defaultAfterPhotoUrl": "https://.../after.jpg",
  "defaultRepairNote": "默认修补说明",
  "results": [
    { "damageId": "damage_xxx", "afterPhotoUrl": "https://...", "repairNote": "..." }
  ]
}
```

---

## 二、保存环境巡护（新增）

### 4. 保存位置与阈值

保存位置登记名称、编码以及温度/湿度/光照阈值。未显式配置的指标使用默认值：

| 指标 | 字段 | 默认阈值 | 物理量程（越量程读数拒绝） |
|---|---|---|---|
| 温度 | `temperature` | 15 ~ 22 °C | -50 ~ 100 °C |
| 湿度 | `humidity` | 45 ~ 60 %RH | 0 ~ 100 %RH |
| 光照 | `lux` | 0 ~ 50 lx | 0 ~ 200000 lx |

#### `GET /locations`
列出全部保存位置。

#### `POST /locations`
| 字段 | 必填 | 说明 |
|---|---|---|
| name | 是 | 位置名称，库内唯一 |
| code | 否 | 位置编码，库内唯一 |
| thresholds | 否 | 阈值对象，可只给部分指标；每个指标形如 `{"min":15,"max":22}`，要求 min≤max 且在物理量程内 |
| note | 否 | 备注 |

```bash
curl -X POST http://127.0.0.1:3020/locations \
  -H 'Content-Type: application/json' \
  -d '{"name":"善本库A柜","code":"LOC-A","thresholds":{"temperature":{"min":15,"max":22}}}'
```

#### `GET /locations/:id`
位置详情（不存在 404）。

#### `PATCH /locations/:id`
可更新 `name/code/note/thresholds`。阈值校验规则同创建。
**修改阈值只影响之后的读数判定，不回溯改变历史读数的 `breached` 与已生成的异常时段。**

### 5. 保存时段

登记某拓片在某保存位置的存放时段 `[startAt, endAt)`（半开区间；首尾相接不算重叠）。
**同一拓片的保存时段不得重叠**，违反返回 409；`endAt` 省略表示当前仍在该位置（开放时段）。

#### `POST /rubbings/:id/storage-periods`
| 字段 | 必填 | 说明 |
|---|---|---|
| locationId | 是 | 保存位置，必须存在 |
| startAt | 是 | 开始时间 |
| endAt | 否 | 结束时间；缺省为开放时段；必须晚于 startAt |
| note | 否 | 备注 |

```bash
curl -X POST http://127.0.0.1:3020/rubbings/rubbing_demo/storage-periods \
  -H 'Content-Type: application/json' \
  -d '{"locationId":"location_xxx","startAt":"2026-09-10T08:00:00Z"}'
```

#### `POST /storage-periods/:id/close`
结束开放时段。请求体可带 `endAt`（缺省为当前时间）。已结束的时段重复关闭返回 409；
若结束时间会与该拓片其它时段重叠返回 409。

#### `GET /storage-periods?rubbingId=&locationId=&active=`
- `rubbingId`：按拓片筛选
- `locationId`：按位置筛选
- `active=true`：仅开放时段；`active=false`：仅已结束时段
- 返回项附带 `locationName`、`rubbingCode`，按开始时间升序

另有 `GET /rubbings/:id/storage-periods`，等价于按拓片筛选。

### 6. 传感器读数与异常状态机

#### `POST /locations/:id/readings`
向某位置上报一条传感器读数。

| 字段 | 必填 | 说明 |
|---|---|---|
| ts | 是 | 读数时间（ISO 8601 或毫秒时间戳） |
| temperature | 否 | 温度 °C |
| humidity | 否 | 湿度 %RH |
| lux | 否 | 光照 lx |
| sensorId | 否 | 传感器编号 |

`temperature/humidity/lux` 至少提供一项。

**拒绝规则（读数不入库）：**
- **越量程**：任一指标超出该指标物理量程 → 400
- **重复**：同一位置已有相同 `ts` 的读数 → 409
- **倒序**：新读数 `ts` 早于该位置已有读数的最新时间 → 409
- 时间格式非法、非数字、无任何指标 → 400

入库时按位置当前阈值判定，读数保存 `breached`（是否越限）与 `breachMetric`（首个越限指标），
**越限判定固化在读数上**，事后改阈值不影响历史。

响应：

```json
{
  "data": { "id": "reading_...", "locationId": "location_...", "ts": "...", "temperature": 31, "breached": true, "breachMetric": "temperature" },
  "anomalyEvent": "opened",
  "anomalyPeriod": { "id": "anomaly_...", "status": "open", "startAt": "...", "endAt": null }
}
```

`anomalyEvent` 取值：`"opened"`（本次读数触发异常开启）、`"closed"`（本次读数触发关闭）、`null`（状态未变）。

#### 异常状态机规则（按位置、按读数时间顺序）

1. **连续两次越限 → 开启异常时段**。异常时段 `startAt` 取第一次越限读数的时间。
   仅一次越限（孤立尖峰）不开启。
2. **异常期间**：继续越限只累计（`breachCount/breachMetrics/breachReadings/lastBreachAt`），不改变开闭状态。
3. **连续两次正常 → 关闭异常时段**，`endAt` 取第二次正常读数的时间：
   - 异常中第一次正常：记录 `firstNormalAfterAt`，异常仍保持 `open`；
   - 若两次正常之间又出现越限，**首次正常计数作废、重新开始**；
   - 第二次连续正常到达时才 `closed`。
4. **孤立尖峰不改变异常状态**：关闭态的单次越限不开异常（要连续两次）；开启态下仅出现一次正常也不关闭。

状态完全由已入库读数按时间顺序决定，服务重启后从持久化数据继续运行，结果一致（确定性）。

### 7. 查询接口

#### `GET /readings`
| 参数 | 说明 |
|---|---|
| rubbingId | 查该拓片保存时段覆盖过的所有位置的读数 |
| locationId | 限定位置；与 rubbingId 同时给出时，该位置须属于该拓片，否则为空 |
| breached | `true` 仅越限读数，`false` 仅正常读数 |
| from / to | 时间范围（含端点，ISO 8601 或毫秒） |
| limit | 返回时间升序的最后 N 条（如最近 100 条） |

#### `GET /anomalies?rubbingId=&locationId=&status=`
查询异常时段。
- `rubbingId` / `locationId`：语义同读数查询
- `status`：`open`（进行中）或 `closed`（已关闭）
- 按 `startAt` 降序，返回项附带 `locationName`

异常时段字段：

| 字段 | 说明 |
|---|---|
| status | `open` / `closed` |
| startAt / endAt | 异常起止（第一次越限 / 第二次连续正常） |
| firstNormalAfterAt | 异常期间第一次正常读数时间（关闭确认中），未出现为 null |
| breachCount | 异常期间越限读数条数 |
| breachMetrics | 越限指标去重列表 |
| breachReadings | 越限读数 ID 列表 |
| lastBreachAt | 最近一次越限时间 |

---

## 三、错误码

| 状态码 | 场景 |
|---|---|
| 400 | JSON 非法、缺字段、阈值/时间/读数格式非法、越量程、endAt≤startAt、批次 damageIds 非法等 |
| 404 | 拓片/缺损项/批次/保存位置/保存时段不存在 |
| 409 | 保存时段重叠、读数重复或倒序、位置名称/编码冲突、重复关闭时段 |
| 500 | 服务器内部错误 |

并发写入说明：服务对读—改—写流程串行化（单进程互斥）并以临时文件 rename 原子落盘，
因此并发提交重叠保存时段时只有一个成功，并发上报读数不会互相覆盖或产生重复时间戳。
