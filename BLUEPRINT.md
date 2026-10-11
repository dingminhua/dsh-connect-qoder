# dsh-connect-workbuddy 架构蓝图（复刻向）

> 目标：把 WorkBuddy 连接器读成「一个 DSH 模型 provider 插件的最小完整骨架」，
> 供照着给 Qoder 做一个功能对等的插件。

---

## 1. 架构总览

### 1.1 模块依赖图（ASCII）

```
                            ┌──────────────────────────────────┐
                            │   DSH Host (cordis)              │
                            │  llm / settings / webServer /    │
                            │  attachments / client-ui-slots  │
                            └───────────────┬──────────────────┘
                                            │ inject / ctx.inject
        ┌───────────────────────────────────▼────────────────────────────────────┐
        │  src/index.ts   apply() — 装配中枢 / Config schema / 区域栈           │
        └───┬──────────┬─────────────┬──────────────┬──────────────┬─────────────┘
            │          │             │              │              │
   ┌────────▼───┐ ┌────▼──────┐ ┌────▼───────┐ ┌────▼────────┐ ┌───▼─────────────┐
   │ adapter.ts │ │ catalog.ts│ │ auth.ts    │ │ web-status  │ │ status-paths.ts │
   │ pi-ai 组装 │ │ 目录状态  │ │ 凭据存储   │ │ (同源路由)  │ │ 常量/DTO/解析  │
   └────┬───────┘ └───────────┘ └────┬───────┘ └─────────────┘ └─────────────────┘
        │                           │
        │ baseUrl() / token()       │ resolve() / credentialFor()
   ┌────▼──────────────┐      ┌─────▼────────────────────────────────────┐
   │ shim.ts (127.0.0.1)│─────▶│ upstream.ts  chat/refresh/models/credits  │
   │ RecoveryStream    │ HTTP │ probe.ts · account-pool*.ts · oauth.ts    │
   │ dsml-recovery.ts  │      │ transfer.ts · credential-recovery.ts      │
   └───────────────────┘      │ at-rest.ts（Windows 加密字段）            │
                              └───────────────────────────────────────────┘

  客户端半（浏览器）：src/client/index.tsx ──▶ WorkBuddyCard.tsx / AccountPool.tsx
                                          └──▶ ComposerCreditsGate ──▶ ComposerCredits
                          （共享 status-paths.ts 的常量与 DTO）

  辅助：pi-ai-runtime.ts（世代探测）· version.ts（构建期注入）· host-heartbeat.ts
  CLI ：bin.ts（doctor）    样式/文案：client/locales.ts · client/styles.ts
```

### 1.2 每个 src 文件一句话职责

| 文件 | 行数 | 职责 |
|---|---|---|
| `index.ts` | 1951 | 插件入口：`apply()` 装配双区域栈、注册 settings、导出 Config schema 与全部公共 API |
| `adapter.ts` | 438 | 用 `createProvider` + `openAICompletionsApi` 组装 pi-ai provider，包成 `PiAiAdapter`；模型描述符与 thinking 档位映射 |
| `upstream.ts` | 1270 | 上游 HTTP 客户端：`chatStream` / `probeChat` / `refreshToken` / `fetchModels` / `fetchCredits` / check-in；`prepareChatBody`；`classifyUpstreamError`；区域判定 |
| `shim.ts` | 1152 | 回环 OpenAI 兼容 HTTP 服务：安全加固、SSE 重写（`RecoveryStream`）、账号池故障转移循环 |
| `auth.ts` | 2030 | 桌面 App 认证文件探测、多账号发现、统一 vault、token 刷新、账号选择/轮换 |
| `catalog.ts` | 235 | 静态 fallback 目录 + `deriveCatalog`（选择 ∩ 目录 ∩ 上下文预算）+ `WorkBuddyCatalog` 可变目录 |
| `probe.ts` | 491 | 真实体积探测：请求体构造、429 解析与恢复时间、结果分类与脱敏 |
| `account-pool.ts` | 515 | 池成员结构、`exclusionOf` / `rankPool` / `effectiveMembersOf` / `resolveTargetModel` 纯逻辑 |
| `account-pool-run.ts` | 268 | 批量签到/测试的串行执行器（含间隔） |
| `account-pool-store.ts` | 159 | 探测测量的磁盘持久化（与「用户偏好」分离） |
| `web-status.ts` | 1448 | 把全部能力挂成 `ctx.webServer.register({kind:'exact'})` 同源路由 |
| `status-paths.ts` | 1007 | 路由常量、区域参数、跨 host/client 共享的 DTO 与配置读取helper（`regionEnabledOf`/`unwrapVolatileDeep`） |
| `dsml-recovery.ts` | 984 | 把模型吐出的标记语言还原成真正的 `delta.tool_calls`（解析规则） |
| `markup-diagnosis.ts` | 401 | 只读的标记残留诊断 |
| `at-rest.ts` | 726 | Windows 桌面 App 静态加密字段的密钥派生与解包 |
| `oauth.ts` | 339 | 扫码登录会话（start/poll），in-process |
| `credential-recovery.ts` | 154 | 被拒凭据后探测「换账号是否有用」 |
| `transfer.ts` | 221 | 账号批量导出/导入文件格式 |
| `web-server` 相关：`web-status.ts` | | 见上 |
| `pi-ai-runtime.ts` | 151 | 用 `import.meta.resolve` 探测本插件解析到的 pi-ai 世代（0.85 legacy / 0.87 modern），**不 import pi-ai** |
| `host-heartbeat.ts` | 175 | 写宿主心跳文件，供 `doctor` CLI 无浏览器判定宿主健康 |
| `version.ts` | 17 | 构建期 `define` 注入的包版本 |
| `bin.ts` | 335 | `dsh-connect-workbuddy doctor` CLI |
| `client/index.tsx` | 196 | 浏览器插件入口：locale 注册 + 两个卡片槽位 + composer 积分槽位 |
| `client/WorkBuddyCard.tsx` | 1518 | 设置卡片主体：区域 tab、账号选择、模型目录草稿、探测、账号池 UI |
| `client/AccountPool.tsx` | 1592 | 账号池表格/批量操作 UI |
| `client/ComposerCredits*.tsx` | 542 | 输入框工具行的积分读数与渲染 gate |
| `client/AccountTransfer.tsx` / `OAuthSignIn.tsx` / `BusyOverlay.tsx` | 740 | 导入导出、扫码登录、忙碌遮罩 |

