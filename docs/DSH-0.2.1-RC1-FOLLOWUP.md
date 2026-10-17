# DSH 0.2.1-rc.1 升级跟进调研 —— dsh-connect-qoder

> 调研日期：2026-10-17
> 宿主：DSH Desktop `0.2.1-rc.1`（`runtime/primary-runtime/runtime.json` → `desktopVersion`）
> 插件：`@dmh2002/dsh-connect-qoder` 1.0.0 → 1.1.0
> 参考：同级仓库 `dsh-connect-workbuddy` 的 [`docs/DSH-0.2.1-RC1-FOLLOWUP.md`](../../dsh-connect-workbuddy/docs/DSH-0.2.1-RC1-FOLLOWUP.md)
> 基线：本机 0.1.7-rc.1 依赖树上 **599 用例通过 / 7 跳过**（`npx vitest run`，32 文件）。

---

## 零、结论摘要 —— 与参考文档**最重要的分歧**

| 层 | 结论 | 所需动作 |
|---|---|---|
| **pi-ai 0.85 → 1.x 的上下文契约** | 🔴 **真实存在，但根因与参考文档说的不同**（见 §1） | **已改代码**（P0） |
| **peer 版本范围** | 🔴 `0.2.1-rc.1` 与 pi-ai `1.x` 都不满足现声明 | **已改**（P1） |
| 宿主 API / 客户端外壳 | ✅ 无破坏性变更 | 无 |
| 账号池体验 | 🔴 继承了上游 issue #70；`pool.enabled` 对换号完全无效 | **已修**（§3） |

### ⚠️ 与参考文档的关键分歧（必读）

参考文档 §1 的结论是：

> 「`dsh-llm-pi-ai` 从不归一化上下文 … pi-ai 1.1.0 只读 `messages` …
> **modern 分支是空的**，所以请求体丢失 system prompt 与全部工具声明」

**这个结论在真实的 0.2.1-rc.1 宿主栈上不成立。** 我按文档推荐的方式复现时，得到的是**相反**的结果。逐条实测如下。

#### 分歧点一：归一化发生在 **Models 层**，不在 api 模块

参考文档把上下文喂给 `openAICompletionsApi()`（api 模块）后，直接断言「top-level `systemPrompt` / `tools` 从未被读取」。这在 api 模块内部是对的，但它**假设了调用方会把原始 envelope 直接交给 api 模块**。真实链路不是这样：

```
dsh-llm-pi-ai (PiAiAdapter)
      └── pi-ai createModels().stream/streamSimple      ← 归一化在这里
              └── normalizeContext(context)
                      └── provider.stream(requestModel, transcript, …)
                              └── createProvider 的 api (openai-completions)
```

`PiAiAdapter.current()` 里 `models.setProvider(profile.piProvider)`（`dsh-llm-pi-ai/lib/index.js:1763`），而 pi-ai 的 `Models.streamSimple` 第一行就是：

```js
// pi-ai 1.1.0 与 1.3.0 的 dist/models.js
streamSimple(model, context, options) {
    const transcript = normalizeContext(context);
    ...
    return provider.streamSimple(requestModel, transcript, requestOptions);
}
```

**实测**（真实 `createModels` + 真实 `openAICompletionsApi`，窗口见 §5.1）：

| pi-ai 版本 | 输入 | api 模块收到的形状 | 线上 `body.tools` | 线上 system |
|---|---|---|---|---|
| 1.1.0 | 原始 envelope | `messages[0].role === 'system'`（已归一化） | **1** ✅ | 原样 ✅ |
| 1.3.0 | 原始 envelope | 同上 | **1** ✅ | 原样 ✅ |
| 0.85.1 | 原始 envelope | 原始 envelope（0.85 不归一化） | 1 ✅ | 原样 ✅ |

即：**在真实宿主栈上，原始 envelope 会被自动归一化，prompt 与工具都不会丢。**

