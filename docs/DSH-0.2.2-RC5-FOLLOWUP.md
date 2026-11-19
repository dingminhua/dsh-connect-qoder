# DSH 0.2.2-rc.5 升级跟进调研 —— dsh-connect-qoder

> 调研日期：2026-11-19
> 宿主：DSH Desktop **`0.2.2-rc.5`**（`app.asar` 内 329 个 `dsh-*` 全部为
> `0.2.2-rc.5`，asar sha256 `6f019878…88e`）
> 插件：`@dmh2002/dsh-connect-qoder` **1.26.4 → 1.27.0**（本轮**不改运行时代码**，
> 只升依赖树、重提取夹具元数据、补版本基线与文档）
> 上一轮：[`docs/DSH-0.2.2-RC3-FOLLOWUP.md`](DSH-0.2.2-RC3-FOLLOWUP.md)

---

## 零、结论摘要

**结论：不需要改运行时代码。** `0.2.2-rc.3 → 0.2.2-rc.5` 跨 rc.4、rc.5 两个版本，
适用的两条升级指南都落在 **DeepSeek 模型面**（拒答错误码、模型搜索默认提供方），
本插件是 Qoder 桥接，**两条都不涉及**。逐包比对 329 个钉在 rc.5 的 `@deepseek-ai/*`
包：插件 import 的 11 个里 10 个逐字节相同，唯一变了的 `dsh-llm` 只是**新增**一个
错误码枚举。`pnpm run check` 在 rc.5 依赖树上第一次跑就全绿（1510 通过 / 12 跳过）。

| 层 | 结论 | 所需动作 |
|---|---|---|
| `v0.2.2-rc.3/deepseek-refusal-code`（rc.3→rc.4） | 🟢 拒答码 `MALFORMED_RESPONSE` → `CONTENT_REFUSED`；插件只用 `dsh-llm` 的 `resolveRetryPolicy` 与类型，不碰错误码 | 无 |
| `v0.2.2-rc.4/web-search-deepseek-model-default`（rc.4→rc.5） | 🟢 搜索默认提供方改由 `dsh-web` 按模型路由选，插件不碰 web 搜索 | 无 |
| 插件 import 的 11 个宿主包 | 🟢 10 个逐字节相同；`dsh-llm` 只多一个 `CONTENT_REFUSED` 枚举 | 无 |
| `settings-general` / `sidebar` 的 `client.js` | 🟡 只有内嵌构建版本串变了（`rc.3-6b729fe` → `rc.5-3f85d88`）；归一化后逐字节相同，`settings-jump.ts` 依赖的座位全未变 | 无 |
| 失败分类器夹具 | 🟢 三段源码**逐字相同**，`--check` 已过；但 asar 换了 sha，溯源元数据要刷新 | **重提取**（已做） |
| peer 范围覆盖 `0.2.2-rc.5` | 🟢 同一元组，仍**不需要新分支**（第三次实证） | 补断言（已做） |
| 版本基线测试 `tests/dsh-line.spec.ts` | 🟡 只列到 rc.3 | **补 rc.4 / rc.5**（已做） |
| 开发依赖树 | 🟡 仍钉在 rc.3 | **升到 rc.5**（已做） |

---

## 一、实测环境

宿主 `app.asar` 内 `node_modules` 的实际版本：

| 包 | 0.2.2-rc.3 | **0.2.2-rc.5（本机）** |
|---|---|---|
| `@deepseek-ai/dsh` 及全部 `dsh-*` | 0.2.2-rc.3 | **0.2.2-rc.5**（329 个包，逐个核对） |
| `@deepseek-ai/cordis` | 4.1.0 | **4.1.0（不变）** |
| `@deepseek-ai/schemastery` | 3.19.0 | **3.19.0（不变）** |
| `@earendil-works/pi-ai` | 1.3.0 | **1.3.0（不变）** |

这一轮**没有换 pi-ai、没有换 cordis、没有换 schemastery** —— 与前几轮一致。

### 1.1 逐包 diff 的方法与结果

把 asar 里钉在 `0.2.2-rc.5` 的 **329 个** `@deepseek-ai/*` 依赖，逐个下载 rc.3 与
rc.5 两个 tarball、解开、做 `diff -rq`，剔除 `package.json` 与 `*.map`（前者必然只差
版本号与内部 peer 版本，后者是构建噪声）。结果：

- **327 个真比过了**：其中约 20 个有实质内容差异，其余剔除噪声后逐字节相同；
- **2 个比不了**：`dsh-desktop-host` 是桌面壳自有包，npm 上 404，两个版本都取不到；
  它不在本插件声明的任何 peer 里，跳过无害。

