# 古籍拓片缺损修补与保存环境巡护 API

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化拓片、缺损项、修补批次，
以及保存位置/阈值、保存时段、传感器读数和异常时段。

## 启动

```bash
PORT=3020 node server.js
# 也可指定数据文件路径，便于测试
DB_FILE=/tmp/db.json PORT=3020 node server.js
```

## 测试

```bash
node --test
```

## 主要接口

原有（拓片登记 / 缺损项 / 修补批次，行为不变）：

- `GET /health`
- `GET /rubbings` · `POST /rubbings`
- `GET /rubbings/:id/damages` · `POST /rubbings/:id/damages`
- `GET /damages?status=&type=` · `PATCH /damages/:id`
- `GET /batches` · `POST /batches` · `GET /batches/:id` · `POST /batches/:id/complete`

新增（保存环境巡护）：

- `GET/POST /locations` · `GET/PATCH /locations/:id`（位置与温湿度/光照阈值）
- `GET /storage-periods?rubbingId=&locationId=&active=`
- `POST /rubbings/:id/storage-periods` · `POST /storage-periods/:id/close`
- `POST /locations/:id/readings`（上报读数；重复/倒序/越量程拒绝）
- `GET /readings?rubbingId=&locationId=&breached=&from=&to=&limit=`
- `GET /anomalies?rubbingId=&locationId=&status=`

规则要点：

- 同一拓片保存时段不得重叠（半开区间，首尾相接允许）；并发写入串行化，重叠时段仅一成。
- 连续两次越限开启异常时段，连续两次正常才关闭（中间再越限则重新计数），孤立尖峰不改变异常状态。
- 所有判定按读数入库时的阈值固化，服务重启后结果一致。

完整字段、错误码与状态机说明见 [API.md](./API.md)。

## 闭环示例

```bash
# 登记带阈值的保存位置
curl -X POST http://127.0.0.1:3020/locations \
  -H 'Content-Type: application/json' \
  -d '{"name":"善本库A柜","thresholds":{"temperature":{"min":15,"max":22}}}'

# 拓片入库该位置（开放时段）
curl -X POST http://127.0.0.1:3020/rubbings/rubbing_demo/storage-periods \
  -H 'Content-Type: application/json' \
  -d '{"locationId":"<locationId>","startAt":"2026-09-10T08:00:00Z"}'

# 上报读数（连续两次越限将返回 anomalyEvent=opened）
curl -X POST http://127.0.0.1:3020/locations/<locationId>/readings \
  -H 'Content-Type: application/json' \
  -d '{"ts":"2026-09-10T23:00:00Z","temperature":29,"humidity":55}'

# 修补批次（原流程）
curl http://127.0.0.1:3020/damages?status=pending
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'
```
