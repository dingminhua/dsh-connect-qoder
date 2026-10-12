# Lead 独立核查发现（cn / global 对等审计）

审计日期：2026-10-12
审计人：Lead（team lead）
方法：静态代码核查 + 注入 fetch 实测 + 真实端点探测

> 本文件只记录 **Lead 本人亲手验证过** 的结论。每条都给出可复现的命令或代码行号。
> 团队成员（audit-host-upstream / audit-host-wiring / audit-client-ui / audit-runtime）
> 的结论见各自文件，不在此重复。

---

## 结论 0（前提修正）：国际版「代码已完成，但从未被执行过」

这是整次审计最重要的上下文，因为用户的判断「国际版还没完成」与仓库的
CHANGELOG 判断「国际版已接通」冲突，而**两边都不是完全错的**：

- 代码层：cn / global 两个区域确实是**同一套代码按 region 分发**，没有
  「global 分支待实现」的空壳。上一轮 commit `7b3f4fb` 的说法在**代码结构**上成立。
- 运行层：国际版**从未真正跑过**。

证据（命令 + 输出）：

```bash
$ ls -la ~/.dsh/.qoder-*
-rw-------  1 dmh2002  staff   249 Oct 12 17:44 /Users/dmh2002/.dsh/.qoder-accounts.cn.json
-rw-------  1 dmh2002  staff   129 Oct 12 21:27 /Users/dmh2002/.dsh/.qoder-host-heartbeat.json
-rw-------  1 dmh2002  staff  541 Oct 12 18:52 /Users/dmh2002/.dsh/.qoder-pool.cn.json
```

**没有** `.qoder-accounts.global.json`，也没有 `.qoder-pool.global.json`。
这两个文件是 `accounts.ts:81 qoderAccountsPath()` 与
`account-pool-store.ts:46 qoderPoolStorePath()` 在首次使用对应区域时必然创建的。
它们不存在 ⇒ 国际版从未配置过 PAT、从未探测过、从未签到过。

**这解释了用户「国际版还没完成」的直觉是准确的**：用户看到的是国际版 tab
里空空如也、点了也没有真实反馈。而代码审计（只看代码）会得出「已经对称」的
相反结论。**两者都对，区别在于「代码写完」不等于「跑通」。**

---

## 发现 1【真实不对称 · 已实测证实】：用量/积分接口漏发国际版设备风控头

**严重度：影响体验（国际版积分可能永远读不出来）**

### 现象

`requiresDeviceRisk` 在 global 为 `true`（`src/upstream.ts:117`），语义是
「该区域的 sash 请求必须带 `Cosy-MachineToken/Code/Type` 三件套」。

但该配置**只被一个函数消费**：

| 函数 | 行号 | 服务的端点 | 是否附加 device risk |
| --- | --- | --- | --- |
| `sashRequest()` | `src/upstream.ts:679` | campaigns（签到）、claim（领取） | ✅ 第 698 行 `...(await this.deviceRiskHeaders())` |
| `jobTokenGet()` | `src/upstream.ts:563` | **usage（用量/积分）** | ❌ **无** |
| `fetchUsageDirect()` | `src/upstream.ts:738` | usage 的直连回退 | ❌ **无** |

即：**签到带了风控头，积分没带。** 同一个 `requiresDeviceRisk` 开关，
在三个 sash 端点里只覆盖了两个。

### 实测证据（注入 fetch，观察真实构造出的请求头）

```bash
$ node --experimental-strip-types /tmp/verify-usage-gap.mjs
cn      sash url: https://openapi.qoder.com.cn/sash/api/v2/me/usage
        machine-risk headers present: *** NONE ***
        all headers: accept, authorization
global  sash url: https://openapi.qoder.sh/sash/api/v2/me/usage
        machine-risk headers present: *** NONE ***
        all headers: accept, authorization
```

global 的用量请求只带 `accept` + `authorization`，**零个** machine 头 —— 尽管
`QODER_REGIONS.global.requiresDeviceRisk === true`。

### 无法证实的一半（诚实标注）

我用假 bearer 直接打真实端点，**带不带风控头返回完全相同的错误**：

```bash
# 不带风控头
HTTP 401 {"code":"TOKEN_EXPIRE","message":"token is not active"}
# 带风控头
HTTP 401 {"code":"TOKEN_EXPIRE","message":"token is not active"}
```

也就是说：该端点在校验风控头**之前**就先校验了 token，所以**用假 token 无法
证明缺头会不会导致失败**。

⇒ 严格表述：**「代码不一致」已实测证实；「会导致国际版积分读不出来」仅能从
设计意图推断，需真实国际版 PAT 才能定论。**

之所以仍建议修：这是同一个 `requiresDeviceRisk` 契约下的**契约违背**——
要么 global 的用量确实需要头（则该修），要么用量确实不需要头（那么 campaigns
的注释与实现应说明为什么只有签到需要）。**当前「签到要、用量不要」这个分化，
在代码和注释里都没有任何依据**，属于无意的遗漏而非有意的设计。