有实质差异的包集中在：**DeepSeek 搜索默认**（`dsh-web`、`dsh-web-search-deepseek`、
`dsh-tool-web`、`dsh-client-ui-settings-web-search`、`dsh-base` 的 `cordis.patch.yml`）、
**拒答码**（`dsh-llm`、`dsh-llm-deepseek`）、以及 liveshare / tmux / session-persistence /
repeat-tool-reminder / tool-cordis / api-remotes / client-modules 等面。逐条都不在本插件
import 的 11 个包里（唯一交集 `dsh-llm` 见 §二）。

### 1.2 复现方式（一次性调研，不值得做成仓库里的脚本）

```bash
# 1) 从装机 asar 的依赖表里取出钉在 rc.5 的包名
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" -e '
const fs=require("node:fs"),path=require("node:path");
const nm=path.resolve(process.env.DSH_INSTALL_DIR,"../");
for(const p of fs.readdirSync(nm)){ if(!p.startsWith("dsh"))continue;
  try{const j=JSON.parse(fs.readFileSync(path.join(nm,p,"package.json"),"utf8"));
    if(j.version==="0.2.2-rc.5") console.log(j.name);}catch(e){} }
' > pkgs.txt

# 2) 逐包拉两个版本、解开、递归 diff
while read -r p; do
  slug="${p#@deepseek-ai/}"
  for v in 0.2.2-rc.3 0.2.2-rc.5; do
    d="/tmp/cmp/$slug/$v"; mkdir -p "$d"
    npm pack "$p@$v" --silent --pack-destination "$d" >/dev/null 2>&1 \
      && tar xzf "$d"/*.tgz -C "$d" --strip-components=1 && rm "$d"/*.tgz
  done
  diff -rq "/tmp/cmp/$slug/0.2.2-rc.3" "/tmp/cmp/$slug/0.2.2-rc.5" \
    | grep -Ev 'package\.json|\.map\b' | sed "s|^|$slug: |"
done < pkgs.txt
```

---

## 二、P0：两条升级指南逐条核对

### 2.1 `v0.2.2-rc.3/deepseek-refusal-code`

指南内容：DeepSeek 以 `stop_reason: "refusal"` 结束时，错误码从
`MALFORMED_RESPONSE` 改成 `CONTENT_REFUSED`。落实到包上：

- `dsh-llm` 的 `src/error.ts` **只新增**一行 `CONTENT_REFUSED: {},` 到错误码表；
- `dsh-llm-deepseek` 新增 `refusal()` 构造函数，在拒答时先吐 usage 再抛错。

插件对 `dsh-llm` 的用法（见 `src/adapter.ts` / `src/index.ts`）：`resolveRetryPolicy`、
`RetryPolicyConfig`、`LlmModelInfo` 等类型、`AdapterRegistrationHandle` —— **没有一处
读错误码表或按错误码分支**。插件自己的失败分类走 `src/shim.ts` 的净化 +
`tests/fixtures/host-piai-classifier.json` 那份宿主分类器原文，与 `dsh-llm` 的错误码
不是同一个东西。**无需改动。**

### 2.2 `v0.2.2-rc.4/web-search-deepseek-model-default`

指南内容：基础组合不再固定 `web.searchProvider = deepseek-search-api`，改由 `dsh-web`
按模型提供方路由选择；DeepSeek 模型走一次辅助 Messages 请求（不按次收费、按 token
计费），并追加 `web/deepseek-search-llm-request` 事件。落实到 `dsh-base/cordis.patch.yml`
确实是删掉了 `searchProvider: deepseek-search-api` 那一行。

插件不注册任何 web 搜索提供方、不读 `web.searchProvider`、不消费
`web/deepseek-search-llm-request` 事件、也不从 `@deepseek-ai/dsh-web` import 任何东西。
这是宿主默认组合层的变更，**无需改动**。

---

## 三、P0：看起来要改、逐字比过其实不用改的面

### 3.1 失败分类器夹具

跑 `node scripts/extract-host-classifier.mjs --check`：三段源码
（`LEADING_HTTP_STATUS` / `isQuotaExceededError` / `classifyPiAiError`）与装机 rc.5 宿主
**逐字相同**（1088 字节的 `classifyPiAiError` 命中 1 处，两个 quota 函数命中 2 处、
照旧取第一处）。也就是说 rc.4 / rc.5 没有再动 `dsh-llm-pi-ai` 的分类器 —— 上次 rc.2
那次「先取报文开头状态码」的改动是最后一次实质变化。

但 asar 换了 sha（`c0ce89f7…e843` → `6f019878…88e`），夹具 `source` 里的
`dshVersion` / `asarSha256` / `extractedAt` 是溯源元数据，必须跟着刷新 —— 否则将来
查「这段分类器是哪一版宿主的」会读到过期的 rc.3。已跑一次不带 `--check` 的提取，
`source` 更新为 rc.5 / 新 sha / `2026-11-19`（本地日期）。**源码三段一个字节没动。**

### 3.2 设置页外壳与侧边栏

