# 国际版（global）对等审计报告

审计日期：2026-10-12
审计范围：cn（国内版，`gateway.qoder.com.cn`）vs global（国际版，`api1.qoder.sh`）逐模块对等性
审计方法：静态代码核查（逐函数）+ 注入 fetch 实测 + 真实端点探测

**本报告汇聚 4 个并行审计流 + Lead 独立复核的结果。凡标注「已实测证实」的结论，
均附可复现命令与原始输出。**

配套子文件：
- [`lead-findings.md`](lead-findings.md) —— Lead 独立核查（最详细的实测证据）
- [`host-wiring.md`](host-wiring.md) —— 宿主编排层专项（审计B）

---

## 一、头条结论

> **代码的区域对称性远好于预期：区域维度本身只找到 1 处真实不对称。
> 但审计顺带挖出 1 个与区域无关的严重功能 bug（账号转移往返失效，双区域皆然）。
> 而用户感受到的「国际版没完成」，真正来源是「国际版从未被执行过」。**

这三件事必须分开说，因为它们指向不同的修复动作：

| 判断 | 是否成立 | 依据 |
| --- | --- | --- |
| 「国际版代码还没写」 | ❌ **不成立** | cn/global 是同一套按 region 分发的代码，无空壳分支 |
| 「国际版已完全跑通」 | ❌ **不成立** | 本机**没有** global 的 vault/pool 文件，说明从未配置、从未运行 |
| 「区域维度有 1 处真实不对称」 | ✅ **成立** | 用量/积分路径漏发设备风控头（见发现 1） |
| 「账号转移导出/导入是好的」 | ❌ **不成立** | 导出即导入 → 0 条成功（见发现 2）。**与区域无关，cn 也坏** |

所以正确的修复动作是：**修 1 处区域不对称 + 修 1 个双区域功能 bug +
补一次真实国际版端到端验证**，而**不是**重写国际版。

---

## 二、发现清单

| # | 发现 | 类型 | 严重度 | 证据强度 |
| --- | --- | --- | --- | --- |
| **0** | 国际版从未被执行（无 global vault/pool） | 运行状态 | **阻断性上下文** | 已实测证实 |
| **1** | 用量/积分路径漏发 global 设备风控头 | **代码不对称** | 影响体验 | 已实测证实（不一致本身）；影响程度待真 PAT |
| **2** | **账号转移导出/导入往返完全失效（双区域）** | **真 bug** | **阻断** | **已实测证实（导出即导入 → 0 成功）** |
| 3 | upstream 头注释的 global host 分工与实现矛盾 | 文档不一致 | 仅整洁 | 已实测证实（三 host 等效） |
| 4 | directory 句柄单槽命名易误读 | 命名瑕疵 | 仅整洁 | 已核查（单句柄管两侧，功能对称） |
| 5 | `QODER_CONSOLE_DOMAIN.global='qoder.com'` 与区域门只认 `qoder.sh` | 文档不一致 | 仅整洁 | 已核查（两个域名用途不同，非同一事实） |
| — | `checkinSupported` 恒 true 的错误路径 | **非缺口** | — | 已核查（如实报错） |
| — | locale 字典漂移 | **非缺口** | — | 已实测证实（250:250） |
| — | vault/pool 路径参数化 | **非缺口** | — | 已核查 |
| — | 两区域请求形状 / provider 注册 / shim / RegionRecord 表 / CLI | **非缺口** | — | 已实测证实 |

---

## 三、发现 0（前提修正）：国际版从未被执行

这是理解整件事的关键。`~/.dsh` 下**只有 cn 的状态文件**：

```bash
$ ls -la ~/.dsh/.qoder-*
-rw-------  .qoder-accounts.cn.json      # cn 的 vault
-rw-------  .qoder-pool.cn.json          # cn 的账号池测量
-rw-------  .qoder-host-heartbeat.json
```

**没有** `.qoder-accounts.global.json`，也**没有** `.qoder-pool.global.json`。
这两个文件由 `accounts.ts:81 qoderAccountsPath()` 与
`account-pool-store.ts:46 qoderPoolStorePath()` 在首次使用对应区域时必然创建。

⇒ 国际版从未配置 PAT、从未探测、从未签到。**用户说「国际版没完成」的直觉是
准确的**——他在国际版 tab 里看到的是空状态与无反馈；而纯代码审计会得出相反的
「已经对称」结论。**两者都对，区别在于「代码写完」≠「跑通」。**