---

## 2. provider 注册链路

### 2.1 从 `apply()` 到模型出现在 DSH 选择器

```
apply(ctx, config)
 │
 ├─(1) new WorkBuddyUpstreamClient(msg => ctx.logger.warn(msg))
 ├─(2) settingsNamespaceOf(ctx)  ← 关键
 ├─(3) for region of ['cn','global']:
 │        store = new WorkBuddyCredentialStore({region, desktopPath, refresh: c => client.refreshToken(c)})
 │        catalog = new WorkBuddyCatalog(region)
 │        shim = createWorkBuddyShim({store, client, catalog, logger,
 │                                   prepareAccount/failoverAccount/onAccountFailure})
 │        // 此时 server.listen(0,'127.0.0.1') 已发出，端口尚未可知
 ├─(4) settings 呈现：ctx.inject(['settings'], s => ctx.effect(() => s.settings.configure({auto:true}, ctx.fiber)))
 ├─(5) ctx.on('loader/volatile-update', () => applySelection(current()))
 ├─(6) applySelection(config)     ← 预热 store 选择 + catalog（用 fallback 目录）
 ├─(7) 异步 legacyAttributionRegion(...) → applySelection 二次应用
 └─(8) Promise.all(shims.ready).then(…)
        ├─ createWorkBuddyAdapter(...) ×2   ← 必须等端口，baseUrl 逐次读取
        ├─ registration.cn.adapter   = ctx.llm.registerAdapter(['workbuddy'],            adapter)
        ├─ registration.global.adapter = ctx.llm.registerAdapter(['workbuddy-global'],   adapter)
        ├─ registration.cn.directory = ctx.llm.registerConfigurableProviders([ {cn entry}, {global entry} ])
        ├─ ctx.effect(() => () => { 三个 release() })   ← 统一释放
        ├─ syncRegionRegistration(current())             ← 按 enabled 收敛
        ├─ ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => [...])
        ├─ writeHostHeartbeat()
        └─ 异步：fetchModels(credential) → deriveCatalog → catalog.set → adapters[region].invalidate()
```

### 2.2 三个 `@deepseek-ai/dsh-llm` 扩展点的用法要点

**（a）`ctx.llm.registerAdapter(providerIds, adapter)` → `AdapterRegistrationHandle`**

- 初始注册**必须非空**（空数组会抛 `INVALID_ADAPTER`）；之后 `handle.replace([])` 才是合法的「撤回但保持注册」路径。
- 每个 provider id 独立注册 ⇒ 每个区域一份完整 route set，`replace` 天然是「这一区域的全部路由」。
- handle 的释放必须挂进 `ctx.effect(() => () => release?.())`；若注册过程中插件被 dispose，`ctx.effect` 会抛，此时立即手动 release。

**（b）`ctx.llm.registerConfigurableProviders(entries[])` → `DirectoryRegistrationHandle`**

- 一次调用持有**全部** entry；`replace` 语义是「设置完整集合」，不是增量。
  因此按区域逐个 replace 会「最后一个赢家通吃」，必须**一次传入所有启用区域的完整数组**。
- entry 字段：`{ provider, displayName, settingsNs, settingsPath: [], declared: false }`。
- `settingsNs` 必须是宿主实际服务的命名空间（见下），宿主**精确匹配**查表 —— 猜错会让 provider 被判为「未配置」，配置入口与模型发现双双静默失效。

**（c）`ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => models[])`**

- 返回的 shape 是宿主发现目录的 DTO：`{ id, name, contextWindow, maxTokens, inputModalities }[]`；不需要的字段不返回（返回 `undefined` 字段会破坏形状假设）。
- `request.provider` 是宿主当前正在为哪个 provider 询问 → 用 `regionOfProvider()` 反查区域；不认识的 provider 返回 `[]`。
- 关闭的区域返回 `[]`（纵深防御，路由已撤回）。
- 这里返回的是**草稿目录**（`deriveCatalog(discovered, enabledModelIds, contextBudgets)` + 图像选择），用户点「保存」才落到 `lastCatalog`。

**（d）`settingsNamespaceOf(ctx)` —— 最容易踩的坑**

```ts
ctx.fiber.entry?.options.id  // Loader 条目 id，不是插件自选名
```
- 宿主 `describe()` 返回的 `ns` 就是这个 id；线上可能是 `include:dsh-connect-workbuddy`。
- 探测失败（无 Loader，如测试直接 `ctx.plugin()`）时回落到常量 `WORKBUDDY_SETTINGS_NS`。
- 客户端侧同理**不猜**：从 `configForms.describe().getSnapshot().view.namespaces` 里找匹配项，找不到再用声明值。

**（e）`resolveRetryPolicy(undefined, 'label')`** —— profile 必填字段，用宿主默认重试策略。

### 2.3 PiAiAdapter 组装（adapter.ts 核心）

