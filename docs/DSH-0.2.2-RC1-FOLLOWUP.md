# DSH 0.2.2-rc.1 升级跟进调研 —— dsh-connect-qoder

> 调研日期：2026-11-05
> 宿主：DSH Desktop `0.2.2-rc.1`（`runtime/primary-runtime/runtime.json` → `desktopVersion`）
> 插件：`@dmh2002/dsh-connect-qoder` **1.17.5**（未改代码）
> 上一轮：[`docs/DSH-0.2.1-RC1-FOLLOWUP.md`](DSH-0.2.1-RC1-FOLLOWUP.md)
> 基线：本机 0.1.7 依赖树 `1221 passed / 8 skipped`；0.2.2 依赖树 `1216 passed / 5 failed / 8 skipped`

---

## 零、结论摘要

**结论：需要适配 —— 且已在 2026-11-05 同一轮内落地（见 §九）。** 与上一轮「0.2.1-rc.5 不需要任何运行时代码改动」不同，0.2.2-rc.1
在插件**直接构造**的两个宿主对象上加了必填字段、给 pi-ai 的 api 加了品牌类型，
因此 `pnpm run typecheck` 会红；另外 peer 范围在 npm 语义下**不覆盖** `0.2.2-rc.1`。

但**不是** 0.2.1 那种「静默丢工具」级别的运行时事故：真实宿主栈（pi-ai 1.3.0）上
modern 直通路径实测**正常**，提示词与工具都在。

| 层 | 结论 | 所需动作 |
|---|---|---|
| `ResolvedPiAiProviderProfile` 新增两个必填字段 | 🔴 typecheck 失败 + 运行时丢「单请求图片条数上限」 | **改代码**（P0-1） |
| pi-ai 1.3.0 的 `TranscriptContext` 品牌类型 | 🔴 typecheck 失败（仅 legacy 分支） | **改代码**（P0-2） |
| `ctx.locale.register` 签名加宽 | 🔴 客户端 typecheck 失败 | **改代码**（P0-3） |
| peer 范围覆盖 `0.2.2-rc.1` | 🔴 npm/pnpm 语义判 false（宿主门禁判 true） | **改声明**（P1） |
| 测试树仍钉 0.1.7 线 | 🟡 本轮「没测到真宿主」的根因；升线后 5 条用例必红 | **改测试**（P2） |
| 中途 system 消息改写成 user reminder | 🟡 行为相对 0.2.1 变了，不报错 | 需实测后决定（P3-1） |
| 宿主默认窗口/输出上限改值 | 🟢 插件逐模型显式给值，预计无影响 | 确认即可 |
| `llm/models-updated` / `settings.section.icon` / 6 种新语言 | 🟢 新能力，非必需 | 可选增强 |

---

## 一、实测环境（先钉事实）

宿主 `app.asar` 内 `/dsh/node_modules` 的实际版本：

| 包 | 0.2.1-rc.5 | **0.2.2-rc.1（本机）** |
|---|---|---|
| `@earendil-works/pi-ai` | 1.1.0 | **1.3.0** |
| `@deepseek-ai/dsh-*` | 0.2.1-rc.5 | **0.2.2-rc.1** |
| `@deepseek-ai/cordis` | 4.0.x（peer `~4.0.5`） | **4.1.0**（peer `~4.1.0`） |
| `@deepseek-ai/schemastery` | 3.18.5 | **3.19.0** |

插件的**开发树**仍钉在 0.1.7 线（`pnpm-workspace.yaml` overrides：`dsh-* 0.1.7-rc.1`、
`cordis 4.0.2`、`schemastery 3.18.4`、`pi-ai 0.85.1`）。这意味着 1.17.5 的
`pnpm run typecheck` / `pnpm test` **从未对着 0.2.2 的声明跑过** —— 本轮所有
破坏都是这样漏出来的。

复现方法（不污染主仓）：

```bash
rsync -a --exclude node_modules --exclude .git ./ /tmp/qoder022/
cd /tmp/qoder022
# overrides 改成 0.2.2 线：dsh-*→0.2.2-rc.1、cordis→4.1.0、schemastery→3.19.0、pi-ai→1.3.0
rm -f pnpm-lock.yaml && pnpm install --no-frozen-lockfile
npx tsc -p tsconfig.json --noEmit      # 3 处
npx tsc -p tsconfig.client.json --noEmit  # 再加 1 处
npx vitest run
```