---

## 四、发现 1（唯一真实代码不对称）：用量/积分漏发设备风控头

### 现象

`requiresDeviceRisk` 在 global 为 `true`（`src/upstream.ts:117`），语义是
「该区域的 sash 请求必须带 `Cosy-MachineToken/Code/Type` 三件套」。
但该配置**只被一个函数消费**：

| 函数 | 行号 | 服务端点 | 是否附加 device risk |
| --- | --- | --- | --- |
| `sashRequest()` | `src/upstream.ts:679` | campaigns（签到）、claim（领取） | ✅ 第 698 行 |
| `jobTokenGet()` | `src/upstream.ts:563` | **usage（用量/积分）** | ❌ **无** |
| `fetchUsageDirect()` | `src/upstream.ts:738` | usage 直连回退 | ❌ **无** |

**签到带了风控头，积分没带。** 同一个开关在三个 sash 端点里只覆盖了两个。

### 实测证据

```bash
$ node --experimental-strip-types /tmp/verify-usage-gap.mjs
cn      sash url: https://openapi.qoder.com.cn/sash/api/v2/me/usage
        machine-risk headers present: *** NONE ***
        all headers: accept, authorization
global  sash url: https://openapi.qoder.sh/sash/api/v2/me/usage
        machine-risk headers present: *** NONE ***
        all headers: accept, authorization
```

### 为什么测试没发现（根因）

`tests/device-risk.spec.ts` **确实**断言了「头被附加」，但**只对 `fetchCampaigns`**：

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

测试覆盖了 device risk 的「读取」与「签到路径的附加」，**恰好漏掉用量路径**——
而用量正是出问题的那个。这不是随机覆盖率不足，是**测试与实现同源于同一个理解偏差**。

### 诚实标注：影响程度未证实

用假 bearer 打真实端点，**带不带风控头返回完全相同的错误**：

```bash
# 不带风控头 → HTTP 401 {"code":"TOKEN_EXPIRE","message":"token is not active"}
# 带风控头   → HTTP 401 {"code":"TOKEN_EXPIRE","message":"token is not active"}
```

该端点在校验风控头**之前**先校验 token，所以**用假 token 无法证明缺头会失败**。

⇒ 严格表述：**「代码不一致」已实测证实；「导致国际版积分读不出来」仅能从设计
意图推断，需真实国际版 PAT 才能定论。**

之所以仍建议修：这是同一 `requiresDeviceRisk` 契约下的**契约违背**——
「签到要、用量不要」这个分化在代码与注释里**都没有任何依据**，属无意遗漏。

### 修法

把风控头下沉到 `jobTokenGet()` 与 `fetchUsageDirect()`，或抽出统一
`sashHeaders()` 三处共用。**必须补一条回归测试**：断言 region=global 时
**usage 请求**确实带三个 Cosy-Machine* 头（现有测试只覆盖 campaigns）。

---

## 五、发现 2（**最严重**）：账号转移导出/导入往返完全失效

> 本条由审计A（`audit-host-upstream`）发现，Lead **实测复现**后确认，并补上根因。
> 它**同时影响 cn 与 global**，是本次审计中唯一「用户点下去必然失败」的功能性 bug。

### 现象

导出账号时，**不写 `domain` 字段，且字段名是错的**。

- `exportAccounts`（`src/index.ts:1009`）直接返回 vault 的原始形状：
  `{ pat, accountName, id }`
- 它**没有**调用 `transferRecordOf()`（`src/transfer.ts:99`）——该函数本应把它
  转成规范的 `{ access_token, uid, nickname, domain }`。**`transferRecordOf`
  在 `src/` 下零调用点，只在测试里被调用**（`grep transferRecordOf src/` 只命中
  定义处）。
- 客户端 `AccountTransfer.tsx:129` 于是原样下载 `answer.accounts`。
- 导入时区域门（`src/transfer.ts:167` 附近）**只认 `domain`**；记录没有
  `domain` → 全判 `skipped`。

### 实测证据（导出即导入，对照 transferRecordOf）