#### 分歧点二：真正的 0.2.1-rc.1 回归在 **`generationOf()`**，不在 `withLegacyContext`

既然 1.x 的 Models 层会归一化，那 1.x 收到的是 **transcript**。此时若适配器把它当成 `legacy` 处理，`adaptLegacyPiAiContext` 就会把 transcript **逆折叠**回扁平 envelope —— 交给一个**只读 `messages`** 的 1.x api。这才是丢 prompt 与工具的那条路径。

而 `generationOf()` 恰好就会这么判：

```ts
// 修复前
const match = /^0\.(\d+)\./u.exec(version)   // ← 只认 "0.x."
if (match === null) return 'legacy'          // ← "1.1.0" 落这里
return Number(match[1]) >= 87 ? 'modern' : 'legacy'
```

实测 `generationOf`：

| 版本 | 修复前 | 应为 |
|---|---|---|
| `0.85.1` | `legacy` | legacy |
| `0.87.1` | `modern` | modern |
| **`1.0.0` / `1.1.0` / `1.3.0`** | **`legacy`** ❌ | **modern** |

**在真实 0.2.1-rc.1 + pi-ai 1.3.0 栈上实测的线上请求体**（真实 `PiAiAdapter` + 真实 `createModels` + 真实 api，只切换适配器分支）：

| 适配器分支 | 线上 `messages[].role` | 线上 system 文本 | 线上 `body.tools` |
|---|---|---|---|
| `legacy`（**修复前**的实际行为） | `["user"]` | `null`（prompt 丢了） | **0**（工具全丢） |
| `modern`（应选的分支） | `["system","user"]` | `SYS-PROMPT-MARKER` | **1** ✅ |

#### 分歧点三：因此 **modern 分支必须保持空（pass-through）**

参考文档 §1.4 建议「modern 分支改为归一化（折叠）」并推荐方案 A（内联折叠）。**这个建议在本仓库会导致新的缺陷**：

1. 1.x 的 Models 层已经归一化过，适配器再折一次会**多出一条空的 system 消息**；
2. 本仓库 checkout 解析到 **pi-ai 0.85.1**（`pnpm-workspace.yaml` 的 overrides 钉死），在 0.85 上跑「modern + 折叠后的 transcript」会直接崩在 `transformMessages` 的 `Cannot read properties of undefined (reading 'length')` —— 我实测到了这个崩溃，它恰恰证明 0.85 读不懂 transcript。

所以本仓库的修法是：**`generationOf` 认 1.x → modern；`withLegacyContext` 的 modern 分支保持原样透传。** 参考文档「不要为 rc 版本扭曲声明」的判断没有问题，问题只在于它把病灶定位到了错的那一层。

> 参考文档那套用例之所以「全绿」，除了它自己指出的 `skipIf` 之外，还有一个更根本的原因：它只覆盖了 **api 模块**这一层，而缺陷发生在 **Models 层 → api 模块**之间。这恰好也是我第一版测试踩的坑 —— 见 §5.2。

---

## 一、P0：pi-ai 1.x 被判成 legacy（已在代码中修复）

### 1.1 症状

宿主 0.2.1-rc.1 下，模型**不再调用任何工具**，且**不报错**。Qoder 网关接受无 prompt 的请求体，所以网关侧也没有报错可看。

### 1.2 根因链

1. `pi-ai` 1.x 的 `createModels().stream*` 调用 `normalizeContext()`，把 `{systemPrompt, tools, messages}` 折成 `{messages:[{role:'system', content, toolsAdded}]}`；
2. 适配器拿到的 `generation` 来自 `generationOf(version)`，而它的正则 `/^0\.(\d+)\./` **不匹配 `1.x.y`** → 返回 `legacy`；
3. `withLegacyContext` 走 legacy 分支 → `adaptLegacyPiAiContext(transcript)` 把 transcript 逆折回扁平 envelope；
4. 1.x 的 api 只读 `context.messages`，顶层 `systemPrompt`/`tools` 一字不读 → **prompt 与工具静默消失**。

