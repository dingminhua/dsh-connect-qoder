# DSH 0.2.2-rc.2 升级跟进调研 —— dsh-connect-qoder

> 调研日期：2026-11-12
> 宿主：DSH Desktop **`0.2.2-rc.2`**（`app.asar` 内 `@deepseek-ai/dsh-*` 全部为
> `0.2.2-rc.2`，asar sha256 `1535941c…39d`）
> 插件：`@dmh2002/dsh-connect-qoder` **1.25.0 → 1.25.1**（本轮**不改运行时代码**，只重提取夹具）
> 上一轮：[`docs/DSH-0.2.2-RC1-FOLLOWUP.md`](DSH-0.2.2-RC1-FOLLOWUP.md)（`0.2.1-rc.5` → `0.2.2-rc.1`，那一轮要改代码）

---

## 零、结论摘要

**结论：不需要改运行时代码，但测试夹具必须重提取 —— 宿主改写了失败分类器的判据。**

与上一轮（rc.1，四处类型破坏）不同，`0.2.2-rc.1 → 0.2.2-rc.2` 在**插件碰到的
每一个宿主面**上都是纯新增：`typecheck` 一次通过，`build` 一次通过。唯一的红落在
**我们自己的 golden 夹具**上：宿主把 `classifyPiAiError` 的第一道判据从「扫全串」
改成「先取报文开头的状态码」，并引入一个新常量，而那份夹具是**手抄**下来的。

| 层 | 结论 | 所需动作 |
|---|---|---|
| `classifyPiAiError` 判据改写（新增 `LEADING_HTTP_STATUS`） | 🔴 夹具自检红（与装机宿主不再逐字一致）；手工补时若漏了这个常量，`new Function` 会 `ReferenceError` | **重提取夹具**（P0，已做） |
| `dsh-llm-pi-ai`：replay 加请求前缀摘要 + `onThinkingOmitted` | 🟢 纯新增，插件不构造 replay、不传该观察点 | 无 |
| `dsh-llm`：`HarnessError` 迁到新的 `@deepseek-ai/dsh-error` | 🟢 `dsh-llm` 仍重新导出它；插件从不用错误基类 | 无（但钉了 overrides，见 §3.2） |
| `dsh-attachment`：`AttachmentError` 改继承 `HarnessError` | 🟢 `code` 与 `name` 不变；插件只 `import type` | 无 |
| `dsh-client-ui-slots`：新增 `hoc` 槽位种类 | 🟢 插件只用 `single` / `list` / `keyed` / `chain` | 无 |
| `dsh-client-ui-settings`：`openSettings(sectionId?)` | 🟢 只加了一个可选形参 | 无 |
| peer 范围覆盖 `0.2.2-rc.2` | 🟢 同一元组，**不需要新分支** | 不用改 |
| 开发依赖树 | 🟡 仍钉在 rc.1 | **升到 rc.2**（已做） |

---

## 一、实测环境

宿主 `app.asar` 内 `node_modules` 的实际版本：

| 包 | 0.2.2-rc.1 | **0.2.2-rc.2（本机）** |
|---|---|---|
| `@deepseek-ai/dsh` 及全部 `dsh-*` | 0.2.2-rc.1 | **0.2.2-rc.2** |
| `@deepseek-ai/dsh-error` | 不存在（`HarnessError` 写在 `dsh-llm` 里） | **0.2.2-rc.2（新包，npm 上首个版本）** |
| `@earendil-works/pi-ai` | 1.3.0 | **1.3.0（不变）** |
| `@deepseek-ai/cordis` | 4.1.0 | **4.1.0（不变）** |
| `@deepseek-ai/schemastery` | 3.19.0 | **3.19.0（不变）** |

也就是说：这一轮**没有换 pi-ai、没有换 cordis、没有换 schemastery**，改动全部落在
`dsh-*` 自己的声明与实现里。复现方式：