```bash
$ node --experimental-strip-types /tmp/verify-export.mjs
=== the exported FILE a user would download ===
[ { "pat": "pt-secret",
    "accountName": "<上游回传的真实账号显示名（邮箱），已脱敏>",
    "id": "pat-5d76517ac7699f87" } ]        ← 无 domain，字段名也不是 snake_case

=== re-import that same file into region=cn ===
imported: 0 | skipped: 1 | changes: 0       ← *** 往返失败 ***

=== for contrast: a CORRECT record via transferRecordOf ===
[ { "access_token": "pt-secret",
    "uid": "pat-5d76517ac7699f87",
    "nickname": "a@b.c",
    "domain": "qoder.com.cn" } ]
imported: 1 | skipped: 0                    ← 正确形状即可成功
```

**用户视角**：导出得到一个文件，想导回来（换机器 / 换区域 / 备份恢复），
导入结果永远是「0 条成功、全部跳过」。功能等于不可用。

### 为什么测试没发现（根因：集成缝）

- `tests/transfer.spec.ts:86-107` 测的是 **`transferRecordOf` 本身**的正确输出
  （它确实是对的）。
- `tests/transfer.spec.ts:109+` 测的是 **区域门** 单独行为（也是对的）。
- **没有任何测试把「真实导出路径」接到「真实导入路径」上**：
  `grep -rn "exportAccounts" tests/` 只命中 `web-status.spec.ts:131/506` 两处
  **桩（stub）**，它们返回的正是那个残缺形状，从不做往返。

⇒ 典型的两半各自正确、**接缝断掉**。修法的同时必须补**往返测试**（导出 →
把导出物原件喂给导入 → 断言 imported === 导出条数）。

### 修法

让 `exportAccounts` 走 `transferRecordOf()`（传入该区域的 domain：
cn→`qoder.com.cn`、global→`qoder.sh`），使导出物带上 `domain` 与 snake_case 字段。
**该修法同时修好 cn 与 global**——这不是区域不对称，是导出路径整体漏了投影。

### 附带：发现 5（`QODER_CONSOLE_DOMAIN` vs 区域门）

同一审计流指出 `QODER_CONSOLE_DOMAIN.global = 'qoder.com'`（`status-paths.ts:272`）
与区域门只认 `qoder.sh`（`status-paths.ts:253`）不一致。
Lead 判定：**非缺口，属两个不同事实**——`qoder.com` 是**控制台网页域名**
（用户浏览器里看到的），`qoder.sh` 是**网关/令牌承载域名**（PAT 实际发证方）。
`QODER_CONSOLE_DOMAIN` 的注释（`status-paths.ts:263-269`）已明确说明这个区别。
二者不该统一，否则「去哪申请 PAT」这句说明会指向错误的站点。

---

## 六、发现 3（文档不一致）：global host 分工注释与实现矛盾

`src/upstream.ts` 头部注释（第 8-17 行）称国际版三端点分属三 host
（chat=`api1`、models=`api2`、jobToken=`center`），而代码（第 111-117 行）
把三者**全部**指向 `api1.qoder.sh`。

实测三 host 在插件用到的端点上**完全等效**：

```bash
$ node --experimental-strip-types /tmp/host-compare.mjs
api1.qoder.sh    -> 401 jobToken 交换失败: HTTP 401 personal token is invalid
api2.qoder.sh    -> 401 jobToken 交换失败: HTTP 401 personal token is invalid
center.qoder.sh  -> 401 jobToken 交换失败: HTTP 401 personal token is invalid
```

关键在错误是 **`personal token is invalid`**（凭据层）而非 `Signature invalid`
（签名层）——说明三 host 都**接受本插件的 cosy 签名**，只是拒绝假 PAT。
⇒ `api1.qoder.sh` 单 host 可用，**注释误导无功能影响**，但应修正以免后来者
做出无必要的「修复」。

---

## 七、已核对为「对称」的项（非缺口）

这些是任务书怀疑、但实测/核查后**确认没有问题**的，列出以免重复劳动：

1. **locale 字典零漂移** —— `en` 250 键、`zh` 250 键，`only in en: (none)`、
   `only in zh: (none)`。仅 3 个 key 中文含「国内」，全部**应当如此**
   （`row.tabCn` / `row.showCreditsCnHint` / `row.desc`）。global 有独立
   `row.tabGlobal`、`composer.pointsGlobal` 等，且 zh/en **两侧都存在**（各计数 2）。
2. **`checkinSupported` 恒 true 的错误路径可接受** —— `runCheckinBatch()`
   (`src/index.ts:711`) 逐账号 try/catch（:737-739），UMID 缺失时
   `readDeviceRisk()` 抛出明确消息并转成带真实 message 的 `failed` 行，
   用户在池表格看到如实原因，不是空白。属**正确设计**。