### 1.3 修法

- `src/pi-ai-runtime.ts`：`generationOf` 改为解析 `major.minor`，`major >= 1` → `modern`；`0.87+` → `modern`；其余保守 `legacy`。
- `src/adapter.ts`：`withLegacyContext` 的 modern 分支**保持 pass-through**（附完整注释说明为什么折叠反而是错的）；`adaptLegacyPiAiContext` 加 LEGACY-ONLY 注记。

### 1.4 为什么守卫测试此前全绿

`tests/pi-ai-runtime.spec.ts` 原来那条用例**把错误公式抄了一遍**：

```ts
const minor = Number(/^0\.(\d+)\./u.exec(info.version)?.[1])
expect(info.generation).toBe(minor >= 87 ? 'modern' : 'legacy')
```

对 `1.3.0`，`exec` 返回 `null` → `minor` 是 `NaN` → `NaN >= 87 === false` → 断言 `legacy`。**它认证了这个缺陷。**

现在改为对**已知语义的显式版本表**求值，不再从版本号现推公式。

### 1.5 新守卫（均已做变异验证）

| 套件 | 钉住什么 | 变异验证结果 |
|---|---|---|
| `tests/pi-ai-runtime.spec.ts` | `generationOf` 的版本表（0.85→legacy、0.87+→modern、**1.x→modern**、不可读→legacy） | 退回旧正则 → **2 红** |
| `tests/adapter-outgoing-body.spec.ts` | 真实 api 构建出的**线上 body** 带着 prompt 与 tools（legacy 世代） | — |
| `tests/fixtures/pi-ai-modern/` | **真实 pi-ai 1.1.0** 上：modern 直通 → tools=1/prompt 原样；legacy 逆折 → tools=0/prompt=null | 见 §5.2 |
| `tests/dsh-line.spec.ts` | pi-ai 范围接受 1.x GA、拒绝 2.x 与未验证的预发布 | — |

---

## 二、P1：peer 范围

### 2.1 semver 事实（npm `semver@7.8.5` 实算）

现状 `>=0.1.7-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0`：

| 版本 | 满足？ |
|---|---|
| `0.1.7-rc.1` / `0.2.0-rc.1` / `0.2.0` | ✅ |
| **`0.2.1-rc.1`** | ❌ **（宿主当前版本）** |
| `0.2.1`（GA） | ✅ |

原因仍是「预发布悬崖」：预发布版本只在其 `major.minor.patch` 元组上存在**带预发布标签的比较符**时才被放行。`>=0.2.0-rc.1` 只对 `0.2.0` 开口。

### 2.2 修法与已知局限

```jsonc
">=0.1.7-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0 || >=0.2.1-rc.1 <0.3.0-0"
```

实测：`0.2.1-rc.1` ✅ ADMIT，`0.3.0-0` / `0.3.0-rc.1` ❌ 仍被挡。

> ⚠️ **已知局限（与参考文档 §2.2 同一结论）**：**没有任何静态范围能覆盖「任意 0.2.x 预发布」**。`0.2.2-rc.1` 之类新补丁号的 rc 仍需手工追加一条分支。这一点**不是**可以绕过的 semver bug，所以本仓库把它做成了**可见的待办**而不是隐藏的漏洞：`tests/dsh-line.spec.ts` 的 `UNGATED_PRERELEASES` 用**反向断言**（必须判 false）记录 `0.2.2-rc.1` / `0.2.3-rc.1` / `0.2.9-rc.1`，谁放宽范围谁就得来改这张表并说明理由。

### 2.3 pi-ai 范围

```jsonc
">=0.85.0 <0.88.0 || >=1.0.0 <2.0.0"
```

实测：`0.85.0/0.85.1/0.87.1/1.0.0/1.0.2/1.1.0/1.3.0/1.99.0` → true；`2.0.0`、`2.0.0-rc.1`、`0.84.0`、`0.88.0` → false。