```ts
createProvider({
  id: providerId, name: providerName,
  auth: { apiKey: { name, async resolve({credential}) {...} } },   // pi-ai 自己的 plane，实际不用
  models: buildModels(),                                            // 逐次读取 baseUrl
  api: withLegacyContext(openAICompletionsApi(), generation),        // generation 门控
})
// 关键：getModels 委托给「活读」，使目录刷新立刻生效
const provider = { ...base, getModels: () => buildModels() }

const profile: ResolvedPiAiProviderProfile = {
  provider, displayName,
  streamIdleTimeoutMs: 300_000,
  retryPolicy: resolveRetryPolicy(undefined, '...'),
  configuredMaxTokens: new Map(),
  modelErrors: new Map(),          // 空 = 没有已知坏模型（活读目录，不能预判）
  maxRequestImageBytes / requestImagePixelBudget / requestImageMaxBytes,  // 必填
  piProvider: provider,
}

new PiAiAdapter({
  profiles: () => profiles,        // Map；invalidate() 用「替换」而非「改」强制重建快照
  auth: INERT_AUTH,                // pi-ai 凭据生命周期全程 inert
  resolveApiKey: async () => shim.token(),   // ← 用 shim secret 当 apiKey
  resolveAttachments,
})
```

要点：
- **模型描述符**：`api: 'openai-completions'`，`baseUrl = shim.baseUrl() + '/v1'`（OpenAI SDK 会再拼 `/chat/completions`），`input` 由 `multimodal` 决定，`cost` 全 0（订阅额度无从定价），`reasoning` + `thinkingLevelMap` 由上游声明折叠（未声明的档位映射为 `null` = 不可用；`canDisableThinking !== true` 时 `off: null`）。
- **displayName** 带积分倍率后缀 `GLM-5.3 · x0.79`，但**所有 join 一律用 model id**，显示名只用于展示。
- **pi-ai 世代门控**（issues #24/#25/#26）：宿主给 0.87 时 transcript 是归一化形态（system 消息内含 prompt 与 `toolsAdded`），插件自带 0.85 的 api 读到会崩。`piAiRuntimeInfo()` 用 `import.meta.resolve` 找到实际解析到的那份 pi-ai 的 manifest 版本决定 `modern | legacy`；legacy 才包一层把 system 文本折回 `systemPrompt` 并**提升 `toolsAdded/toolsRemoved`** 回 `context.tools`。

---

## 3. 配置 schema 结构

### 3.1 Config 字段树

```ts
interface Config {
  authFile?: string                     // volatile
  accountId?: string                    // @deprecated 旧单槽
  accounts?: { cn?: string; global?: string }   // volatile；'' = 清除哨兵
  regions?: {                           // volatile，z.dict(regionStateConfig)
    [region]: WorkBuddyRegionState
  }
  lastCatalog?: WorkBuddyModelInfo[]     // @deprecated
  enabledModelIds?: string[]             // @deprecated
  imageModelIds?: string[]               // @deprecated
  contextBudgets?: Record<string, number>// @deprecated
}

interface WorkBuddyRegionState {
  enabled?: boolean                     // opt-out，默认 true；false → replace([])
  showCreditsInMainUi?: boolean         // opt-out，默认 true
  lastCatalog?: WorkBuddyModelInfo[]     // 上次刷新的完整目录（卡片显示 + 运行时推导的来源）
  enabledModelIds?: string[]             // 用户勾选；空 = 全目录
  imageModelIds?: string[]               // 图像输入显式 opt-in（唯一真相源）
  offModelIds?: string[]                 // thinking off 的 per-model 覆盖；缺键 = 用内建规则
  contextBudgets?: Record<string, number>
  pool: {                               // 全部是「用户选择」，测量数据不入 settings
    enabled?: boolean                    // opt-in，默认 false = 故障转移开关
    targetModelId?: string               // '' = 自动选零倍率模型
    probeInputTokens?: number            // 0/未知 → 实测默认 25000
    memberAccountIds?: string[]          // 显式 opt-in，默认空
  }
}
```

### 3.2 schemastery `z.object` 要点

- 声明式：`z.object({...})`，`.description()` 是**用户可见文档**（设置页直接展示），要写清取舍理由与默认行为；`.default(x)` 提供回落。
- **volatile 处理**：`0.1.7` 线把 volatile 值以「活引用」（cosmockit reference，形如 `{get(): T}`）交回。标记用能力探测而不是版本判断：

```ts
export function asVolatile<T>(s: z<T>): z<T> {
  return typeof (s as any).volatile === 'function' ? (s as any).volatile() : s
}
```
  - 不用手写 `meta.volatile = true`：那会绕过 schemastery 自己的 `validateVolatileSchema` 检查，产出旧线不认识的 schema。
  - 导出这个 helper 本身就是为了让「no-op 分支」在任意机器上可测。
  - **读取必须 unwrap**：单层读用 `unwrapVolatile(value.accounts)`；要把整份 config 交给 settings 服务时必须**深拷贝解包**（`unwrapVolatileDeep`），否则服务校验 + `structuredClone` 整对象时，报错形如 `$.authFile expected string but got [object Object]` —— 这是真实发生过的、让整张设置卡片消失的缺陷。
  - 客户端侧同样要 unwrap 再展开（展开活引用 = `{get: fn}`，会丢掉同级所有区域）。
- **opt-out vs opt-in 的选择**：所有新增开关都用 opt-out（`!== false`）以保证旧配置行为不变；会花钱/领奖的批量动作（账号池成员）用 opt-in（`=== true`）+ 默认空。
- **迁移而非删除**：旧单槽字段保留为 `@deprecated`，通过 `regionStateOf(config, region)` 读取 —— 只有当该区域无显式槽位时，扁平字段才被解释为 **cn** 区（`global` 永不继承，那正是「陈旧 CN 目录被与国际目录求交、用户勾选被静默丢弃」的 bug 根因）。
- 写入路径也要分清：卡片保存走「草稿→丢弃」语义，所以**测量数据必须存到 schema 之外**（`account-pool-store.ts`），否则一次保存会回滚定时器刚写入的结果。

---

## 4. 适配器要点

### 4.1 请求体准备 `prepareChatBody(raw: string): string`

纯字符串进、字符串出（在 shim 里对原始 body 调用）：

