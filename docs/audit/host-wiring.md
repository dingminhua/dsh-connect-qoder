# 审计B：宿主侧装配与运行时对等性（task-2）

范围：src/index.ts, src/shim.ts, src/adapter.ts, src/messages.ts, src/pi-ai-runtime.ts, src/web-status.ts, src/status-paths.ts, src/bin.ts, src/native-modality.ts, src/off-thinking.ts, src/host-heartbeat.ts
方法：只读 grep/read，每条结论附文件:行证据。不含臆测；边界项标注。

---

## 1. provider 注册 —— 已核对对称
- adapter.ts:30 `QODER_PROVIDER='qoder'`，:33 `QODER_GLOBAL_PROVIDER='qoder-global'`；:36-39 `QODER_PROVIDERS = { cn: 'qoder', global: 'qoder-global' }`；:50-53 `QODER_PROVIDER_DISPLAY_NAMES = { cn:'Qoder', global:'Qoder Global' }`。两侧都有条。
- index.ts:1201-1202 在 `for (const region of QODER_REGIONS)` 内 `ctx.llm.registerAdapter([QODER_PROVIDERS[region]], ...)`，无任何条件跳过 global。
- index.ts:1204-1212 `registerConfigurableProviders(QODER_REGIONS.map(...))`，global 的 provider/displayName 都参与 directory。**无跳过**。

## 2. 运行时栈构建 —— 已核对对称
- index.ts:511-553 `for (const region of QODER_REGIONS)` 每个区域都 new upstream/catalog/store/shim 并装入 `stacks[region]`，global 分支没有一个成员漏初始化（552 `stacks[region] = { upstream, catalog, shim, store, probeClient, poolRuntime }`）。
- index.ts:1178-1193 注册块 `Promise.all(QODER_REGIONS.map(region => stacks[region].shim.ready))` 先等**全部**区域 shim 就绪再注册，global 的 shim 未启动会整体阻塞——不可能出现 global 未注册而 cn 注册的情况。

## 3. 区域字面量表 —— 全部核对对称（无漏初值）
- index.ts:457 `registration = { cn:{}, global:{} }`
- index.ts:462 `checkinState = { cn:{}, global:{} }`
- index.ts:473 `fullCatalog = { cn:[], global:[] }`
- index.ts:1139-1140 `catalogs = { cn:{current()...}, global:{current()...} }`
- index.ts:1183/1198 `adapters`/`releaseAdapter` 为 `as Record<QoderRegion,...>`，由 :1184-1203 循环填满两侧。
- index.ts:611/613 `poolCreditsSnapshot`/`poolCreditsSnapshotAt` 为 Partial，按 region 按需写入——无漏初值问题。
- adapter.ts:36、:50、device-risk.ts:54-63（UMID_CANDIDATES 两侧都列）、device-risk.ts:73 cache（Partial 按需）——均双侧。
- web-status.ts:159 `catalogs: Record<QoderRegion,...>` 是接口类型声明，由 host 在 index.ts:1139-1140 填充，非字面量表。

## 4. shim —— 已核对对称（global 的 shim 真的启动）
- shim.ts:203 每次 `createQoderShim` 生成独立 `randomBytes(32)` secret；:223 `server.listen(0,'127.0.0.1')` 独立随机端口。每个 region 一个独立 shim 实例（index.ts:518 在区域循环内创建），secret/port 天然互斥。
- index.ts:552 `stacks[region].shim` 组装各区；:1178 注册前等 `stacks[region].shim.ready`（所有区域）。global 的 shim 是注册的前置条件，确认被启动。

## 5. web-status / status-paths /
- 每处区域分发都是参数化 `(region)`：web-status.ts `requiredRegion`(:240-246)、`regionOfStatusUrl`(:326)、buildWebUsage(:624)、buildPoolView(:715) 全按 `deps.xxx(region)` 取，路由 /usage /pool /transfer /models 的 region 均来自 URL 且 global 与 cn 同路径，无仅 cn 分支。**已核对对称**。
- **checkinSupported 恒 true（index.ts:949 `() => true`）—— 判定非缺口，错误路径可接受**：
  - runCheckinBatch（index.ts:711）逐账号 try/catch（:724 调用 `client.claimDailyCredits`，:737 catch push `failed` 行并带 `outcome.message`/`error.message`）。取不到 UMID 时 readDeviceRisk 在该成员读到 fail → 该行 `status:'failed'+真实 message`。
  - web-status:459-466：`checkinSupported(region)!==true` 才会 409；host 恒 true 故 409 永不触发，而真正失败在 :465 `pool.checkin(region)` 的 rows 里如实呈现（:466 200 + rows）。用户看到的不是空白/静默，而是池表格里带真实报错的 `failed` 行。**结论：恒 true 是可接受设计，非缺口。**

## 6. bin.ts —— 已核对对称
- bin.ts:29 `REGION_KEYS=['cn','global']`；:60/83 `--region cn|global` 解析（regionArg :79-86）。doctor(:108-116) 与 status(:167-170) 均 loop 两侧；logout(:221-224) 依 `regionArg()` 清指定区域的 vault+pool 文件。日志还显式对比两侧 env 变量（:68-69）。**全部覆盖 global**。

---

## 发现的不对称汇总
**实质不对称：0 条。**

**仅整洁 / 命名瑕疵（不影响功能）：**
- index.ts:1204 `releaseDirectory = registration.cn.directory = registerConfigurableProviders(...)` —— registerConfigurableProviders 一次登记了两区域（map 两侧），但句柄只存在 `registration.cn.directory` 槽，并无 `registration.global.directory`。syncRegionRegistration(:876) 也单读 `registration.cn.directory`。这是**单句柄管理两侧**的既成设计，功能对称（:879-887 对两侧 replace），但命名会让审计者误以为 global 漏了 directory 句柄。
  - 严重度：仅整洁 | 建议：句柄变量改名如 `directoryHandle`，或注释说明「single handle covers both regions」，避免与逐区 `registration[region].adapter` 的形态不一致。

---

## 结论
host 侧（index/shim/adapter/bin/web-status）装配与运行时**完全对称**：provider 注册、运行时栈、shim（独立端口/secret 且均启动）、RegionRecord 表、status-paths/web-status 区域分发、bin CLI region 覆盖，均无实质不对称。checkinSupported 恒 true 的错误路径已核对为可接受（failed 行带真实 message），非缺口。唯一【仅整洁】项为 directory 句柄单槽命名（index.ts:1204, 876）。

（注：bin.ts doctor/status 的**上游可达性**与 gateway 域名内容属 task-1 范围，此处仅确认 region 覆盖形态。）