```bash
rsync -a --exclude node_modules --exclude .git ./ /tmp/qoder022rc2/
cd /tmp/qoder022rc2
# overrides 改成 rc.2 线
rm -f pnpm-lock.yaml && pnpm install --no-frozen-lockfile
npx tsc -p tsconfig.json --noEmit          # 0
npx tsc -p tsconfig.client.json --noEmit   # 0
npx vitest run                             # 1 failed（golden 自检）→ 修夹具后 0
npx tsdown                                 # 通过
```

---

## 二、P0：宿主改写了失败分类器，夹具必须重提取

### 症状

`pnpm test` 只有一条红，是 `tests/shim.spec.ts` 里那条**自检**：

```
classifyPiAiError 第 38 个字符起与装机宿主不一致：
期望 "if (/\b(?:401|403)\b/.test(message)) return \"AUT"，
实为 "const statusSource = LEADING_HTTP_STATUS.exec(me"
```

这不是「期望值写错了一个字」，而是判据换了一种写法：

```js
// 0.2.2-rc.2 · app.asar
const LEADING_HTTP_STATUS = /^[45]\d\d\b/;

function classifyPiAiError(message) {
	const statusSource = LEADING_HTTP_STATUS.exec(message)?.[0] ?? message;
	if (/\b(?:401|403)\b/.test(statusSource)) return "AUTH";
	if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;
	if (/\b429\b/.test(statusSource) || /rate.?limit/i.test(message)) return "RATE_LIMIT";
	if (/\b413\b/.test(statusSource) || /failed to buffer …/i.test(message)) return "INVALID_REQUEST";
	if (/\b400\b/.test(statusSource) || /invalid.?request/i.test(message)) return "INVALID_REQUEST";
	if (/\b5\d\d\b/.test(statusSource)) return "SERVER";
	…
}
```

宿主的意图写在源码注释里（asar 里就是这段）：

> The body can quote another hop's status, such as a gateway 500 that embeds its
> upstream's 401, so when a message leads with a status the status rules read
> only that status; other wordings scan the whole message.

即：**只有报文开头那个状态码**参与状态判断，正文里转述的别人的状态码不再参与
（但 `isQuotaExceededError` 仍然扫全串、`rate.?limit` / `invalid.?request` 也扫全串）。
这是一次**收紧**，方向与我们的净化逻辑一致。

### 对本插件的行为影响：零

把插件实际会发出的文案喂给新判定逐条对比（旧 → 新）：

| 文案 | 旧 | 新 |
|---|---|---|
| `qoder upstream quota-exhausted (http 4xx): … HTTP 4xx {"code":"110"…}` | `QUOTA` | `QUOTA` |
| `qoder upstream rate-limited (http 4xx): …` | `RATE_LIMIT` | `RATE_LIMIT` |
| `qoder upstream transient (http 503): provider error` | `SERVER` | `SERVER` |
| `qoder upstream invalid-request (http 400): bad` | `INVALID_REQUEST` | `INVALID_REQUEST` |
| `401 TOKEN_EXPIRE`（`auth` 档原文照送） | `AUTH` | `AUTH` |
| `未配置 Qoder PAT` | `PI_AI_ERROR` | `PI_AI_ERROR` |

原因：`src/shim.ts` 的 `hostFailureMessage` 一直把裸 401/403 改写成 `4xx`，并给非
auth 档加 `qoder upstream <kind> (http <4xx|5xx>)` 前缀 —— 于是**文案开头就是一个
不带 401/403 的状态码**，新判据只看它，正好落在我们早已写进文案的那条线索上。
`4xx` 不匹配 `^[45]\d\d\b`（`x` 不是数字），因此 `statusSource === message` 全串扫描，
与旧行为一致。

### 修法：把「重提取」变成一条命令