> **刻意不用 `>=1.0.0-0`**：那个写法会把 `1.0.0-rc.1` 也放进来，而 1.x 的上下文契约只在已发布 GA 上实测过。实测对比：`>=1.0.0-0` 下 `1.0.0-rc.1` → **ADMIT**（不要）；`>=1.0.0` 下 → reject（要这个）。

> 注：宿主 `dsh-app-boot` 的 `evaluatePluginCompatibility()` 只校验 `@deepseek-ai/dsh*` 命名空间，所以 **pi-ai 那条 peer 从不参与宿主校验**。改它主要是 npm 安装行为与文档的正确性；真正保护用户的是 §1 的代码修复。

---

## 三、账号池体验：对齐 workbuddy

参考文档本身没写账号池，但工作项要求「在账号池体验方面学习 workbuddy 的做法」，因此单列。本轮做了**一次逐项差距审计**（对照 workbuddy 4.6.7 的实际代码），下面只记**已修**与**明确不修**。

### 3.1 已修：继承了上游 issue #70（「快过期先花」是死代码）

`src/account-pool.ts` 的 `rankPool` 此前把 `score`（积分总量）排在 `_expiring`（过期时刻）**之前**。总量几乎从不完全相等，所以「临期优先」在数学上不可达。更糟的是单个 `_expiring` 键存的是**时间戳**，`expiringSoon`（**金额**）从未被任何排序读取 —— 「临期量大者优先」根本无法表达。

修法（照 workbuddy `account-pool.ts:434-457`）：拆成三个独立键 —— `_atRisk`（有临期）/ `_expiring`（何时到期）/ `_expiringAmount`（临期多少），排序键变为：

> 可用性 → 有临期 → 先到期 → 临期量大 → 积分总量 → 账号 id

**变异验证**：退回旧排序 → **3 红**（含「196.4 分当天作废压过 1200 分」「1 分临期压过 5 万」）。

### 3.2 已修：`pool.enabled` 对换号**完全无效**

`nextFailoverCredential` 只读成员名单、**从不读 `enabled`**。默认 `enabled: false`，所以**每一条全新安装**都在这条路径上：用户以为关掉了自动行为，插件仍会在失败后悄悄换到另一个 PAT 计费。

修法：新增导出的纯函数 `poolAllowsFailover()`，在换号入口设门。

### 3.3 已修：失败记录缺两条守卫

`onServingFailure` 此前无条件把失败写进池状态。新增 `shouldRecordPoolFailure()`：

- **池关不记** —— 关掉池子意味着插件不再替用户选号，此时记下的失败会在下次开池时变成一堆没参与过任何决策的陈旧事实；
- **非成员不记** —— 勾选成员就是「我同意让这些号参与」，没勾的号不该因为一次恰好用了它的请求而被判出池。

> `invalid-request` 一类不必在这里再挡：shim 的 `isFailoverEligible` 已排除它们（400 换谁都是 400）。

**变异验证**：退回无条件通过 → **4 红**。

> 两个判据都做成**导出的纯函数**而不是留在接线里，理由与本仓库 `liveRequestProbe` 的既有注释一致：「接线变异掉，测试照样全绿过一次了」。

### 3.4 明确**不修**的项（附理由）