1. JSON.parse 失败 / 非对象 → 原样返回。
2. **强制 `stream: true`**（上游拒绝非流式）。
3. `developer` → `system`（DSH 用 OpenAI 新 `developer` role，上游以业务码 11128 拒绝）。
4. `ensureSystemHead`：首条不是 system 就 unshift 占位 system（`"You are a helpful assistant."`）。国际网关强制要求 system 打头，缺它一律 400/11128。
5. `normalizeToolChoice`：
   - `"none"` → 删 `tool_choice` 并**删掉 `tools`/`functions`**；
   - 对象形式 `{type:'auto'|'required'}` → 压成同名字符串；`{type:'function',function:{name}}` → 压成裸函数名（空名 → `'auto'`）；未知形态 → 删除；
   - 已存在的 `context.tools` 是权威，**不动**。
6. `declaredTools(prepared)` 从同一份 prepared JSON 取 `{names, requiredParameters, pinnedToolName}`，供 DSML 恢复判断「本请求声明过哪些工具」，`undefined` = 未声明（gate 3）。

### 4.2 SSE 流解析（shim `RecoveryStream`）

不是 `.pipe()`，因为要**在客户端看到 `delta.content` 之前**检查它。四条不可违反的约束：

1. **帧序永不改变**：按到达顺序转发；唯一自造的帧是流结束时补的那一帧。
2. **hold 是临时的、自偿的**：只有当目前为止的输出**全是标记**才缓存帧；一旦出现真实散文或真实 tool call，立刻按序 flush 并永久转为直通。普通回答零延迟、零丢弃。
3. **重试不得拼接两份答案**：`windowOpened` 之前的帧都没写过客户端，因此可以整体丢弃重来 —— 这把「流开始前失败可重试」的承诺扩展到「只能事后识别」的那一类（整轮只吐标记）。
4. **上游已说结构化调用时绝不臆造**：一旦出现原生 `delta.tool_calls`，本次响应剩余部分**永久关闭**恢复（避免两条调用通道并存）。

帧内处理要点：
- 携 `finish_reason` 的帧在转发前必须先 `drainBuffer()`（尾部内容逻辑上在终止符之前，否则按 `finish_reason` 停收的客户端会丢尾巴）。
- 空 `delta.content` + 有 `finish_reason` → 先排空缓冲。
- 恢复出的调用走 `callsFrame`：`{index, id, type:'function', function:{name, arguments}}` 且 `finish_reason: 'tool_calls'`（不设它会让「等 reason 再执行」的客户端永远不执行）。
- 重试路径：`writer.discard()` 丢弃 hold，再起一个新 `RecoveryStream`。

### 4.3 工具调用回传

- **DSML 恢复**是本项目的主要工具调用来源：`dsml-recovery.ts` 把模型吐的标记还原成 `RecoveredToolCall[]`，由 `RecoveryStream` 帧化成 OpenAI 形状。
- 三道 gate（声明了哪些工具 / 必填参数 / 是否被 pin 到单个工具）由 `declaredTools()` 提供，越界的恢复一律拒绝。
- 上游原生支持时不做任何恢复（见约束 4）。

### 4.4 错误分类与映射

```ts
type UpstreamErrorKind =
  | 'hard_credit'   // 402 或额度不足标记（中英文各 7 条）
  | 'soft_rate'     // 429
  | 'session_dead'  // 'Offline user session not found' / 12153
  | 'policy_reject' // 'request illegal' / '"code":11140'
  | 'not_found' | 'server' | 'client'
```

`classifyUpstreamError(status, body)`：先 402，再按标记表（注意中文标记要在**原串**上匹配、大小写不敏感表在 lower 串上匹配），最后按状态码兜底。

shim 侧两张映射表：

| kind | HTTP | `error.code` |
|---|---|---|
| `hard_credit` | 402 | `hard_credit` |
| `soft_rate` | 429 | **`quota_exceeded`** |
| `session_dead` | 401 | `session_dead` |
| `policy_reject` | 403 | `policy_reject` |
| `not_found` / `server` | 502 | 原样 |
| `client` | 400 | 原样 |

**`code` 是宿主分类的唯一通道**：DSH 靠 `type + code + message` 里的英文短语判定「是否原地重试（5 次退避）」还是「交给跨 provider failover」，只有 `RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE` 在原地重试集里。上游 429 的文案是中文（「将在 … 重置」，几小时后），短语分类器看不出来，所以必须用 `quota_exceeded` 这个词把「要等很久」和「等两秒」区分开，而 **HTTP 状态仍保持 429**（那是上游真实返回的）。`type` 保留插件自己的 kind 供人读日志。

**凭据被拒（独立类）**：`WorkBuddyCredentialRejectedError`，用 `code = 'WORKBUDDY_CREDENTIAL_REJECTED'` 标记而非 `instanceof`（打包后可能跨模块实例）。触发点：401/403 且响应体是 HTML（openresty/APISIX 边缘拒绝）；JSON 信封的 401/403 也映射到同一个类。含义是「换重登才有意义」，与瞬时故障完全不同，卡片绝不能混淆。

**限流/凭据拒绝的处理链**：
1. `chatStream` 返回 `{ok:false, kind, status, message, detail}`；
2. `isFailoverWorthy(kind)` = `kind !== 'client'`（400 是请求本身坏，换账号只会同样 400）；
3. 进入故障转移循环：调 `failoverAccount(triedIds)`（策略在插件侧），**每个候选之间等 2s**（上游按请求量限流，零间隔重试会集体撞墙），可中断（`controller.signal`）；
4. 每个失败尝试都记一次测量（包括**最后一次**失败 —— 那才是最该被下次请求避开的账号）；`controller.signal.aborted`（用户关面板）时**不记**（否则本地 abort 会被当成账号坏了）；
5. 全部失败 → `writeOpenAIError` + 附「已尝试 N 个账号」；`policy_reject` 单独一条文案，带上 `displayMsg` 与 `requestId`（这是唯一需要用户看原文的失败）。

---

## 5. loopback shim 要点

### 5.1 为什么 token 不能直接给 pi-ai