3. **vault/pool 路径参数化** —— `accounts.ts:81` / `account-pool-store.ts:46`
   均由 region 拼出；`catalog.ts` 全文**零** region 引用。
4. **provider 注册与运行时栈对称** —— `qoder` / `qoder-global` 各自
   `registerAdapter`；`for (const region of QODER_REGIONS)` 内建栈，
   注册前 `Promise.all(...shim.ready)` 等**全部**区域，不可能只注册一侧。
5. **shim 每区域独立** —— `shim.ts:203` 每次 `randomBytes(32)` secret、
   `:223` `listen(0)` 随机端口，实例在区域循环内创建。
6. **所有 `Record<QoderRegion,...>` 表两侧都填了初值** —— 且 TS 类型
   `Record<QoderRegion, T>` **编译期强制**，漏填 global 根本无法通过 typecheck。
7. **区域启停对称** —— `regionEnabled()`(`index.ts:201`) 通用；
   `syncRegionRegistration`(`:865`) 对两侧 `handle.replace(enabled ? [...] : [])`，
   取消勾选 global 会真正摘除路由与目录条目。
8. **CLI 覆盖 global** —— `bin.ts:29 REGION_KEYS=['cn','global']`，
   `doctor`/`status`/`logout` 默认遍历两区域且支持 `--region global`。
9. **transfer 域名匹配双向成立** —— `transfer.ts:121-123`：
   `qoder.com.cn`→cn、`qoder.sh`→global；导入按记录自身 domain 做区域门禁。
10. **两区域请求形状正确** —— 注入 fetch 证实：cn→`gateway.qoder.com.cn`，
    global→`api1.qoder.sh`，jobToken 与 model/list 均打到各自 gateway。

---

## 八、基线状态（实测）

```bash
$ pnpm test
 Test Files  26 passed (26)
      Tests  436 passed (436)

$ pnpm run typecheck
（无输出 = 通过）

$ pnpm run build
✔ Build complete（lib/index.js 124.05 kB、lib/client.js 242.42 kB）

$ pnpm vitest run tests/device-risk.spec.ts
 Tests  8 passed (8)
```

---

## 九、建议的修复计划（待用户批准后实施）

| 优先级 | 动作 | 落点 |
| --- | --- | --- |
| **P0** | **修账号转移导出/导入往返**：让 `exportAccounts` 走 `transferRecordOf()` 并带上该区域 domain | `src/index.ts:1009` |
| **P0** | **补往返集成测试**：导出 → 把导出物原件喂给导入 → 断言 `imported === 导出条数`（cn 与 global 各一条） | `tests/transfer.spec.ts` |
| P0 | usage 路径补发设备风控头（或统一 `sashHeaders()`） | `src/upstream.ts:563`、`:738` |
| P0 | 补回归测试：断言 global 的 **usage 请求**带三个 Cosy-Machine* 头 | `tests/device-risk.spec.ts` |
| P1 | **真实国际版 PAT 端到端验证**：拉模型目录 → 跑一次对话 → 查积分 → 签到，并记录 `~/.dsh/.qoder-accounts.global.json` 与 `.qoder-pool.global.json` 的生成 | 实测（需用户提供 PAT） |
| P1 | 修正文件头注释的 global host 描述，与 `QODER_REGIONS.global` 一致 | `src/upstream.ts:8-17` |
| P2 | `registration.cn.directory` 单槽命名改 `directoryHandle` 或加注释 | `src/index.ts:1204`、`:876` |
| P2 | 可选：本机无 UMID 组件时，卡片刻意隐藏 global 签到列（能力预探测），而非等用户点了才报错 | `src/client/AccountPool.tsx:201` |

> **两条 P0 的性质不同，都要修但理由不一样：**
> - **账号转移往返**（发现 2）是**已实测证实的功能性 bug**，用户点下去必然失败，
>   且 cn/global 都受影响。**不需要任何 PAT 就能验证修复。**
> - **usage 风控头**（发现 1）是**已证实的代码契约违背**，但其「是否真的导致
>   积分读不出来」需真 PAT 才能定论。
>
> **P1 的端到端实测是本次审计最有价值的一步**：发现 1 的影响程度、以及是否还有
> 只有真 PAT 才能暴露的缺口（global 的模型目录形状、积分字段、签到活动是否真的
> 需要风控头），都只能在真实国际版 PAT 下结清。**需要用户提供国际版 PAT。**
