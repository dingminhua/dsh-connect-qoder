# DSH 0.2.2-rc.3 升级跟进调研 —— dsh-connect-qoder

> 调研日期：2026-11-14
> 宿主：DSH Desktop **`0.2.2-rc.3`**（`app.asar` 内 329 个 `@deepseek-ai/dsh-*` 全部为
> `0.2.2-rc.3`，asar sha256 `c0ce89f7…e843`）
> 插件：`@dmh2002/dsh-connect-qoder` **1.25.1 → 1.25.2**（本轮**不改运行时代码**，
> 只升依赖树、重提取夹具元数据、补断言与文档）
> 上一轮：[`docs/DSH-0.2.2-RC2-FOLLOWUP.md`](DSH-0.2.2-RC2-FOLLOWUP.md)

---

## 零、结论摘要

**结论：不需要改运行时代码。** `0.2.2-rc.2 → 0.2.2-rc.3` 是一次**功能增量**发布
（几乎全部内容来自一个 commit：`feat(experimental): 导入 DeepSeek 官网对话导出为会话`），
落在插件**没有触及**的面上。`typecheck` / `test` / `build` 在 rc.3 依赖树上第一次跑就全绿。

| 层 | 结论 | 所需动作 |
|---|---|---|
| `dsh-deepseek-chat-import`（新包、新 bundle 行） | 🟢 全新 experimental 包，需用户显式安装；插件不引用 | 无 |
| `dsh-client-ui-sidebar` 新增 `sidebar.session.action`（hoc） | 🟢 新槽 +「新建会话」行改成 `renderSlot` 包裹；插件用的 `sidebar.panellist`/`panellist.actions` 逐字未变 | 无 |
| `dsh-client-ui-workspace` 新增 `workspace.picker` Factory + 第三个 directory-flow 洞 | 🟢 插件既不用 workspace 也不用 directory-picker | 无 |
| `dsh-client-ui-directory-picker-{browse,native}` 改注册三处 | 🟢 宿主自家包之间的适配 | 无 |
| `dsh-session-log-export`：缺附件不再整包失败 | 🟢 插件不导出会话 | 无 |
| `dsh-client-ui-settings-general` 的 client bundle | 🟡 逐字比过：**只有版本串变了**（`0.2.2-rc.2` → `0.2.2-rc.3`）。`settings-jump.ts` 依赖的 store 座位、`aria-haspopup="dialog"` 触发器、`data-shortcut-modal` 全部逐字未变 | 无 |
| `dsh-client-ui-plugin-manager` | 🟡 `MORE_BUNDLES` / `EXPERIMENTAL_BUNDLES` 各多一条 `dsh-deepseek-chat-import`；插件不读这两张表 | 无 |
| 失败分类器夹具 | 🟢 宿主没动 `classifyPiAiError`（三段逐字相同），但**asar 换了 sha**，`source` 元数据必须重提取 | **重提取**（已做） |
| 回归：usage 解析夹具 | 🟢 逐字相同（手工核对过）；`extractedAt` 仍停在 `2026-10-22`，是**夹具本身没动**，不是漏更新 | 无 |
| peer 范围覆盖 `0.2.2-rc.3` | 🟢 同一元组，仍**不需要新分支** | 补断言（已做） |
| 开发依赖树 | 🟡 仍钉在 rc.2 | **升到 rc.3**（已做） |

---

## 一、实测环境

宿主 `app.asar` 内 `node_modules` 的实际版本：

| 包 | 0.2.2-rc.2 | **0.2.2-rc.3（本机）** |
|---|---|---|
| `@deepseek-ai/dsh` 及全部 `dsh-*` | 0.2.2-rc.2 | **0.2.2-rc.3**（329 个包，逐个核对） |
| `@deepseek-ai/cordis` | 4.1.0 | **4.1.0（不变）** |
| `@deepseek-ai/schemastery` | 3.19.0 | **3.19.0（不变）** |
| `@earendil-works/pi-ai` | 1.3.0 | **1.3.0（不变）** |

也就是说：这一轮**没有换 pi-ai、没有换 cordis、没有换 schemastery** —— 与前两轮一致。

rc.3 里 `@deepseek-ai/*` 依赖共 337 个，其中 329 个是 `0.2.2-rc.3`，剩下 8 个是
**宿主一直没跟着发版**的那几个（`cordis` 4.1.0、`cordis-plugin-group/include/loader`
1.1.0、`cordis-plugin-timer` 1.2.0、`cosmokit` 1.9.0、`node-addon-system` 0.1.2、
`schemastery` 3.19.0）。这 8 个的版本号在 rc.2 里逐字相同。