- pi-ai 走 `openAICompletionsApi`，也就是 **OpenAI SDK**；它只认 `baseUrl + /chat/completions` 与 `Authorization: Bearer <apiKey>`。要接上游必须能自由改 base、改头、改请求体。
- 上游有一堆 OpenAI 规范之外的要求：强制 `stream:true`、`tool_choice` 必须是字符串、CLI 形态头（`X-No-User-Id` / `X-Domain` / `X-Product`）、每账号不同 token、区域不同 base。
- 让插件把真实 token 交给 pi-ai，等于把凭据交给一个「环境凭据发现 / 持久化」机制（pi-ai 的 `CredentialStore` 会存它、`AuthContext.env()` 会从环境变量读它），凭据的传播边界就散了。
- 所以：**pi-ai 只拿一个进程内随机 secret**（`resolveApiKey: () => shim.token()`），shim 自己通过 `store.resolve()` 拿真实凭据并注入上游头。secret 永不出进程、也永不上游。

### 5.2 路由与挂载

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/healthz` | `{ok:true}` |
| GET | `/v1/models` | 从 `catalog.current()` 列出 id |
| POST | `/v1/chat/completions` | 主路径：prepare → 故障转移 → SSE 重写 |
| 其他 | — | 404 |

挂载方式：`createServer(handler)` + `server.listen(0, '127.0.0.1')`（**端口 0 = 由内核分配**）。返回 `{ ready, baseUrl(), token(), close() }`；`baseUrl()` 每次重新读 `server.address()`，所以 adapter 的模型描述符逐次构建时才能拿到最终端口。**装配顺序固定为：先起 shim，`await shim.ready`，再造 adapter。**

`close()`：`server.close()` + `server.closeAllConnections()`。

### 5.3 安全模型（四重入站校验）

```
Host header  必须指向回环（防 DNS rebinding：攻击者域名解析到 127.0.0.1，Host 却是自己的域名）
Origin       若存在必须回环（非浏览器客户端不发 Origin，直接放行）
bearer       常量时间比对（timingSafeEqual + 先比长度）
chat POST    Content-Type 必须是 application/json（挡 simple-request CSRF）
```
- 绑定 `127.0.0.1` 而非 `0.0.0.0`；secret `randomBytes(32).toString('base64url')`，只存在内存；错误体一律 OpenAI 形状 `{error:{message,type,code}}`。
- body 上限 64 MiB，超限 destroy。
- 四个校验必须在路由判定**之前**执行 —— 否则 `/healthz` 也会被拿来探活。

### 5.4 客户端断连的取消

**必须监听 `res.on('close')`，不能监听 `req.on('close')`**：`readBody` 读完请求流后 Node 立刻发 `req` 的 `close`（之后注册的监听器永不触发；之前注册的会立刻触发并中止一切）。`res` 的 `close` 才对应真正的 socket 拆除。

---

## 6. 账号/凭据体系

### 6.1 认证文件探测策略（优先级从高到低）

1. `config.authFile`（volatile，需 unwrap）；
2. 环境变量 `WORKBUDDY_AUTH_FILE_ENV`；
3. 平台默认目录（`defaultDesktopAuthDirs(platform, home, env)`，三参数可注入以便跨平台测试）：
   - darwin：`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth`
   - win32：`%LOCALAPPDATA%` 与 `%APPDATA%` 两条（env 优先，回落 home 派生）
   - linux：`$XDG_CONFIG_HOME` 或 `~/.config` 下的同名目录

**显式路径只 pin 住「目录」而不是「文件」**：同级 `*.info` 时间戳备份照样扫描（用户显式指定路径时仍应能切账号），只是文件排序变了。

### 6.2 多账号发现（`scanAll`）

```
candidateFiles()  = 显式路径 + 其 *.info 备份（按文件名倒序=最新在前）
        ↓ 每个文件独立读，失败跳过（坏文件不能遮蔽其他）
parseWorkBuddyAuth(file, atRestKey)  → credential | undefined
        ↓ 区域过滤 matchesRegion(domain)
        ↓ dismissed 过滤（两处：扫描入口 + syncVault 写回）
按 workbuddyAccountId(credential) 去重，live file 优先于 backup，backup 间按签发时间新者胜
        ↓
readOwns()（插件自己的 vault）合并
        ↓
syncVault(scan, dismissed)：把扫描结果增量写进 vault（只在更优时写；mtime 稳定）
        ↓ 并把 vault 条目合回可读集合（OAuth 加进来的账号没有桌面文件，靠这条路留存）
