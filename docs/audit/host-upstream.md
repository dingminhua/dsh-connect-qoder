# 审计A：宿主侧上游链路对等性（task-1，audit-host-upstream）

范围：src/upstream.ts, cosy.ts, device-risk.ts, catalog.ts, credentials.ts,
accounts.ts, transfer.ts, account-pool*.ts, credential-recovery.ts, probe.ts。
只读，未改任何 src/ 文件。

## 1. QODER_REGIONS 七个字段 → 消费者核对（全对称，均有消费）

| QoderRegionConfig 字段 | 消费者（upstream.ts） |
| --- | --- |
| gateway | :307（jobToken 交换）、:362（models）、:450（chat） |
| openapi | :531（usage）、:603（campaigns）、:649（claim）、:699（sash origin） |
| chatPath | :450 |
| modelsPath | :362 |
| jobTokenPath | :307 |
| campaignsPath | :603（GET 列表）、:649（claim POST） |
| requiresDeviceRisk | :724（deviceRiskHeaders） |

结论：两区域（cn/global）七个字段取值均已按区域接入 `this.region.<field>`，
**无硬编码漏网**。

## 2. 实质缺口（唯一，阻断）——usage 路径漏发 device risk

- 文件:行：src/upstream.ts:563（`jobTokenGet`）、:534（`fetchUsage` 内调用）、:531（usage URL）。
- 现象：用量查询 `GET {openapi}/sash/api/v2/me/usage` 走 `fetchUsage` → `jobTokenGet`，
  `jobTokenGet` 只发 `accept` + `authorization`（:572-576），**未调用 deviceRiskHeaders()**。
  `deviceRiskHeaders` 仅被 `sashRequest`（:698）消费，而 `sashRequest` 只服务
  campaigns（:604）与 claim（:651）两个端点。global 的 `requiresDeviceRisk === true`（:117）。
- 为何不对称：campaigns/claim 两个 sash 端点带 `Cosy-Machine*` 三件套，用量端点不带。
  global 只有签到头被下发给风控请求，**用量/积分请求缺头**。
- 严重度：**阻断**（global 用量拿不到/被拒，实测返回 401；直连回退 `fetchUsageDirect`
  :744-750 同样无风控头，两条路径都缺）。
- 修法：`jobTokenGet`（或 `fetchUsage` 的 usage URL 请求）内补 `...(await this.deviceRiskHeaders())`，
  使 usage 请求与 campaigns/claim 一致；或让 `sashRequest` 承接 usage。
- 测试缺口：tests/device-risk.spec.ts 仅对 `fetchCampaigns` 断言风控头（:107-113），
  全文从未调用 `fetchUsage`——因此该缺口从未被测试暴露。

证据（sashRequest / jobTokenGet / deviceRiskHeaders 全调用点）：
`this.deviceRiskHeaders()` 仅 :698；`this.sashRequest` 调用点 :604/:651；
`this.jobTokenGet` 调用点 :534；`this.fetchUsageDirect` 调用点 :547。

## 3. 已核对对称项（明细 + 行号）

- **catalog.ts 零 region 引用**：全文 grep 无 `region/global/cn`（jsdoc 关键字亦无）。
  模型目录形状无区域分支，两侧共用同一解析逻辑（待实测验证：global 实际的模型 JSON 形状）。
- **credentials.ts PAT 环境变量双侧**：`QODER_PAT_ENV_VARS` 双侧定义齐全
  （:20-23，global=QODER_PERSONAL_ACCESS_TOKEN / cn=QODERCN_PERSONAL_ACCESS_TOKEN）；
  `patFromEnv` 按 `region` 索引（:33）。对称。
- **accounts.ts 灰 vault 路径参数化**：`qoderAccountsPath(region)` = `VAULT_PREFIX.${region}.json`
  （:81-82），constructor 存 `this.region`（:96-97），读写都走参数化路径。对称。

## 4. transfer 区域域名匹配——核对结论

- `knownQoderRegionOfDomain`（status-paths.ts:252-257）与 `knownRegionOfDomain`
  （transfer.ts:121-125）逻辑一致：`qoder.com.cn`→cn，`qoder.sh`→global，其余拒绝。**函数本身双向对称**。
- 但发现两处不一致，建议一并修（严重度：阻断 / 仅整洁）：
  1. **导出未写 `domain`**（阻断，双区域都裂）：`exportAccounts`（index.ts:1009-1012）
     只返回 `{pat, accountName, id}`，不含 `domain`；`transferRecordOf`（transfer.ts:99）
     定义了把 `domain` 写进记录，但**全库无任何调用点**（grep 仅 transfer.ts:99 一处）。
     于是导出文件记录无 `domain`，再导入时 `knownRegionOfDomain(undefined)===undefined`
     ≠ 目标 region，region 门（transfer.ts:167）全部 skip。cn/global 均受影响（对称性裂，但非 cn-vs-global 单侧）。
  2. **global 控制台域名与区域门不一致**（仅整洁）：`QODER_CONSOLE_DOMAIN.global === 'qoder.com'`
     （status-paths.ts:272），而区域门只认 `qoder.sh`。若任何导出方/用户用控制台域名 `qoder.com`
     打 global 标记，则该记录被区域门拒绝。规范目标是：导出侧 tag 的域名必须与区域门认的域名一致。