### 1.1 逐包 diff 的方法与结果

把 asar 里钉在 `0.2.2-rc.3` 的 **329 个** `@deepseek-ai/*` 依赖，逐个下载 rc.2 与 rc.3
两个 tarball、解开、做 `diff -rq`，并剔除 `package.json` 与 `*.map`（前者必然只差版本号
与内部 peer 版本，后者是构建噪声）。结果：

- **327 个真比过了**：其中 **17 个有实质内容差异**，**310 个**剔除噪声后逐字节相同；
- **2 个比不了**，两个原因不同，别混为一谈：
  - `dsh-deepseek-chat-import` —— rc.2 时**还不存在**，随本轮首发（见 §3.0）；
  - `dsh-desktop-host` —— 桌面壳自有的包，**npm 上根本没有**（`404`），两个版本都
    取不到。它不在本插件声明的任何 peer 里，跳过无害。

另有 **8 个** `@deepseek-ai/*` 依赖不在这 329 里，因为宿主一直没给它们换版号
（`cordis` / `cordis-plugin-*` / `cosmokit` / `node-addon-system` / `schemastery`）——
它们在 rc.2 与 rc.3 的 `package.json` 里逐字相同。

### 1.2 复现方式（一次性调研，不值得做成仓库里的脚本）

```bash
# 1) 从装机 asar 的依赖表里取出钉在 rc.3 的包名
ASAR="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"
node -e 'const s=require("fs").readFileSync(process.argv[1],"latin1");
const i=s.indexOf("\"name\": \"@deepseek-ai/dsh-desktop-runtime\"");const o=s.lastIndexOf("{",i);
let d=0,e=-1;for(let k=o;k<s.length;k++){if(s[k]==="{")d++;else if(s[k]==="}"){if(--d===0){e=k+1;break}}}
const m=JSON.parse(s.slice(o,e));
console.log(Object.keys(m.dependencies).filter(n=>n.startsWith("@deepseek-ai/")&&m.dependencies[n]==="0.2.2-rc.3").join("\n"))' "$ASAR" > pkgs.txt

# 2) 逐包拉两个版本、解开、递归 diff（这里是 shell 版，等价于上面用的那套）
while read -r p; do
  slug="${p#@deepseek-ai/}"
  for v in 0.2.2-rc.2 0.2.2-rc.3; do
    d="/tmp/rc3/$slug/$v"; mkdir -p "$d"
    npm pack "$p@$v" --silent --pack-destination "$d" >/dev/null 2>&1 \
      && tar xzf "$d"/*.tgz -C "$d" --strip-components=1 && rm "$d"/*.tgz \
      || echo "MISSING $p@$v"
  done
  diff -rq "/tmp/rc3/$slug/0.2.2-rc.2" "/tmp/rc3/$slug/0.2.2-rc.3" 2>/dev/null \
    | grep -Ev 'package\.json|\.map\b' | sed "s|^|$slug: |"
done < pkgs.txt
```

> **为什么它不是仓库里的脚本**：上一轮的同类比对也是手工做的，结论进了文档、方法没留。
> 这次考虑过写成 `scripts/`，最后没写 —— 它只在宿主升级时跑一次、要十几分钟、还要
> 联网，而 `scripts/extract-host-classifier.mjs` 之所以必须存在，是因为它守的是**每次
> 测试都会读的夹具**（漂了会红）。一次性调研留可复跑的命令就够了，把它做成工具再加
> 一套测试，成本比它省下的时间高。

---

## 二、P0：夹具必须重提取（但只是元数据）

`classifyPiAiError` 在 rc.3 里**逐字没变** —— `node scripts/extract-host-classifier.mjs --check`
在升级前就直接报「夹具与装机宿主一致」。变的是 asar 本身（sha256 变了），于是夹具里
`source.dshVersion` / `source.asarSha256` 已经是错的溯源信息。

跑一次 `node scripts/extract-host-classifier.mjs` 即可，三段源码原样写回。

### 2.1 顺手修掉一个只在凌晨发作的缺陷

`extractedAt` 原本是 `new Date().toISOString().slice(0, 10)` —— **UTC 日期**。在 UTC+8
上，任何一次 00:00–08:00 之间跑的提取都会写下**前一天**。本轮就撞上了：11-14 凌晨
00:47 跑的提取把日期记成 `2026-11-13`。