漏的恰恰是「再抄一遍」这件事本身。手工补夹具时先补了两个函数、漏了新常量，
`new Function(...)` 当场 `ReferenceError: LEADING_HTTP_STATUS is not defined` ——
**这才是真正的隐患**：如果只改 `classifyPiAiError` 而不补常量，测试会以「夹具坏」
的形式红，而不是以「与宿主不一致」的形式红，读起来像别的问题。

所以新增 `scripts/extract-host-classifier.mjs`：

- 按**签名**定位、按**花括号配平**截取（不用「截到下一个 `\n}`」——宿主打包后缩进不统一，
  函数体里本来就有顶格的 `}`）；
- 三段一起提：`LEADING_HTTP_STATUS`（只存初始化部分）、`isQuotaExceededError`、
  `classifyPiAiError`；
- `--check` 只比对不写（给 CI / 非 macOS 用）；
- 记录 `occurrences`，并且 `classifyPiAiError` 出现两份时**直接报错停下**——那意味着
  宿主内嵌了两代 `dsh-llm-pi-ai`，取哪一份就不再是无所谓的决定。

`package.json` 加了 `pnpm run fixture:host-classifier`，夹具里也写了 `_refresh` 字段。
顺带补掉了 `tests/host-piai.ts` 文件头一句悬空引用（原先写「提取脚本见该文件的
`source` 字段」，而 `source` 里从来没有那个字段 —— 本仓库禁止这类引用）。

---

## 三、P1：变了的五个包，一个都不在插件的路径上

逐包比对 rc.1 与 rc.2 的 tarball（`lib/types/**/*.d.ts` + `lib/index.js` + `lib/client.js`）。
插件声明的 13 个 `dsh-*` 里实际 import 的有 11 个（`dsh-client-ui-primitives` 与
`dsh-settings` 只声明、不 import —— 前者是刻意的，见 3.4）。这 11 个里：

- **5 个有变化**：`dsh-llm`、`dsh-llm-pi-ai`、`dsh-attachment`、
  `dsh-client-ui-slots`、`dsh-client-ui-settings`（下面 3.1–3.4 逐条说）；
- **6 个的 `lib/types` 与 host 侧 `lib/index.js` 逐字节相同**：`dsh-atomic-write`、
  `dsh-client-locale`、`dsh-client-ui-renderer`、`dsh-home-paths`、
  `dsh-host-webserver`、`dsh-client-ui-settings-plugins`。

那 6 个里，`dsh-client-locale` / `dsh-client-ui-renderer` / `dsh-client-ui-settings-plugins`
的**浏览器半边**（`lib/client.js`）确实重新打包过（rc.2 的 tarball 开始带 `src/`，
产物也重压了），但插件对它们的用法是 `import type {}` 的**模块增强**（给 `SlotMap`
补声明），运行时不向它们要任何东西 —— 而且它们提供的槽与语言行契约在两边一致。

### 3.1 `dsh-llm-pi-ai`：replay 增加请求前缀摘要

新增 `lib/types/prefix-binding.d.ts`：

```ts
export type PrefixDigests = Map<AssistantMessage, string>
export declare function bindThinkingToPrefix(
  context: PiContext, api: Api, prefixDigests: PrefixDigests,
  manualThinking: boolean, onOmitted: (count: number) => void,
): PrefixBoundContext
```

配套地，`toPiReplayState(…, prefixDigest?)`、`toPiAssistant(…, prefixDigests?)`、
`toPiContext(…, prefixDigests?)`、`toStreamChunks(…, prefixDigest?)` 各加了一个
**可选**尾参，`PiAiAdapterOptions` 新增可选观察点 `onThinkingOmitted`。

它解决的是 Anthropic 的一个真实问题：signed thinking 块绑定在「生成它时的请求前缀」
上，压缩或裁剪工具结果后前缀变了，端点会整条拒绝请求。rc.2 的做法是给每条
assistant 响应记一个前缀摘要，重放时前缀对不上就把 signed thinking 摘掉。