---

## 二、P0：会让类型检查失败的四处

### P0-1 · `ResolvedPiAiProviderProfile` 新增两个必填字段

`src/adapter.ts:506` 手工拼装的 profile 缺 `maxRequestImages` / `imageOffloadCountQuantum`：

```
src/adapter.ts(506,9): error TS2739:
  Type '{ piProvider: Provider<Api>; maxRequestImageBytes: 20971520; … }'
  is missing the following properties from type 'ResolvedPiAiProviderProfile':
  maxRequestImages, imageOffloadCountQuantum
```

宿主 0.2.2 在 `dsh-llm-pi-ai` 里新增了「**单请求图片条数上限**」（对齐 Azure OpenAI
的 50 张），并在 `resolveProfile` 里默认化：

```js
// dsh-llm-pi-ai 0.2.2 lib/index.js:1134-1137
const maxRequestImages = source.maxRequestImages ?? 50;
const imageOffloadCountQuantum = source.imageOffloadCountQuantum ?? Math.min(10, maxRequestImages);
```

**运行时后果**：`PiAiAdapter` 直接读 `profile.maxRequestImages`（`lib/index.js:2018`），
插件传的是 `undefined` → 该路由**静默失去**条数上界，只保留原有的
`maxRequestImageBytes`（20MB）。宿主自己的路由有 50 张的界，Qoder 路由没有。

**修法**：在 profile 里显式补两个字段，与宿主默认对齐：

```ts
maxRequestImages: 50,
imageOffloadCountQuantum: 10,   // = min(10, 50)
```

（若 Qoder 网关实测能吃更多图，再按实测值上调；但**不要**留空。）

### P0-2 · pi-ai 1.3.0 给 api 上下文加了品牌类型

`src/adapter.ts:443-444` 的 legacy 适配层把普通 `Context` 交给 `api.stream`：

```
src/adapter.ts(443,60): error TS2345: Argument of type 'Context' is not assignable
  to parameter of type 'TranscriptContext'.
  Property '[transcriptContextBrand]' is missing…
```

pi-ai 从 1.3.0 起把 `api.stream/streamSimple` 的入参声明为品牌化的
`TranscriptContext`（规范化后的 transcript），这与插件自己在 1.1.x 时实测出的
「1.x 的 api 只读 messages」结论一致 —— 品牌类型只是把它写进了类型系统。

**影响面**：**只有 legacy 分支**。宿主 0.2.2 跑 pi-ai 1.3.0，
`generationOf()` 判 `modern`，`withLegacyContext` 直接透传，
**不经过** `adaptLegacyPiAiContext`。所以这是纯编译期问题。

**修法**：在 legacy 分支内做一次收窄/断言（保留 0.1.7 宿主支持），
并在注释里写明「这是 0.85 世代的回填，1.3.0 的 api 不接受非品牌 transcript」。
不要为了过编译把 modern 分支改成折叠（那是 0.2.1 已论证过的错误方向）。

### P0-3 · `ctx.locale.register` 的签名加宽了

`src/client/index.tsx:55`：

```
src/client/index.tsx(55,53): error TS2345:
  Argument of type 'QoderLocale' is not assignable to parameter of type
  'Record<"zh" | "en", LocaleDictOf<"settings.qoder">> & Record<string, LocaleDictOf<"settings.qoder">>'.
  Index signature for type 'string' is missing in type 'QoderLocale'.
```

0.2.2 的 locale 包把语言从 2 种扩到 8 种（新增 `de/es/fr/ja/pt/ru`），
`register` 的签名从 `Record<BuiltInLocaleId, …>` 变成
`Record<BuiltInLocaleId, …> & Record<LocaleId, …>`（`LocaleId = string`），
于是要求字典对象带 string 索引签名；插件 `src/client/locales.ts:879` 的
`QoderLocale` 是固定 `{ zh, en }` 接口，没有索引签名。

**运行时不受影响**（JS 不做该检查，两种语言的字典照常注册、英文兜底），
是**类型面**破坏。

**修法**：给 `QoderLocale` 加索引签名，或用 `satisfies` 保留字面量类型再行断言；
若要顺便补齐新语言，这里就是唯一的落点（见 §五）。