`dsh-client-ui-settings-general` 与 `dsh-client-ui-sidebar` 的 `lib/client.js` 在 rc.3 /
rc.5 之间有差异，但把内嵌构建版本串归一化（`0.2.2-rc.N-<hash>` → `VERSION`）后
**逐字节相同**。逐条核对 `src/client/settings-jump.ts` 依赖的座位：

- `sidebar.settings` 仍是 `kind: single, scope: root` 的槽；
- 设置触发器仍是 `aria-haspopup="dialog"`；
- 置顶的「新建会话」行仍由 `renderSlot('sidebar.session.action', …)` 包裹（rc.3 引入的
  hoc 形状没再变）；
- `sidebar.panellist` / `panellist.actions` 的注册签名未变。

插件的 `settings.section` 注入与 `openSection(id)` 调用路径不受影响。**无需改动。**

### 3.3 槽位目录与模型徽章

`dsh-client-ui-slots`、`dsh-client-ui-settings`、`dsh-client-ui-settings-plugins`、
`dsh-client-ui-renderer`、`dsh-attachment`、`dsh-home-paths`、`dsh-host-webserver`、
`dsh-atomic-write`、`dsh-client-locale` 九个包 rc.3 / rc.5 逐字节相同。插件注册/消费的
槽契约（含 `conversation.input.model.label` 的 `single` 形状）不变，无需重新核对清单。

---

## 四、P2：peer 范围仍然不需要新分支

当前声明：

```
>=0.1.7-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0 || >=0.2.1-rc.1 <0.3.0-0 || >=0.2.2-rc.1 <0.3.0-0
```

实测（node-semver 直跑）：

| 版本 | 标准语义（npm/pnpm） | 宿主门禁（`includePrerelease`） |
|---|---|---|
| `0.2.2-rc.3` | true | true |
| `0.2.2-rc.4` | true | true |
| **`0.2.2-rc.5`** | **true** | **true** |
| `0.2.3-rc.1` | false ❌ | true |

加分支的判据是「补丁号变了」，不是「rc 号变了」。这是**第三次**实证这个判断
（rc.2 第一次、rc.3 第二次）。本轮把 `0.2.2-rc.4` / `0.2.2-rc.5` 加进
`tests/dsh-line.spec.ts` 的 `ADMITTED_PRERELEASES` 与宿主门禁用例，注释写明「第三次
实证，不是又一个待办」。真正的下一个待办仍是 `0.2.3-rc.1`（`UNGATED_PRERELEASES`）。

---

## 五、P3：开发依赖树

`pnpm-workspace.yaml` 整体迁到 `0.2.2-rc.5`（27 个 `dsh-*` 钉版 + 钉住的 `dsh-error`），
`cordis 4.1.0` / `schemastery 3.19.0` / `pi-ai 1.3.0` 不变。`pnpm install --lockfile-only`
重锁，`pnpm install --frozen-lockfile` 复核通过，lockfile 里 rc.3 归零、rc.5 共 187 处。

实测结果：

| 检查 | rc.3 树 | **rc.5 树** |
|---|---|---|
| `tsc -p tsconfig.json` | 0 | **0** |
| `tsc -p tsconfig.client.json` | 0 | **0** |
| `vitest run` | 1510 passed / 12 skipped | **1510 passed / 12 skipped** |
| `tsdown` | 通过 | **通过** |

---

## 六、明确排除的部分

- **`dsh-llm` 的 `CONTENT_REFUSED`**：插件不使用错误码表（见 §2.1），新增枚举项对
  `resolveRetryPolicy` 与类型导入没有影响。
- **DeepSeek 模型搜索默认**：纯宿主组合层变更（见 §2.2），插件不提供搜索提供方。
- **liveshare / tmux-context / session-persistence-jsonl / repeat-tool-reminder /
  tool-cordis / api-remotes / client-modules**：rc.3→rc.5 有实质差异，但插件既不 import
  也不声明这些包，逐条排除。
- **CUA / worktree 等宿主自有行为**：与插件无关，沿用 rc.3 文档里的结论，不重复。

---

## 七、落地记录（2026-11-19，1.27.0）

| 项 | 改动 | 位置 |
|---|---|---|
| P0 | 夹具按 rc.5 asar 重提取（三段源码逐字相同，只有 `source` 元数据变） | `tests/fixtures/host-piai-classifier.json` |
| P1 | `0.2.2-rc.4` / `0.2.2-rc.5` 加进 `ADMITTED_PRERELEASES` 与宿主门禁用例（**不新增分支**） | `tests/dsh-line.spec.ts` |
| P2 | overrides 整体迁到 `0.2.2-rc.5` | `pnpm-workspace.yaml`、`pnpm-lock.yaml` |
| 文档 | 本文 + README 双语「当前宿主」小节轮换 + CHANGELOG `1.27.0` + `files` 清单 | — |

**没有改 `src/` 下的任何一行。** 这一轮与 rc.3 的区别只在「宿主把两个升级指南都落在
了 DeepSeek 模型面」——连夹具源码都没动，只有溯源元数据跟着 asar 换了一次。