这个字段只作溯源提示、不参与任何断言，所以错一天**永远不会让测试变红**——正因为它
不会红，只能靠把它写对：改成 `new Date().toLocaleDateString('sv-SE')`
（`sv-SE` 的默认格式恰好是 ISO 形状的本地日期）。

> 这是本仓库「夹具的重新提取必须是一条命令」那条教训的延伸：脚本自动化了**抄写**，
> 但没自动化**抄对日期**。差异在于日期这件事没有任何断言能替你发现。

---

## 三、P1：变了的 17 个包，没有一个在插件的路径上

### 3.0 先说那个「新增」的

`@deepseek-ai/dsh-deepseek-chat-import` 在 rc.2 里**不存在**（npm 上只有 `0.2.2-rc.3`
与一个 `0.0.0-stage`），是随本轮一起首发的 experimental bundle。它需要用户显式安装才会
激活，本插件既不引用它、也不在它的依赖里 —— 对使用者唯一的可见变化是插件市场里多出
一张可选卡片。

### 3.1 插件自己 import 的 11 个，逐字节相同

插件声明 13 个 `dsh-*` peer，实际 import 的有 11 个。这 11 个里**全部**在 rc.3 中
逐字节未变（`lib/index.js` 与 `lib/client.js` 的 sha256 相同）：

| 包 | `lib/index.js` | `lib/client.js` |
|---|---|---|
| `dsh-atomic-write` | 相同 | —— |
| `dsh-attachment` | 相同 | —— |
| `dsh-client-locale` | 相同 | 相同 |
| `dsh-client-ui-renderer` | 相同 | 相同 |
| `dsh-client-ui-settings` | 相同 | 相同 |
| `dsh-client-ui-settings-plugins` | 相同 | 相同 |
| `dsh-client-ui-slots` | 相同（`lib/types` 逐字节相同） | —— |
| `dsh-home-paths` | 相同 | —— |
| `dsh-host-webserver` | 相同 | —— |
| `dsh-llm` | 相同 | —— |
| `dsh-llm-pi-ai` | 相同 | —— |

另外两个只声明不 import 的（`dsh-client-ui-primitives` 与 `dsh-settings`）：
`dsh-settings` 逐字节相同；`dsh-client-ui-primitives` 多了一个**图标**（`upload-outline`
的 Regular/Medium 两条导出），是纯新增，而插件**从不 import 这个包**。

> 值得注意：rc.2 那一轮 `dsh-client-ui-primitives` 删过 `useAnchoredPosition`，本插件
> 因为「刻意的本地 40 行 popover」躲过了一次。这一轮它加图标，同样没碰到我们。

### 3.2 那 17 个有实质变化的包，逐条说明

| 包 | 变化 | 为什么无关 |
|---|---|---|
| `dsh`（CLI） | 只改了 `docs/`：`capability-seams`、`config-catalog`、`subsystems/persistence` 三份（英中双份）新增 `deepseekChatImport` 一节 | 文档 |
| `dsh-agent-preset` | `skills/dsh-doc/references/packages.md` 多一行 `dsh-deepseek-chat-import` | 技能文档 |
| `dsh-api-session-controller` | `lib/typert.host.js` 的内嵌声明里多一个 `deepseekChatImport/owner-only` 错误码 | 插件不调 Remote 方法 |
| `dsh-client-modules` | 只差一行 build commit 常量（`a6b1b85` → `6b729fe`） | 构建噪声 |
| `dsh-client-ui-directory-picker-browse` | 注册点从「两个 directory-flow 洞」扩到「三个」，多注入一个 `workspace.picker.directoryFlow` | 插件不用 directory picker |
| `dsh-client-ui-directory-picker-native` | 同上 | 同上 |
| `dsh-client-ui-plugin-manager` | `MORE_BUNDLES` / `EXPERIMENTAL_BUNDLES` 各多一条新 bundle | 插件不读这两张表 |
| `dsh-client-ui-settings-account` | client bundle 里两处版本串 | 见下 §3.2 |
| `dsh-client-ui-settings-general` | 同上 | 见下 §3.3 |
| `dsh-client-ui-sidebar` | 新增 `sidebar.session.action`（hoc）槽 + 「新建会话」行改由它包裹 + CSS | 见下 §3.4 |
| `dsh-client-ui-workspace` | 新增 `workspace.picker` 槽 Factory 与第三个 directory-flow 洞 | 插件不碰 workspace |
| `dsh-cordis-client-runner` | `slot-catalog.ts` 新增两条槽（`sidebar.session.action`、`workspace.picker.directoryFlow`），其余条目逐字未变 | 见下 §3.5 |
| `dsh-experimental-cua-macos` | CUA helper 的 native 二进制换了 hash（build key 跟着变） | 插件不碰 CUA |
| `dsh-official-bundles` | bundle 清单多一条 `dsh-deepseek-chat-import` | 插件不在清单里 |
| `dsh-session-log-export` | 附件读不出来时改为写 `attachments-missing.txt` 继续导出，而不是整包失败 | 插件不导出会话 |
| `dsh-tool-cordis` | API 目录多 8 行（`deepseekChatImport` 服务） | 插件不读这份目录 |
| `dsh-web-frontend` | 前端 asset 换了 hash | 宿主自己的 Web 产物 |