---

## 三、P1：peer 范围在 npm 语义下不覆盖 0.2.2-rc.1

当前声明（`package.json` 的 `peerDependencies`）：

```
>=0.1.7-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0 || >=0.2.1-rc.1 <0.3.0-0
```

实测两套语义（node-semver 直跑）：

| 版本 | 标准语义（npm/pnpm 安装） | 宿主门禁（`includePrerelease: true`） |
|---|---|---|
| `0.2.1-rc.5` | true | true |
| **`0.2.2-rc.1`** | **false** ❌ | true |
| `0.2.2`（GA） | true | true |

即：**宿主的兼容门禁会放行，但 `pnpm add` / npm 安装会判不兼容**。
这正是 `tests/dsh-line.spec.ts:117` 那份 `UNGATED_PRERELEASES` 待办表列出的
`0.2.2-rc.1` —— 表里早就写着它待补，只是还没补。

**修法**：按 README「两套语义并存」一节的既定做法，加一条分支：

```
>=0.2.1-rc.1 <0.3.0-0 || >=0.2.2-rc.1 <0.3.0-0
```

同步三处：`package.json` 的 `peerDependencies` / `devDependencies`、
README「受支持的宿主范围」表（`README.md:310` / `README.en.md`）、
`tests/dsh-line.spec.ts` 的 `DECLARED_RANGE` 与 `UNGATED_PRERELEASES`。

> 注意：`pi-ai` 那一行的 `>=1.0.0 <2.0.0` **已覆盖 1.3.0**，不用改。

---

## 四、P2：测试树要一起升线，否则「验证不到真宿主」

把 overrides 升到 0.2.2 线后，全量用例从 `1221 passed / 8 skipped`
变成 **`1216 passed / 5 failed / 8 skipped`**（3 个文件）：

| 失败用例 | 原因 | 性质 |
|---|---|---|
| `tests/adapter-outgoing-body.spec.ts` ×3（legacy 世代） | 用例强制 `piAiGeneration: 'legacy'`，却跑在 pi-ai **1.3.0** 的 api 上；1.3.0 只读 `messages`，顶层 `tools` 必丢 | 用例前提失效 |
| `tests/pi-ai-runtime.spec.ts:115` | 硬编码 `expect(info.version).toMatch(/^0\.(8[5-7])\.\d+/)`，实测拿到 `1.3.0` | 版本 pin |
| `tests/fixtures/pi-ai-modern/modern-outgoing-body.spec.ts` | fixture 的 `package.json` 钉 `1.1.0`，断言「钉的就是 1.1.0」 | 版本 pin |

**关键结论**：把 fixture 升到 1.3.0 后，modern 直通那 4 条**全绿**
（`modern 直通：提示词与工具都出门`、`幂等`、`legacy 在 1.x 上会静默丢` 等），
只有「版本 pin 断言」那条红。也就是说 **0.2.2 的真实运行时路径没有回归**。

建议：

- legacy-only 那三条按「已装 pi-ai 世代」门控（`skipIf(generationOf(installed) !== 'legacy')`），
  而不是删掉 —— 0.1.7 宿主仍要这条护栏；
- `pi-ai-runtime.spec.ts` 的版本正则改成按世代断言，不再写死 0.85；
- `tests/fixtures/pi-ai-modern` 从 1.1.0 升到 **1.3.0**（与宿主同代），
  注释里「与 followup 文档同一个版本」随之更新；
- 主树是否整体升到 0.2.2，是个取舍：升了 CI 才对着真宿主跑，但会丢 0.1.7 的直接覆盖
  （可用 fixture 补）。**建议升主树** —— 本轮的问题恰恰是主树停在 0.1.7 才没被发现。

---

## 五、P3：不报错但语义变了的几处

### P3-1 · 中途 system 消息默认改成 user 味的 `<system-reminder>`

0.2.2 的 `toPiContext` 新增 `supportsMidConvoSystemMessages` 形参，从
`PreparedAdapterCall.updates.systemPromptUpdate === 'in-history'` 推出；
为 false 时，把对话**中途**的 system 文本包成 user 角色的
`<system-reminder>…</system-reminder>`（并转义闭合标签）。0.2.1 是**无条件**以
system 角色发送。