| 项 | workbuddy 的做法 | 本仓库为何不跟 |
|---|---|---|
| 首发按排序挑号 | `applyPoolSelection`：开池后每请求都发给排名第一 | **产品决策**：本插件「首发射给用户选的号，失败才换」是明确设计（CHANGELOG 有记录）。本次不擅自改变计费落点 |
| 凭据新鲜度决胜键 | `tokenExpiresAtMs` 更晚过期者优先 | **领域不适用**：PAT 通常不过期，该键无意义（`account-pool.ts` 头部已记录） |
| `model-busy` 2 分钟专用冷却 | 上游 14003 有独立语义 | **需先有实测报文**：不能照抄数值。已在 §3.5 记为待办 |
| 换号提示注入回复流 | 「「A」被限流，已改用池中另一个账号回答」 | 本插件的 `shim` **保留**了 `poolServingNotice` 能力，但 host 显式不接（有记录的决定）。是否需要改回属于产品决策，不在本次升级范围 |
| 每行「测试」按钮跑整批 | 逐账号 `testOne` | **是真实缺陷，但需要新增 host 能力**（`QoderPoolDeps` 无 `testOne`）。见 §3.5 |
| 静态清理幽灵成员 | 具名提示 + 可移除 chip | **用户明确要求过静默清理**（CHANGELOG 有记录），不回退 |

### 3.5 已记录、本轮**未做**的账号池待办

按用户感知收益排序，供下一轮决策：

1. **每行「测试」按钮实际跑整批** —— 用户只想测一个号，却把全部成员真实探测一遍（每个 ~25k token，有真实成本）。需要 host 新增 `testOne` dep + 路由分支。
2. **`probe.modelId` 作用域** —— 现在「可用」是无作用域的宣称：同一账号在模型 A 可用、模型 B 429，表格照样写「可用」。workbuddy 的教训：这个字段**写了必须同时改读侧**，否则每次写入都会把它抹掉。
3. **`out-of-credit` 的真实恢复时刻** —— 现在走 30 分钟兜底，而真实恢复可能是次日。
4. **`model-busy` 语义** —— 需先用 Qoder 真实报文确认是否存在「模型级拥堵 vs 账号限流」的区分；**没有就不要伪造**。
5. **空池/幽灵成员的服务端守卫** —— 卡片层已有，host 层缺 `no-members` / `no-live-members` 两个 409 reason。
6. **NDJSON 流式进度** —— 批次跑 10 个号时按钮冻结约 10×(探针耗时+400ms)，看起来像卡死。

---

## 四、已核对确认「无需改动」的项

- **宿主 API**：本仓库调用的 `dsh-llm` / `dsh-settings` / `dsh-host-webserver` / `dsh-llm-pi-ai` 符号在 0.2.1-rc.1 下签名一致（对照 npm 上的 `@deepseek-ai/*@0.2.1-rc.1` 类型面）。
- **客户端外壳**：`configForms` / `settingsScope` / `locale` / 槽位名与 `{view, form}` 契约未变。
- **`off-thinking` 的 §6 缺陷不适用本仓库**：参考文档 §6 记录的 `canDisableThinking !== true` 条件反转，在本仓库**不存在** —— `src/adapter.ts:146` 写的是正确形式 `if (info.canDisableThinking === true) map.off = 'off'`。已核对，未改。

---

## 五、附录：可复现的验证手法

### 5.1 决定性对齐测试（真实宿主栈）

用 npm 上的 `@deepseek-ai/dsh-llm-pi-ai@0.2.1-rc.1` + 真实 pi-ai 1.3.0 + 真实 `openaiCompletionsApi`，挂一个注入的 `fetch` 截住线上 body，只切换适配器分支：

```
legacy 分支（修复前）→ roles ["user"],  system null,  tools 0
modern 分支（修复后）→ roles ["system","user"], prompt 原样, tools 1
```

### 5.1b 两份 pi-ai 副本并存 —— 谁跑哪一代（2026-10-17 补记）

追这一条时发现一个**结构事实**，它决定了这个缺陷到底影响谁：

`src/adapter.ts` 第 15–17 行是 **静态 import**——

```ts
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
```

所以**插件用的永远是「它自己解析到的那份 pi-ai」的 api**，而 `createModels`
（真正做归一化、也是把 provider 注册进去的那一层）是**宿主那一份**。两份副本
在宿主里可以不同代。

实测（真实 1.x 的 `createModels` + 真实 0.85.1 的 `createProvider`/api 混装）：