### 为什么这个缺口没被测试发现（根因）

`tests/device-risk.spec.ts` **确实**断言了「头被附加到请求」，但**只对 `fetchCampaigns`**：

```ts
// tests/device-risk.spec.ts:107-113
const { headers, client } = capture('global')
await client.fetchCampaigns('pt-x')          // ← 只测了签到
expect(sent['cosy-machinetoken']).toBeTruthy()
```

```bash
$ grep -n "fetchUsage" tests/device-risk.spec.ts
  *** NEVER — usage path untested for device risk ***
```

整个测试文件**从未调用 `fetchUsage`**。也就是说：测试覆盖了 device risk 的
「读取」与「签到路径的附加」，但**没有覆盖用量路径**——而用量恰恰是漏掉的那个。
这是一个典型的「测试与实现同源于同一个误解」的盲区，不是随机的覆盖率不足。

### 建议修法

把 device risk 头的附加下沉到 `jobTokenGet()` 与 `fetchUsageDirect()`，
或抽出统一的 `sashHeaders()` 供三处共用，使 `requiresDeviceRisk` 对所有
sash 端点一致生效。修完需要一条回归测试：**断言 region=global 时
usage 请求确实带上了三个 Cosy-Machine* 头**（现有测试只断言了
`readDeviceRisk()` 本身能读、以及区域配置值，**没有**断言 usage 路径的头）。

---

## 发现 2【已核查 · 对称，非缺口】：`checkinSupported: () => true` 的错误路径可接受

`src/index.ts:949` 把 `checkinSupported` 改成恒 `true`（两个区域都显示签到 UI）。
我核查了「本机取不到 UMID 组件时 global 签到会怎样」，结论是**不会静默失败**：

- `runCheckinBatch()`（`src/index.ts:711`）逐账号 `try/catch`（第 737-739 行），
  异常被转成 `{ status: 'failed', message: <原始错误> }` 的行。
- `readDeviceRisk()`（`src/device-risk.ts`）在找不到组件时抛出明确的
  `未找到 Qoder 设备风控组件（umid/runtime-info）...` 消息（第 117-121 行）。
- 该消息经 `failed` 行回到卡片，用户在账号池表格看到如实原因。

⇒ 这是**设计上正确的**（宁可如实报错也不静默降级成「今天没有活动」），
**不是**缺口。唯一可讨论的是「能力探测」是否该提前到 UI（本机没装 Qoder 就
不显示签到列），但那是 UX 取舍，不是不对称。

实测：本机两个 App 的组件都可用且输出完整：

```bash
$ /Applications/Qoder.app/Contents/Resources/umid/runtime-info
{"machineToken":"P1g…","machineType":"<16 hex，设备身份，已脱敏>","machineCode":"<16 hex，已脱敏>","vmInfo":{…}}
```

> 输出里的 `machineToken` / `machineType` / `machineCode` 是**设备身份**（上游风控用它识别本机），
> 本文档刻意不完整记录——只记形状与长度，不记取值。

---

## 发现 3【已核查 · 对称，非缺口】：locale 字典零漂移

任务书怀疑「global 复用了 CN 专属措辞」。实测**不存在**这个问题：

```bash
$ node --experimental-strip-types /tmp/locale-audit.mjs
en keys: 250 | zh keys: 250
only in en: (none)
only in zh: (none)
```

zh / en 两份字典 **250 : 250 完全对齐**，无缺键。

仅 3 个 key 的中文文案出现「国内」字样，且**全部是应当如此的**：

| key | 判定 |
| --- | --- |
| `row.tabCn` = 「国内版」 | ✅ 就该写国内 |
| `row.showCreditsCnHint` = 「…显示国内版（QD CN）剩余额度…」 | ✅ 就该写国内 |
| `row.desc` = 「…国内版与国际版是两个独立供应商…」 | ✅ 是在描述两者的关系 |

global 侧有独立的 `row.tabGlobal` = 「国际版」/「Global」与
`composer.pointsGlobal` = 「QD AI」。**无泄漏。**

---

## 发现 4【已核查 · 对称，非缺口】：vault / pool 路径按区域正确参数化

```ts
// src/accounts.ts:81
export function qoderAccountsPath(region: QoderRegion): string {
  return join(resolveDshHome(), `${VAULT_PREFIX}.${region}.json`)   // .qoder-accounts.<region>.json
}
// src/account-pool-store.ts:46
export function qoderPoolStorePath(region: QoderRegion): string { /* .qoder-pool.<region>.json */ }
```

两侧路径都由 region 拼出，global 首次使用会正确创建 `.qoder-accounts.global.json`。
`src/catalog.ts` 全文**零** region 引用（纯区域无关的解析逻辑），无需对称性处理。