插件的 `buildModels()` 只声明了 `compat: { supportsReasoningEffort, supportsDeveloperRole: false }`，
没声明 `supportsMidConvoSystemMessages` → 取默认 false → **Qoder 路由的
中途 system 行为相对 0.2.1 变了**（这在共享历史 / 中途注入提示的场景才会显出差异）。

**动作**：实测 Qoder 网关是否接受中途 system 角色；接受就显式声明，
不接受就保持现状（默认的 reminder 其实更安全），并把结论写进注释。

### P3-2 · 宿主默认值改了两个常数

`DEFAULT_CONTEXT_WINDOW` 262144 → **1000000**，`DEFAULT_MAX_TOKENS` 32768 → **128000**。
只影响**没有显式给值**的路由。插件在 `src/adapter.ts:191` 逐模型用上游实测的
`info.contextWindow` / `info.maxOutputTokens`，预计无影响 —— 值得确认没有落到默认值上。

### P3-3 · 新增若干错误码

`stream.d.ts` 新增 `MALFORMED_RESPONSE`（completed tool arguments 非法）。
插件的 failover/重试分类基于**上游 HTTP 状态与 Qoder 业务码**（`context.code === '105'` 等），
不基于 `LlmError.code`，因此新码不会误触发换号；但如果以后把 `LlmError.code`
接进池排序，需要先给它归类。

---

## 六、可选增强（新钩子，非必需）

| 新能力 | 说明 | 对本插件的价值 |
|---|---|---|
| `llm/models-updated` 事件 | 「某路由的模型目录/显示元数据变了，消费者重读 `listModels()`」 | **中**：插件目录是动态的（换号、上游刷新、启用/禁用），目前从不通知，选择器可能显示旧列表 |
| `settings.section.icon` 槽位 | 设置左侧导航可为分区注册图标 | **已采用**（1.18.0）：设置页注册了自己的 LD 品牌标，id 与页面一致（不一致会静默退回默认齿轮） |
| locale 新增 6 语言 | `de/es/fr/ja/pt/ru` | **低**：不补也合法（英文兜底），补的话落点就是 P0-3 那一处 |
| `llm-pi-ai/request-headers` waterfall | 推理调用前统一改请求头（**不含**模型发现） | **无**：插件的 loopback shim 自己造头；将来若要区分「推理 vs 发现」再考虑 |
| `WebResource` 路由 | `webServer.register` 可注册 Fetch 资源 | **无**：插件的 HTTP 路由仍是 handler 形态，类型兼容 |

---

## 七、不需要改的部分（明确排除）

- **modern 直通路径**：真实 pi-ai 1.3.0 上提示词与工具都在，`generationOf(1.3.0) → modern` 正确。
- **cordis 4.1.0**：`LoggerLevel` 的 `INFO/WARN` 数值对调、`notify()` 返回值变化等都在
  插件不碰的内部面上；插件只用 `ctx.effect` / `ctx.on` / `logger.warn|error`（非数值等级）。
- **`dsh-attachment` / `dsh-settings` / `dsh-atomic-write` / `dsh-home-paths`**：导出面未变。
- **`DirectoryRegistrationHandle` / `registerConfigurableProviders`**：签名与语义未变。
- **`dsh-host-webserver`**：`index-inject` 多了 `peer` 参数、新增 `WebResourceRoute`，
  插件既不监听该事件也不注册资源路由，类型兼容。
- **插件用到的槽位**（`conversation.input.model.label` / `conversation.input.right` /
  `conversation.composer.dock` / `settings.section` / `settings.section.icon`）：契约未变。
  （本文写于 1.18.0 之前，当时配置入口还是 `plugins.bundle.config` /
  `plugins.row.config` 两个 keyed 槽；1.18.0 起已改为设置页分区，那两个槽不再注册。）

---

## 八、建议的落地顺序

1. **P0-1 + P0-2 + P0-3**：三处编译修复（约 10 行），先让 `typecheck` 在 0.2.2 树上绿；
2. **P2**：主树 overrides 升 0.2.2、fixture 升 1.3.0、legacy 用例按世代门控，让 `test` 绿；
3. **P1**：peer 加 `>=0.2.2-rc.1` 分支，同步 README 与 `dsh-line.spec.ts`；
4. **P3-1**：实测 Qoder 的中途 system 行为后决定是否声明能力；
5. 发版时把本文档加进 `package.json` 的 `files`（与 `DSH-0.2.1-RC1-FOLLOWUP.md` 并列）。