| 场景 | 1.x `createModels` 交给插件 api 的 context | 线上 body（**修复前**） | 线上 body（**修复后**） |
|---|---|---|---|
| 插件自带 **0.85.1**（本机现状：软链到本仓库，overrides 钉 0.85.1） | `messages[0].role === 'system'`（已归一化） | ✅ 正常（判 `legacy`，逆折回扁平 —— 0.85 读得懂） | ✅ 正常（同左，未变） |
| 插件也解析到 **1.x**（市场安装，无本地 0.85） | 同上 | ❌ `roles:["user"]`, `system:null`, `tools:0` | ✅ `roles:["system","user"]`, prompt 原样, `tools:1` |

**结论**：
- 本机这台（插件自带 0.85.1，`doctor` 报 `legacy (0.85.1)`）**从来没有坏过** ——
  它判 legacy 恰好是对的，因为它的 api 就是 0.85。
- 受害的是**市场安装**：插件自己解析到 1.x 时，修复前必然丢 prompt 与工具。
- 因此**本机无法用「发一条对话」复现这个 bug**，也无法用它证明修复 —— 本机能
  验证的只是「修复没有破坏它」。可复现的证据在 §5.1b 的表格里（两份真实副本
  混装实测），以及 `tests/fixtures/pi-ai-modern/` 的 4 条用例。
- 顺带解释了为什么 `tests/pi-ai-runtime.spec.ts` 那条「宿主注入 → modern」的
  默认值是安全的：它针对的是 `resolvedLocally: false` 的市场安装路径。

### 5.2 第一版测试为什么是错的（留档）

我第一版按参考文档写了「2×2 矩阵」（legacy/modern × 原始/已归一化），然后发现两格在 0.85 checkout 上红。第一反应是「测试写错了」，但**红的原因有两种可能**：

- (a) 我的折叠代码有 bug；
- (b) `modern × 已归一化 transcript` 在 0.85 上本来就非法。

实测分清了两者：0.85 的 `transformMessages` 对 transcript 会在 `assistantMsg.content.filter(...)` 处崩（`Cannot read properties of undefined (reading 'length')`），因为 0.85 的 `Message` 联合里**没有 system 变体**。所以 (b) 成立 —— 把「四种任意组合」写成期望通过，等于要求插件去实现一个不存在的形状。

最终拆成两套：
- `tests/adapter-outgoing-body.spec.ts` —— 只覆盖 **legacy** 世代（本 checkout 能跑真实 0.85 api）；
- `tests/fixtures/pi-ai-modern/` —— 独立装一份 **真实 pi-ai 1.1.0**，覆盖 modern 世代。

### 5.3 fixture 的安装

```bash
pnpm run fixture:pi-ai-modern     # = npm install --prefix tests/fixtures/pi-ai-modern
```

`node_modules/` 不进版本控制，所以干净的 checkout 里这 4 条用例会**跳过**（并打印原因），而不是静默通过。

---

## 六、证据来源

- 宿主版本：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/runtime.json` → `desktopVersion: 0.2.1-rc.1`
- 装机 pi-ai：从 `app.asar` 按原始 offset 提取 `dist/models.js` / `dist/api/openai-completions.js` / `dist/utils/transcript.js` 逐字阅读（asar 内无 `package.json`，版本由 `dsh-llm-pi-ai` 的 `dependencies: {"@earendil-works/pi-ai": "^1.1.0"}` 界定）
  - `dist/api/openai-completions.js` 里 `context.systemPrompt` / `context.tools` 出现次数均为 **0**
  - `dist/models.js` 的 `streamSimple` 第一行是 `const transcript = normalizeContext(context)`
- 宿主侧归一化调用点：`dsh-llm-pi-ai/lib/index.js:1763`（`models.setProvider(profile.piProvider)`）
- semver：npm `semver@7.8.5` 实算
- 账号池对照基准：`dsh-connect-workbuddy` 4.6.7 的 `src/account-pool.ts:434-457`、`src/index.ts:1491,1656-1661`