Object.freeze([...byId.values()])   ← 冻结：多个调用方共享同一数组
```

- `readAll()` 用 `scanInflight` + 时间窗共享扫描（并发/重复读只扫一次 FS），**失败的扫描不缓存**（下一次重试）。
- 默认账号 = `preferred()` = 最fresh（即跟随 App 当前登录），**不是按积分自动选**。
- `accounts()` 返回**无 token** 的列表（`id/accountName/domain/source/tokenExpiresAtMs/filePath/selected`）；显式选择若匹配不到任何本地账号，则**谁都不标 selected**（不静默回退）。
- Windows：字段可能是 `{$wbEncrypted:1,envelope}` 包装，`credentialField()`/`optionalCredentialField()` 用 `at-rest.ts` 的派生密钥打开；取不到密钥时加密字段解析为 `undefined` 而非伪造值。`phoneNumber` 永不读（隐私）。

### 6.3 token 刷新

- `resolve()` = `current()` + 必要时刷新：`needsRefresh()` 按 `expiresAtMs - refreshMarginMs` 判断，命中则 `refreshNow()`。
- 刷新只走 `upstream.refreshToken(credential)`（`X-Refresh-Token` 头**只出现在刷新请求**，chat 请求绝不携带 refresh token —— 这是安全红线）。
- 刷新结果写回 vault 条目并记 `refreshedFrom = <被刷新的文件名>`；该字段在下次扫描时让「插件刷新的副本」压过「App 的实时文件」，避免每次启动都重新刷新（用名字相等而非时间戳，这是双时钟比较表达不了的第三种状态）。
- **读凭据的两条路必须分清**：
  - `credentialFor(id)` —— 取任意账号的凭据，**不动选择**（批量测试/池排名/卡片表格用）
  - `resolve()` —— 取「当前要计费的那个」，**会**改运行态选择（请求路径用）
- `setRotatedAccount(id)` 是池的运行态覆盖，**不写 settings**；池关闭时清空覆盖，用户选择原样回来。

### 6.4 区域隔离（cn / global 双 provider 并行）

四层隔离，缺一层就会串账：

1. **provider id**：`workbuddy` vs `workbuddy-global`，各自独立 `registerAdapter`。
2. **配置**：`regions.cn` / `regions.global` 两套目录与勾选；切换账号不影响另一区。
3. **运行时栈**：每个区域一套 `{store, catalog, shim}`，各自独立端口。
4. **凭据**：`regionOf(domain)` 从凭据的登录域推导区域；`matchesRegion()` 让一个区域的 store **看不见**另一个区域的账号（选账号、刷新、状态查询全部隔离）。国际账号在 `codebuddy.ai` 与 `workbuddy.ai` 两个品牌域下，网关不通用，因此 base 也跟着 `domain` 走。

**区域关闭**：`regionState.enabled === false` → `adapter.replace([])` + directory `replace([仅启用区])`。只隐藏卡片 tab 不够 —— 模型仍会在选择器里可选。

**区域空账号**：`catalog.setRegionUsable(accounts().length > 0)`，没有本地登录的区域不广告任何模型（否则是一排必定 401 的行）。DSH 会过滤掉 `models.length === 0` 的 provider 组，正好自动隐藏。

**目录三段回落（issue #32）**：`state.lastCatalog?.length ? → liveModels.length ? → fallbackModelsFor(region)`。保存槽位丢了目录时必须降到「实时目录」而不是「静态列表」，否则 `applySelection` 会把实时发现的模型全删掉。

---

## 7. 客户端卡片

### 7.1 挂载方式（`src/client/index.tsx`）

```ts
export const inject = ['slots', 'locale']          // 只声明两条线都有的服务
export function apply(ctx) {
  try {
    ctx.effect(() => ctx.locale.register('settings.workbuddy', { zh, en }))
    const t = ctx.locale.bind('settings.workbuddy')
    const softGet = name => ctx.get(name)           // 关键：属性访问未声明服务会 THROW
    const forms = softGet('configForms')            // 0.1.7 的客户端设置面
    // 从 forms.describe().getSnapshot().view.namespaces 里找出宿主真正服务的 ns
    const settingsScope = forms?.get(ns)
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({name, key, priority:30, inject: () => ({t, settingsScope})}, WorkBuddyCard))
    ctx.slots.inject('plugins.row.config',    () => ctx.slots.register({...}))
    ctx.slots.inject('conversation.input.left', () => ctx.slots.register({name:'conversation.input.left', id, order:4, locale: ns, inject}, ComposerCreditsGate))
  } catch (error) { console.error('[...] card failed to load (host provider unaffected):', error) }
}
```

要点：
- **整个 `apply` 包 try/catch**：槽位 API 变更时降级为 console.error，**绝不能让整个 client bundle 加载失败**（否则宿主出现 "Failed to load plugins" 红色横幅，连 provider 服务都受牵连）。
- 每个槽位**单独** try/catch：一个槽位注册失败不得拖垮其他槽位。
- `inject` 里只声明跨线共有的服务；`configForms` / `settingsScope` 一律走 `softGet()` 软探测 —— Cordis 的依赖门是硬的，声明一个运行时不提供的服务会让 `apply` 永远不执行。
- **settings 命名空间**：客户端不猜宿主用哪个 ns，从 `configForms.describe()` 里**问**，用 `/workbuddy/i` 子串匹配（entry id 由宿主定，可能是 `include:` 前缀），失败回落声明值。浏览器侧同样要 `unwrapVolatileDeep(scope.getSnapshot().value)` 再读字段。
- 构建：`package.json` 的 `dsh.client.inject` 列出四个客户端包；tsdown 把 client 打成 **CJS**，banner/footer 包成 `window.__ModuleLoader__.load({id, factory})`，`react` / `react-dom` / `react-dom/client` / cordis / 客户端 DSH 包全部 `neverBundle`（**react-dom 必须外置**，否则内联的 dev/prod CJS 顶部 `process.env.NODE_ENV` 在浏览器直接抛，整个客户端半边导不进来）。

### 7.2 tab 结构与主要交互（WorkBuddyCard）

- 顶部 **「国内版 / 国际版」tab 栏**，每个 tab 对应**一个完整 provider 栈**；切 tab **不丢**另一侧未保存的草稿（`drafts: Partial<Record<region, Draft>>`）。
- 每个 tab 自带：provider 开关（`enabled`）、侧边栏积分行开关（`showCreditsInMainUi`）、健康状态点（按 usage 文档着色）。
- tab 上的区域状态点即使没点开也刷新（两个区域都拉，不是只拉 active）。
- 区域关闭时 tab 内容替换成一条说明文案，而不是把整张卡片变灰。
- 状态数据来源（全部同源 fetch，带 `?region=`）：

| 路径 | 用途 |
|---|---|
| `/plugins/dsh-connect-workbuddy/usage` | 登录态、积分、账号列表、区域开关、目录与选择 |
| `.../account-credits` | 每账号余额（**仅在面板打开时**才拉） |
| `.../models/refresh` | 从上游刷新目录（草稿，不直接生效） |
| `.../accounts/refresh` | 重新扫描本机登录 |
| `.../probe` | 对指定模型做真实体积探测 |
| `.../pool` + `?action=…&accountId=…` | 账号池批量签到/测试/移除 |
| `.../oauth` | 扫码登录 start/poll |
| `.../transfer` | 批量导出/导入 |

### 7.3 ComposerCredits 输入框读数的注入点

用的是 `conversation.input.left`（**per-session 的列表槽**），不是 `sidebar.footer.action`（**root 级单共享行**，两个连接器插件各占一行会互相挤压）。

判定链（`ComposerCreditsGate`，可单测、不依赖宿主）：

```
useProjection('modelSelection')            ← 宿主计算的投影（插槽注入的 hook）
  selectedProviderOf = projection.next ?? projection.lastUsed   ← next 优先（已选未发也是当前选择）
  WORKBUDDY_COMPOSER_PROVIDERS[provider] → region               ← provider 归属判定与区域选择是同一个查找
  regionCreditsShownOf(unwrapVolatileDeep(scope.getSnapshot().value), region)  ← opt-out
  regionEnabledOf(..., region)                                      ← 关闭区不画