**对本插件的影响：零。** 全部是可选形参；插件从不自己调 `toPiContext` /
`toPiReplayState`（它交给 `PiAiAdapter`），也不传 `onThinkingOmitted`。
`bindThinkingToPrefix` 只在 `api === 'anthropic-messages'` 时才有意义，而 Qoder 路由
走的是 `openai-completions`。

### 3.2 `dsh-llm`：`HarnessError` 搬到 `@deepseek-ai/dsh-error`

`lib/types/error.d.ts` 里 `HarnessError` 的定义删了，改成

```ts
import { HarnessError } from '@deepseek-ai/dsh-error'
export { HarnessError }
```

即两个 import 路径指向**同一个类**。同时 `LlmError` 的构造签名收紧：
`code: string → code: BuiltinLlmFailureCode`，并新增 `LlmError.fromFailure()` 供
「外部提供方自定义 code」的场景使用。

**对本插件的影响：零。** 插件 `import` 的 `dsh-llm` 名字只有
`resolveRetryPolicy` / `ReasoningEffortId` / `LlmModelInfo` / `LlmResolvedModelInfo` /
`PreparedAdapterCall`，从不构造 `LlmError`、也不 `instanceof HarnessError`。
插件失败分类读的是**上游 HTTP 状态与 Qoder 业务码**，不是 `LlmError.code`
（这一点上一轮已经记过，本轮再确认一遍仍然成立 —— 所以 `LlmError` 的构造签名收紧
不会被我们踩到）。

> 但 `@deepseek-ai/dsh-error` 现在有 `dsh-llm` 与 `dsh-attachment` 两个**精确版本**的
> peer 声明。所以 `pnpm-workspace.yaml` 里显式钉了它：将来某个包改成 `^0.2.2` 时，
> 解析出第二个副本会让 `instanceof HarnessError` 在两个类之间失效，而这正是
> 宿主用来判断「附件失败」的机制。

### 3.3 `dsh-client-ui-slots`：新增 `hoc` 槽位种类

`SlotKind` 从 `'single' | 'list' | 'keyed' | 'chain'` 变成了再**多**一档 `'hoc'`，配套
`HocRenderOpts` / `HocShare` / `HocKeysOf` 与 `KindOptions` 的 hoc 分支。宿主用它做
「包裹层」：`conversation.hero.frame`（包住会话滚动体）就是第一个 hoc 槽。

**对本插件的影响：零。** 插件用到的槽位全是
`conversation.input.right`（list）、`conversation.composer.dock`（list）、
`settings.section`（list）、`settings.section.icon`（list）、
`sidebar.panellist`（list）、`conversation.input.model.label`（single/keyed 运行时探测）。
`model-label-seat.ts` 的 `declaredSlotKind()` 遇到不认识的 kind 会**返回 undefined**
（落回单格形状）——所以即便哪天它读到 `'hoc'` 也不会崩，只是退回保守形状。

### 3.4 其余「有变化但无关」

| 包 | 变化 | 为什么无关 |
|---|---|---|
| `dsh-client-ui-settings` | `SettingsLauncherOwnerProps.openSettings: () => void` → `(sectionId?: string) => void` | 只加可选形参；插件从不注册 `settings.launcher`，它跳设置页走的是 `sidebar.settings` 的 store 座位（`openSection(id)`），rc.2 里那段座位代码逐字未变 |
| `dsh-client-ui-primitives` | 删 `useAnchoredPosition` / 新增 `usePointerGrace`、`Modal.tone`、`Checkbox.modalAutofocus` | 插件**从不 import** 这个包（`src/client/popover.ts` 是本地 40 行实现，文件头写着为什么），这是刻意的，正好躲过一次被删的导出 |
| `dsh-client-ui-conversation` | 新增 `conversation.hero.frame`（hoc）、`insertQuote(text, summary?)`、`ComposerBarProps.occurrence` | 插件不碰 hero、不调 `insertQuote`、不读 `occurrence` |
| `dsh-client-ui-model-selection` | 新增 `conversation.input.model.options`（list）槽 | 新增槽；标签订阅用的 `conversation.input.model.label` 声明**没变**（仍是 `single`） |
| `dsh-client-locale` | client 产物重压过，`register` 签名逐字相同；另有新的语言行组件与 `settings-store` | rc.1 已适配过的索引签名仍够用；插件只注册自己的命名空间，不碰语言行 |
| `dsh-client-ui-settings-plugins` | client 产物重压过；`settings.plugins` / `settings.plugins.tab` 两个槽在两边一致 | 插件自 1.18.0 起不再注册这两个槽（配置搬进 `settings.section`） |