### 3.3 `settings-jump.ts` 依赖的两个「外壳形状」都还在

这是本轮唯一值得**逐字核对**的地方：插件的「跳到设置页」按钮读的是宿主的外壳，
而 rc.3 动过 `ui-sidebar` 与 `ui-settings-general`。核对结果：

- `sidebar.settings` 的 store 座位逐字未变：`const shellInstance = shellHandle.create()`、
  `const shellStore = {...shellHandle, create: () => shellInstance}`、
  `openSection: (d, id) => { d.activeId = id; d.open = true }` 全部原样。
- 设置触发器仍是 `aria-haspopup="dialog"` + `aria-expanded`（那颗 `menu` 语义的
  「发行通道」选择器也还在，`TRIGGER_SELECTOR` 不会误命中它 —— 与 rc.2 结论相同）。
- `data-shortcut-modal="settings"` 仍在。
- `ui-settings-general` 与 `ui-settings-account` 的 client bundle **只有版本串变了**
  （strip 掉版本串后 `diff` 为空）。

### 3.4 「新建会话」行被 `renderSlot` 包了一层 —— 与插件无关，但要知道

`ui-sidebar` 把原来直接渲染的 Tooltip + button 改成：

```jsx
<div className={css.newSessionRow}>
  {renderSlot('sidebar.session.action', { wide }, { children: (…原内容…) })}
</div>
```

新增槽 `sidebar.session.action` 的 kind 是 **`hoc`**（rc.2 才引入的那一档）。插件用的是
`sidebar.panellist`（list）与 `sidebar.panellist.actions`（list），**两处逐字未变** ——
`SidebarRoot.tsx` 里 `PanelRow` / `PanelIcon.tsx` 的渲染区域 `diff` 为空。

> 一条通用的防线：`model-label-seat.ts` 的 `declaredSlotKind()` 对**不认识的 kind 返回
> `undefined`**（落回单格形状），所以将来哪怕读到 `'hoc'` 也不会崩。这条在 rc.2 引入
> `hoc` 时就写下了，本轮仍然成立。

### 3.5 槽位目录：114 → 116，新增的两条都不是我们的

`dsh-cordis-client-runner` 的 `slot-catalog.ts` 是本机唯一能一次性读到「所有槽的 kind
与 scope」的产物。对比 rc.2 / rc.3：

| 槽 | rc.2 | rc.3 |
|---|---|---|
| `sidebar.session.action` | 不存在 | **新增** `hoc` / root |
| `workspace.picker.directoryFlow` | 不存在 | **新增** `single` / root |
| 其余 114 条 | —— | **kind 与 scope 逐条相同** |

插件实际用到的 9 个槽在 rc.3 里的声明（直读装机 asar 的目录条目）：

| 槽 | kind | scope |
|---|---|---|
| `main` | keyed | root |
| `sidebar.panellist` | list | root |
| `sidebar.settings` | single | root |
| `settings.section` | list | root |
| `settings.section.icon` | list | root |
| `conversation.input.right` | list | session |
| `conversation.composer.dock` | list | session |
| `conversation.input.model.label` | single | session |
| `conversation.input.model.options` | list | session（本插件不注册） |

`conversation.input.model.label` 仍是 **`single`**，且调用点**仍然没有 `entryKey`** ——
`model-label-seat.ts` 那条「keyed 要宿主两处一起改」的判断在 rc.3 上仍未被推翻，
运行时探测路径照旧是必需的那条。

---

## 四、P2：peer 范围仍然不需要新分支

当前声明：

```
>=0.1.7-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0 || >=0.2.1-rc.1 <0.3.0-0 || >=0.2.2-rc.1 <0.3.0-0
```

`0.2.2-rc.3` 与 rc.1 / rc.2 **同一元组**，第四支已经开闸。实测（node-semver 直跑）：