---

## 九、落地记录（2026-11-05，版本 1.17.5 未改号）

### 9.1 代码

| 项 | 改动 | 位置 |
|---|---|---|
| P0-1 | `REQUEST_IMAGE_BUDGETS` 补 `maxRequestImages: 50` / `imageOffloadCountQuantum: 10`，并在注释里写明「插件手工拼 profile，宿主的 `?? 50` 默认化不会跑，漏了不报错只是静默无上界」 | `src/adapter.ts:78` |
| P0-2 | 新增 `ApiContext` / `legacyContextOf()`，把两次断言收敛到一处并注明「这是世代边界，1.3.0 宿主走不到」 | `src/adapter.ts`（`withLegacyContext` 旁） |
| P0-3 | `QoderLocale` 加 string 索引签名，注释说明它不降低 `zh`/`en` 的键校验 | `src/client/locales.ts:891` |
| P3-1 | `compat.supportsMidConvoSystemMessages` **显式写 false**，把「跟随宿主默认」变成写下来的决定（附可改回 true 的条件） | `src/adapter.ts`（`toPiModel`） |

### 9.2 声明与文档

- `package.json`：26 处 dsh-* peer/dev 范围追加 `|| >=0.2.2-rc.1 <0.3.0-0`；
  `files` 收入本文档。
- `README.md` / `README.en.md`：范围表更新；「当前宿主基线」整节换成 0.2.2-rc.1 的实测结论
  （0.2.1-rc.4/rc.5 的逐条核查不再冒充「当前」）。
- `tests/dsh-line.spec.ts`：`DECLARED_RANGE` 加第四支；`0.2.2-rc.1` 从
  `UNGATED_PRERELEASES` 移入 `ADMITTED_PRERELEASES`（余下待办为 `0.2.3-rc.1` / `0.2.9-rc.1`）。

### 9.3 开发依赖树

`pnpm-workspace.yaml` 整体迁到 0.2.2 线：`dsh-* 0.2.2-rc.1`、`cordis 4.1.0`、
`schemastery 3.19.0`、`pi-ai 1.3.0`，并**删掉 `dsh-invariants`**
（它在 0.2.0-rc.2 之后停版，0.2.2 线已无包引用；留着会让 install 解析失败）。

### 9.4 测试

- `tests/pi-ai-runtime.spec.ts`：版本断言从写死 `/^0\.(8[5-7])\.\d+/` 改成
  「落在声明的 pi-ai peer 范围里」（宿主换线时该改的是钉版，不是这条判据）。
- `tests/fixtures/pi-ai-modern`：钉版 1.1.0 → **1.3.0**（与宿主同代）；「钉了什么」的断言
  改为「是确切版本 + `generationOf` 判 modern + 主版本是 1」，不再写死字符串。
- `tests/adapter-outgoing-body.spec.ts`：legacy 组按**已装世代**门控
  （`describe.skipIf(INSTALLED_GENERATION !== 'legacy')`），跳过时用例名里带原因。

### 9.5 结果

| 检查 | 改前（0.2.2 树） | 改后 |
|---|---|---|
| `tsc -p tsconfig.json` | 3 处错误 | **0** |
| `tsc -p tsconfig.client.json` | 4 处错误 | **0** |
| `vitest run` | 5 failed / 1216 passed / 8 skipped | **0 failed / 1217 passed / 12 skipped** |
| `tsdown` 构建 | — | 通过 |

### 9.6 仍然悬着的两件事

1. **legacy 分支没有活的覆盖**：主树迁到 1.3.0 后，`adapter-outgoing-body.spec.ts`
   整份跳过。要恢复覆盖，需要像 modern 那样再立一份 **0.85.1 fixture**，
   并给 `createQoderAdapter` 开一个注入 api 的缝（当前它自己 `openAICompletionsApi()`）。
   0.1.7 宿主线仍在 peer 范围里，所以这是真缺口，不是洁癖。
2. **中途 system 消息没有对着真网关验证过**：现在取的是保守侧（改写成
   `<system-reminder>`）。若实测 Qoder 接受中途 system 角色，把
   `supportsMidConvoSystemMessages` 改成 `true` 即可，无需改别处。