`dsh-host-webserver` / `dsh-settings` / `dsh-atomic-write` / `dsh-home-paths` 的
`lib/types` 与 `lib/index.js` 逐字节相同（rc.2 只是多发了 `.d.ts.map` 与 `src/`），
不单独列行。

### 3.5 有一条**看起来要改、实际不用**的

`dsh-client-ui-settings-general` 的 rc.2 client bundle 里，侧边栏设置触发器**仍是**

```js
<button type="button" aria-haspopup="dialog" aria-expanded={open} …>
```

只是同一份文件里又多了一颗 `aria-haspopup="menu"` 的按钮（「发行通道」选择器）。
`src/client/settings-jump.ts` 的 `TRIGGER_SELECTOR` 是
`button[aria-haspopup="dialog"][aria-expanded]`，**不会**误命中新按钮；
`sidebar.settings` 的 store 座位（`create()` 钉在唯一活动实例上）在 rc.2 里逐字未变。
两条路径都仍然可用。

---

## 四、P2：peer 范围不需要新分支（这一条要写下来，因为直觉相反）

当前声明（`package.json` 的 `peerDependencies`）：

```
>=0.1.7-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0 || >=0.2.1-rc.1 <0.3.0-0 || >=0.2.2-rc.1 <0.3.0-0
```

`0.2.2-rc.2` 与 `0.2.2-rc.1` **同一元组**，第四支的比较符自带预发布标签，于是整个
`0.2.2` 元组都开闸。实测（node-semver 直跑）：

| 版本 | 标准语义（npm/pnpm） | 宿主门禁（`includePrerelease`） |
|---|---|---|
| `0.2.2-rc.1` | true | true |
| **`0.2.2-rc.2`** | **true** | **true** |
| `0.2.3-rc.1` | false ❌ | true |

**加分支的判据是「补丁号变了」，不是「rc 号变了」** —— 上一轮为 rc.1 补分支，是因为
`0.2.2` 这个元组此前没有任何带预发布标签的比较符；现在有了，rc.2 / rc.3 / … 都跟着
开闸。真正的下一个待办仍是 `0.2.3-rc.1`（`tests/dsh-line.spec.ts` 的
`UNGATED_PRERELEASES` 里钉着）。

本轮在 `tests/dsh-line.spec.ts` 把 `0.2.2-rc.2` 加进 `ADMITTED_PRERELEASES` 与
「宿主门禁覆盖整条 0.2.x」那条用例 —— **用断言把「不需要新分支」这个判断钉住**，
免得下次升级又去手工加一支没有意义的范围。

---

## 五、P3：开发依赖树

`pnpm-workspace.yaml` 整体迁到 `0.2.2-rc.2`（`dsh-*` 全部、外加新钉的
`@deepseek-ai/dsh-error`）。`cordis 4.1.0` / `schemastery 3.19.0` / `pi-ai 1.3.0`
不变 —— 宿主本来就没换。

实测结果：

| 检查 | rc.1 树 | **rc.2 树** |
|---|---|---|
| `tsc -p tsconfig.json` | 0 | **0** |
| `tsc -p tsconfig.client.json` | 0 | **0** |
| `vitest run` | 1471 passed / 1 failed（夹具） | **1472 passed / 12 skipped / 0 failed** |
| `tsdown` | 通过 | **通过** |