| 版本 | 标准语义（npm/pnpm） | 宿主门禁（`includePrerelease`） |
|---|---|---|
| `0.2.2-rc.2` | true | true |
| **`0.2.2-rc.3`** | **true** | **true** |
| `0.2.3-rc.1` | false ❌ | true |

加分支的判据是「补丁号变了」，不是「rc 号变了」。这是**第二次**实证这个判断
（rc.2 是第一次）。本轮把 `0.2.2-rc.3` 加进 `tests/dsh-line.spec.ts` 的
`ADMITTED_PRERELEASES` 与宿主门禁那条用例，注释里写明「这是第二次实证，
不是又一个待办」。真正的下一个待办仍是 `0.2.3-rc.1`（`UNGATED_PRERELEASES`）。

---

## 五、P3：开发依赖树

`pnpm-workspace.yaml` 整体迁到 `0.2.2-rc.3`（`dsh-*` 全部 + 钉住的 `dsh-error`）。
`cordis 4.1.0` / `schemastery 3.19.0` / `pi-ai 1.3.0` 不变。

实测结果：

| 检查 | rc.2 树 | **rc.3 树** |
|---|---|---|
| `tsc -p tsconfig.json` | 0 | **0** |
| `tsc -p tsconfig.client.json` | 0 | **0** |
| `vitest run` | 1472 passed / 12 skipped | **1472 passed / 12 skipped** |
| `tsdown` | 通过 | **通过** |

---

## 六、明确排除的部分

- **`dsh-deepseek-chat-import`**：全新的 experimental 包（npm 上只有 `0.2.2-rc.3`
  与一个 `0.0.0-stage`），随 rc.3 一起首发。它要用户显式安装才会激活，插件不引用它、
  也不出现在它的依赖里。
- **`workspace.picker` 的 Factory 槽**：`ui-slots` 的 `SlotFactoryMap` 在 rc.2 里就已经
  存在（31 处引用，两版逐字节相同），rc.3 只是 workspace 包**第一次用它**。插件不注册
  也不渲染任何 Factory。
- **`sidebar.session.action` 的 hoc 形状**：插件不注册 hoc 槽。`declaredSlotKind()`
  对这种陌生 kind 的保守回退仍然有效（见 §3.4）。
- **CUA helper 的二进制变更**：`experimental-cua-macos` 的 native bundle hash 变了，
  这是宿主的 CUA 自更新，与插件无关。**注意**：macOS 上 CUA 权限按 bundle 身份授予，
  这个变化可能让用户被要求重新授权一次 —— 那是宿主侧的行为，不是本插件的问题。
- **`session-log-export` 的 `attachments-missing.txt`**：新行为是「缺附件不失败」。
  插件从不导出会话，也没有读取导出产物的路径。
- **usage 解析夹具的 `extractedAt: 2026-10-22`**：这不是漏更新。那段
  `parseChunkUsage` 从 10-22 至今**逐字未变**（本轮逐字核对过装机 asar），
  `source` 里记的是「这段文本是哪天提取的」，不是「最后一次检查是哪天」。
  没有 `--check` 模式给这份夹具，所以它只能靠手工核对 —— 本轮核过，结论是相同。

---

## 七、落地记录（2026-11-14，1.25.2）

| 项 | 改动 | 位置 |
|---|---|---|
| P0 | 夹具按 rc.3 asar 重提取（三段源码逐字相同，只有 `source` 元数据变） | `tests/fixtures/host-piai-classifier.json` |
| P0 | `extractedAt` 改用本地日期（`sv-SE`），修掉 UTC+8 凌晨跑会写前一天的缺陷 | `scripts/extract-host-classifier.mjs` |
| P2 | `0.2.2-rc.3` 加进 `ADMITTED_PRERELEASES` 与宿主门禁用例（**不新增分支**） | `tests/dsh-line.spec.ts` |
| P3 | overrides 整体迁到 `0.2.2-rc.3` | `pnpm-workspace.yaml`、`pnpm-lock.yaml` |
| 文档 | 本文 + README 双语「当前宿主」小节轮换 + CHANGELOG `1.25.2` + `files` 清单 | — |

**没有改 `src/` 下的任何一行。** 这一轮与 rc.2 的区别只在「变的是哪些包」：
rc.2 打到了我们用来做证据的夹具上，rc.3 连夹具都只是换了元数据。
值得记下的教训是 §2.1 —— 自动化了抄写不等于抄对了元数据。