undefined → return null（不渲染、不启动 fetch 循环）
```

渲染体（`ComposerCredits`）：
- 读数形态 `WB CN · 1,072`（标明是 WB CN 还是 WB AI），**本身没有任何控件**（这一行与 shell 自己的权限/agent/模型控件共享，每多一个控件都在抢空间）。
- 点击弹出**锚定面板**（`createPortal` + `useAnchoredPosition` + `useDismissOnOutsidePointer`），面板里才是账号表格，点行即切账号；刷新按钮在面板里。
- 定时刷新 5 分钟；失败时**保留上次数值**；某账号余额读不到显示 `—`，**绝不显示 `0`**（端点在该情况下省略字段，正是为了让组件不能给出错误断言）。
- 样式在模块加载时幂等注入 `<head>`（卡片 CSS 只在设置卡片渲染时才加载，而宿主上卡片不一定被渲染）。

**用到的 DSH client 注入点清单**：`locale.register/bind` · `slots.inject` · `slots.register`（卡片两种：Plugins tab 的 bundle 行 / 插件列表行；composer 一种）· `configForms.describe().getSnapshot().view.namespaces` · `configForms.get(ns)` → `settingsScope`（`getSnapshot().value` + `subscribe`）· 槽位注入的 `useProjection('modelSelection')`。

---

## 8. 可复刻性清单

### 8.1 产品特有（必须重写）

| 项 | WorkBuddy 的具体内容 | 换 Qoder 要做什么 |
|---|---|---|
| 上游 base 与路径 | `copilot.tencent.com` / `www.workbuddy.ai` / `www.codebuddy.cn`；`/v2/chat/completions`、`/v2/enterprises/personal/models`、`/v3/config`、`/v2/plugin/auth/token/refresh`、`/v2/billing/meter/*` | 换成 Qoder 的 chat completions / 模型目录 / 积分 / 刷新端点 |
| 请求头约定 | `X-User-Id` / `X-No-User-Id` / `X-Enterprise-Id` / `X-Domain` / `X-Product: SaaS` / CLI 或 Desktop UA（UA 决定服务端返回哪份目录！） | 抓一次真实请求照抄 |
| 认证文件格式 | `CodeBuddyExtension/Data/Public/auth/*.info`，`{auth:{...},account:{...}}` 或扁平形态，`expiresAt` 秒/毫秒混用 | 定位 Qoder 桌面 App 的凭据文件并写 `parseQoderAuth` |
| 域 → 区域映射 | `workbuddy.ai`/`codebuddy.ai` → global；`workbuddy.cn`/`codebuddy.cn`/`copilot.tencent.com` → cn | 若 Qoder 单区域，`WorkBuddyRegion` 可退化为单值（见 §8.4） |
| `prepareChatBody` 的 wire 修正 | 强制 stream、developer→system、tool_choice 压平、补 system 头 | 大概率可删；上游若规规矩矩，这三处都不需要 |
| 静态 fallback 目录 | 两份手抄的模型名单 | 从 Qoder 目录接口抓一次 |
| 积分 / 签到 / 套餐 / 倍率 | `CapacityType 4` 月度包、签到连击、`x0.79` 倍率 | Qoder 的积分查询；没有签到就删掉那条路由与 UI |
| DSML 标记恢复（`dsml-recovery.ts` + `RecoveryStream`，~1900 行） | 上游模型常吐私有标记而不发结构化 tool_calls | **先验证 Qoder 上游是否已发原生 `delta.tool_calls`。若已发，整块可删**，只需保留直通式 SSE 转发 |
| Windows 静态加密字段（`at-rest.ts`，726 行） | `{$wbEncrypted:1,...}` + 从 App 可执行文件派生密钥 | Qoder 若明文存储，整块可删 |
| OAuth 扫码登录（`oauth.ts`） | Qoder 若无此流程则删 | 可选 |
| 账号批量导入导出（`transfer.ts`） | 自定义文件格式 | 可选，复用骨架 |
| 中文错误标记表 | `积分不足` / `Offline user session not found` / `request illegal` 等 | 按 Qoder 实测错误体重写 |

### 8.2 DSH 插件骨架（几乎可原样复用）

- **装配顺序**（先 shim.ready → 再 adapter → 再 registerAdapter/ConfigurableProviders → 最后异步刷新目录）与全部释放路径（`ctx.effect(() => () => release?.())` + 注册中 dispose 的兜底）。
- **`settingsNamespaceOf(ctx)` 探测 + 客户端 `configForms.describe()` 反查**这一对「不要猜 ns」的机制。
- **`applySelection` / `configuredModels` / `displayModels` 三段回落**（issue #32）与 `withImageSelection` / `withEffectiveOff` 的「用户显式选择是唯一真相源」原则。
- **`WorkBuddyCatalog` 的 usable/enabled 双闸门**（无账号不广告 / 用户关闭不广告）+ `setRegionUsable` 返回是否变化以便跳过 invalidate。
- **整个 shim 的安全模型**：随机端口、进程内 secret、常量时间比对、Host/Origin/Content-Type 三重入站校验、`res.on('close')` 取消、body 上限、OpenAI 形状错误体。
- **`KIND_STATUS` / `KIND_HOST_CODE` 双表**与「`code` 是宿主分类唯一通道，`type` 留给人读」的设计；`soft_rate → quota_exceeded` 的具体取值可按 Qoder 语义重挑。
- **`UpstreamErrorKind` 七分类 + 标记表 + `WorkBuddyCredentialRejectedError`（按 code 而非 instanceof 标记）**。
- **`applyPoolSelection` / `failoverAccountFor` / `recordAccountFailure` 的池策略**：per-request 借用而非改用户选择、每次尝试间可中断的 2s 间隔、最后一次失败也记测量、abort 不记、`localPoolMembers`（请求路径零网络）+ `poolMembersOf`（卡片路径才拉积分）二分。
- **`probe.ts` 的方法论**（结论随产品变、方法不变）：发真实体积请求、按体积限流这个洞察、`Retry-After` → 上游文案 → 配额刷新点三源冷却时间（顺序与 `retrySource` 标注）、**没有时间就说没有、绝不编造**、`redactUpstreamText` 在捕获点脱敏。
- **`schemastery` 用法**：`asVolatile` 能力探测、`unwrapVolatile` / `unwrapVolatileDeep`、opt-out vs opt-in 的取舍、deprecated 字段的 `regionStateOf` 迁移读取、偏好与测量分离（`account-pool-store`）。
- **客户端全部骨架**：`slots.inject` + `register`（两卡片槽 + `conversation.input.left`）、`locale.register/bind` + `declare module` 增强 `LocaleNamespaceMap`、软服务探测 `softGet`、整段 try/catch 降级、`configForms` 反查 ns、`useProjection('modelSelection')` gate、`createPortal` 锚定面板、幂等 CSS 注入。
- **构建**：tsdown 双 target（node ESM + browser CJS `__ModuleLoader__` 包装）、`react-dom` 必须外置、构建期 `define` 版本。
- **测试策略**（`tests/` 66 个文件）：纯函数全钉死（`deriveCatalog`/`classifyUpstreamError`/`prepareChatBody`/`parseRetryAfter`/`rankPool`…）；shim 用**裸 socket 写**测 Host 头（`fetch` 会覆盖 Host 头，测不了 DNS rebinding）；adapter 测试 **mock 掉 stream API 并记录收到的 context**，否则纯函数测试在 `withLegacyContext` 被删掉时仍然全绿（变异体复原 #24）；React 测试用 jsdom + 渲染断言；`client-fallback.spec.ts` **镜像复制** `client/index.tsx` 的 try/catch 形状（因为真入口在 Node 下导不进浏览器专用 DSH 包）。

### 8.3 换一个上游产品的最少改动集

前提：该产品有 ①本地登录凭据 ②OpenAI 风格 chat completions（含 SSE）③模型目录 ④积分查询。

**必改（4 个文件）**

1. `src/upstream.ts` —— 端点、base、请求头、`prepareChatBody`（大概率删空实现保留函数以免改 shim）、`classifyUpstreamError` 的标记表、`fetchModels` 的目录路径与解析（`parseUpstreamModel` 的字段名）、`fetchCredits` 的响应解析、`refreshToken`。**若上游已发原生 `tool_calls` 且请求体合规，`RecoveryStream` 可以退化成纯转发，`dsml-recovery.ts`/`markup-diagnosis.ts`/`native-modality.ts` 整个删掉。**
2. `src/auth.ts` —— `parseWorkBuddyAuth`（Qoder 凭据文件形状）、`defaultDesktopAuthDirs`（Qoder 的存储路径）、`WORKBUDDY_LIVE_FILENAME`、`workbuddyAccountId`（若 Qoder 有稳定 uid 就用它，比哈希更好）。`at-rest.ts` 若明文则删。`oauth.ts`/`transfer.ts` 无需求则删。
3. `src/catalog.ts` —— 静态 fallback 名单（抓一次真实目录）+ 字段映射。
4. `src/index.ts` —— provider id/显示名、`WORKBUDDY_PROVIDERS` 映射、`apply()` 里 `fetchModels` 后的 stamp 链、`cordis.patch.yml` 与 `package.json` 的插件 id、`registerModelDiscovery` 的返回映射。

**必改（1 个客户端文件）**：`src/client/WorkBuddyCard.tsx`（文案、字段、路由调用）；`status-paths.ts` 的路径常量与 DTO 类型。

**大概率可删**：`dsml-recovery.ts` `markup-diagnosis.ts` `at-rest.ts` `oauth.ts` `transfer.ts` `account-pool*.ts` `credential-recovery.ts`（约 **4000+ 行**），连带 `AccountPool.tsx` `AccountTransfer.tsx` `OAuthSignIn.tsx` 与对应路由。

**必须原样保留**：`adapter.ts` 的组装骨架（去掉 legacy context 折叠后可简化到 ~150 行）、`shim.ts` 的安全/路由/failover 骨架（去掉 RecoveryStream 后 ~350 行）、`index.ts` 的注册链路与 volatile/schema 治理、全部客户端槽位挂载。

**改动量估算**：保留骨架 ~3500 行（其中 1200 行是 index.ts 的装配与 schema 治理、1150→350 的 shim、196 的 client 入口），重写 ~1500 行，删除 ~4000 行。

### 8.4 单区域产品的简化

若 Qoder 只有单一区域，最省事的做法**不是删区域维度，而是把 `WorkBuddyRegion` 换成单值 `'cn'`**：这样 `index.ts` 里的区域循环、`syncRegionRegistration`、客户端 tab、草稿隔离等全部逻辑原样跑通，将来要加国际版时零改动回填。删维度会同时删掉 `regions` 分区、`accounts` 分区、tab 隔离、以及那个「陈旧目录求交」的 bug 的全部防线。