（rc.1 树的 1 failed 就是本轮修掉的那条自检；跳过数两边一致，都是 `live-intl-session`
这类需要真凭据的用例。）

---

## 六、明确排除的部分

- **`ResolvedPiAiProviderProfile` 的两个图片预算字段**：rc.1 补的
  `maxRequestImages: 50` / `imageOffloadCountQuantum: 10` 仍然必需，rc.2 的
  `resolveProfile` 里 `?? 50` / `?? Math.min(10, maxRequestImages)` 逐字未变。
- **中途 system 消息**：`conversationUpdates()` 的判据在 rc.2 里逐字未变，
  插件显式写下的 `supportsMidConvoSystemMessages: false` 仍然是「改写成
  `<system-reminder>`」那一侧，与上一轮的结论一致。
- **`toolUpdate`**：插件不声明它（于是每次请求都声明完整工具表），rc.2 对
  `addition-only` 的变更（`projectToolUpdates` 的注释变长了一截：重建时已激活的声明
  变成立即可用、未激活的保持延后）走不到我们这条路由。
- **窗口拖拽区域**：`v0.2.2-rc.1/window-drag-regions` 那条指南讲的是 macOS 上依赖
  「全局 no-drag 排除」的自定义浮层。本插件的积分浮层是 `position: fixed` 的
  body portal，**向上**挂在输入框上方（`side: 'top'`），不会覆盖页头 —— 所以那条
  「被裁剪到视口上方的内容挡住页头拖动」的场景构造不出来；它也没有任何
  `data-window-drag*`。无需声明区域。（值得注意的是这类判断**只在 macOS Desktop 上
  能看出来** —— 普通 Web 与 Windows 行为不变，CI 也测不到。）
- **`BundleInfo.update` 取代 `updatable`**：插件不调 `pluginManager.listBundles()`。
- **`AttachmentError` 错误码进 `turn/end`**：插件只 `import type { AttachmentStore }`，
  从不抛附件错误。
- **`runtime-context` 的提醒包装**：那是宿主写会话日志的形状；插件不读也不写
  `runtime-context` 记录。

---

## 七、落地记录（2026-11-12，1.25.1）

| 项 | 改动 | 位置 |
|---|---|---|
| P0 | 新增提取脚本（按签名定位 + 花括号配平 + 唯一性检查 + `--check`） | `scripts/extract-host-classifier.mjs` |
| P0 | 夹具重提取到 rc.2：`classifyPiAiError` 新版 + `isQuotaExceededError`（逐字未变）+ `LEADING_HTTP_STATUS`（新） | `tests/fixtures/host-piai-classifier.json` |
| P0 | 自检把新常量也纳入逐字比对；`new Function` 只在夹具带该常量时才拼那一行 | `tests/host-piai.ts` |
| P0 | 补掉「提取脚本见 `source` 字段」这句悬空引用；夹具里加 `_refresh` 字段 | 同上 + 夹具 |
| P2 | `0.2.2-rc.2` 加进 `ADMITTED_PRERELEASES` 与宿主门禁那条用例（**不新增分支**，用断言钉住这个判断） | `tests/dsh-line.spec.ts` |
| P3 | overrides 整体迁到 `0.2.2-rc.2`，并显式钉 `@deepseek-ai/dsh-error` | `pnpm-workspace.yaml` |
| 工具 | `pnpm run fixture:host-classifier` | `package.json` |
| 文档 | 本文 + README 双语「当前宿主」小节 + CHANGELOG `1.25.1` | — |

**没有改 `src/` 下的任何一行。** 这一轮的结论是「宿主换的是我们没碰的面，但换到了
我们用来做证据的那份夹具上」——值得记下来的教训不是某个字段，而是：夹具的**重提取
必须是一条命令**，因为「再抄一遍」这件事本身会漏。