---

## 发现 5【已核查 · 对称，非缺口】：两区域请求形状正确

注入 fetch 拦截，确认两个区域的 client 各自打到正确的网关：

```
[cn]     cfg gateway=https://gateway.qoder.com.cn  openapi=https://openapi.qoder.com.cn deviceRisk=false
  -> https://gateway.qoder.com.cn/algo/api/v3/user/jobToken?Encode=1
[global] cfg gateway=https://api1.qoder.sh          openapi=https://openapi.qoder.sh         deviceRisk=true
  -> https://api1.qoder.sh/algo/api/v3/user/jobToken?Encode=1
```

真实端点可达性（假 PAT）：

| 端点 | 状态 | 判定 |
| --- | --- | --- |
| `gateway.qoder.com.cn/algo/api/v2/model/list` | 403 | 存活（拒绝未认证） |
| `api1.qoder.sh/algo/api/v2/model/list` | 403 | 存活 |
| `openapi.qoder.sh/sash/api/v1/me/campaigns` | 401 `TOKEN_INVALID / missing authorization token` | **存在**（不是 404） |
| 两区域 `fetchCampaigns()` 全链路 | 401 `personal token is invalid` | 协议正确（假 PAT 应得此结果） |

device-risk 组件读取与 client 级真实调用均正常。

---

## 发现 6【文档与代码不一致 · 已实测排除功能影响】：global 的 host 分工注释是陈旧的

**严重度：仅整洁（文档误导，不影响功能）**

`src/upstream.ts` 文件头注释（第 8-17 行）声称国际版**三个端点分属三个 host**：

```text
Global chat: api1.qoder.sh/...agent_chat_generation
       models: api2.qoder.sh/algo/api/v2/model/list      ← 注释说 api2
       jobToken: center.qoder.sh/algo/api/v3/user/jobToken ← 注释说 center
       openapi: openapi.qoder.sh
```

而代码（第 111-117 行）实际把 **chat / models / jobToken 全部指向 `api1.qoder.sh`**
（`QODER_REGIONS.global.gateway`）。即**注释与实现互相矛盾**。

### 实测：三个 host 在本插件用到的端点上等效

用真实客户端对三个 host 逐个发 jobToken 交换（假 PAT），三者返回**完全相同**：

```bash
$ node --experimental-strip-types /tmp/host-compare.mjs
api1.qoder.sh    -> 401 jobToken 交换失败: HTTP 401 personal token is invalid
api2.qoder.sh    -> 401 jobToken 交换失败: HTTP 401 personal token is invalid
center.qoder.sh  -> 401 jobToken 交换失败: HTTP 401 personal token is invalid
```

关键在于错误是 **`personal token is invalid`**（凭据层）而**不是** `Signature invalid`
（签名层）——说明三个 host 都**接受本插件的 cosy 签名方案**，只是拒绝了假 PAT。
裸 curl 不带签名时三者都回 `403 Signature invalid`，进一步说明它们共享同一套
签名校验，是别名/同一网关的不同入口。

⇒ **`api1.qoder.sh` 作为唯一 gateway 是可用的**（本次审计用真实客户端验证），
注释里的 api2/center 分工**对当前实现没有功能影响**。但这仍是需要修的不一致：
注释会误导后来者以为 models/jobToken 该换 host，从而做出没有必要的「修复」。

**建议**：把文件头注释改成与 `QODER_REGIONS.global` 实际取值一致的单一 host 描述；
若 api2/center 确实有（如分区/容灾）意义，则应在配置里体现并加测试固定。

---

## 汇总（Lead 视角）

| # | 发现 | 类型 | 严重度 | 证据强度 |
| --- | --- | --- | --- | --- |
| 0 | 国际版从未被执行（无 global vault/pool） | 运行状态 | **阻断性上下文** | 已实测证实 |
| 1 | usage/积分路径漏发 global 设备风控头 | **代码不对称** | 影响体验 | 已实测证实（不一致本身）；影响程度待真 PAT |
| 2 | `checkinSupported` 恒 true 的错误路径 | 非缺口 | — | 已核查 |
| 3 | locale 零漂移 | 非缺口 | — | 已实测证实 |
| 4 | vault/pool 路径参数化 | 非缺口 | — | 已核查 |
| 5 | 两区域请求形状 | 非缺口 | — | 已实测证实 |
| 6 | upstream 头注释的 global host 分工与实现矛盾 | 文档不一致 | 仅整洁 | 已实测证实（三 host 等效） |

**核心结论：代码的「对称性」远好于预期（只有发现 1 一处真实代码不对称），但
「国际版从未跑过」才是用户感受到的「没完成」的真正来源。** 因此修复工作应是
「修掉发现 1 + 修正发现 6 的注释 + 补一条真实国际版 PAT 的端到端验证」，
而不是重写国际版。
