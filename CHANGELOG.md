# 更新日志（Changelog）

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## Unreleased

本轮为「与 dsh-connect-workbuddy 逐模块对等审计」的修复轮：以下各项均以 workbuddy 的已验证行为为基准，并对照 pi-ai / DSH 宿主源码逐条核实后修复。

### Fixed

- **首字节之前的上游失败改为非 200 JSON 错误**（原为 200 + SSE 错误帧）。pi-ai 的 openai-completions chunk 循环只取 `choices[0]`，**完全不读流内 `error` 字段**：`finish_reason:"error"` 会塌缩成一句无信息的 `Provider finish_reason: error`（宿主分类为 `PI_AI_ERROR`），真实的上游消息与分类 code 全部丢失。改为非 200 JSON 后，状态码、`code` 与上游原文都能进入宿主分类器（`classifyPiAiError`）。
- **限流（429）对宿主的 code 改写为 `quota_exceeded`**（HTTP 状态仍 429，上游消息原文透传）。原 `rate_limit_exceeded` 会被宿主归入 `RATE_LIMIT` **原地重试集**（默认 5 次指数退避），把重试预算烧在小时级冷却上——正是 workbuddy 用 `KIND_HOST_CODE` 修掉的同一个缺陷形状。
- **账号池接管通知改走首个内容帧**（原为 `choices: []` 的自定义 `notice` 帧）：pi-ai 的 chunk 循环对无 choice 的帧直接 `continue`，换号通知此前**用户完全不可见**。现在以引用块前缀写进 `choices[0].delta.content`。
- **换号重试前增加 2 秒可中断间隔**（对齐 workbuddy 的 `FAILOVER_ACCOUNT_GAP_MS`）：上游限流按请求体积触发，零间隔连环重试会让每个候选账号撞上同一堵墙。
- **策略层重复返回已试账号时 shim 侧自行刹车**（`tried` 检查不再只依赖策略层）。
- **客户端中途断开即中止上游请求**（`res` 的 close → AbortController），且断开前的失败不再记成账号池测量（断开不是账号的错；workbuddy 同规）。
- **补回 Origin 回环校验**（插件注释自称「Host / Origin / Content-Type 三重校验」，实际漏了 Origin）与**请求体 64MB 上限**（超界回 413，先排干上传再回写，避免 socket 被拆后客户端连状态码都看不到）；新增 `/healthz`。
- **`tool_choice:"none"` 落实为不带 tools**：cosy 模板没有 `tool_choice` 字段，其他形态无法透传，但「宿主禁止工具」必须生效（workbuddy `prepareChatBody` 同义）。
- **模型行的「免费」标记不再误用「总量」文案键**：新增 `row.modelFree`（免费 / Free）。
- **模型行的模型名恢复显示 `displayName`**：原误渲染为 `row.usageTotal` 文案（每行模型名都显示成「总量 / total」），与免费标记是同一个占位键漏改的两个实例。
- **区域 tab 栏恢复 workbuddy 同构的两层结构**：原实现把按钮与开关的嵌套写反，并把 `dsm-qoder-tab-dot`（7px 状态圆点的样式类）拼到了 tab **容器**上——圆点规则会把承载元素缩成 7px 圆，整条 tab 栏塌成两个被裁切的小药丸。现为 `tab-cell > button.tab + label.tab-switch`，激活态与停用态（`tab-active` / `tab-off`）落在按钮上，并补 `role="tablist"` / `role="tab"` / `aria-selected`。
- **设置页上卡片默认展开**：`open` 初始值由 `view === 'summary'` 改为 `view === 'page'`（与 workbuddy 同规）；此前 bundle 页打开时卡片是收起的。
- **卡片按钮字号归一到 13px**：「重新读取账号」（原带 `pool-small-btn`，12px）、「从 Qoder 刷新」（原误带行内探测类的 `model-probe`，11px）、账号行的删除与两步确认按钮（原 12px）全部去掉小尺寸覆盖类；`model-probe`（11px）只保留给模型行内的「测一测」，`pool-small-btn`（12px）只保留给账号池表格内的行按钮——与 workbuddy 的应用位置逐一对应。
- **卡片页脚恢复家族结构**：原 `<footer class="dsm-qoder-foot">` 的类**从未有对应 CSS 规则**——链接渲染成浏览器默认蓝、`margin-left:auto` 因无 flex 容器失效，两段文字挤作一团。现与 workbuddy 同构：仓库链接以 `usage-cheer`（灰色 13px + ★）放入保存行左侧，「放弃修改」按钮恒在（未改动时禁用，不再条件渲染），保存错误改为按存在条件渲染（原实现恒渲染一个空 `div`，平白吃掉一段垂直间距）。
- **删除页脚常驻的「如何创建 PAT？」提示行**（用户实拍要求）：workbuddy 的 `usage-hint` 只在有话要说时出现（需要重新登录 / 选择丢失），从不作常驻页脚。该指南入口移进「添加 PAT」弹窗——用户打开那个弹窗的时刻正是需要它的时刻；卡片页脚自此不再有任何常驻行。
- **账号选择器改为按需出现**（`accounts.length > 1` 才渲染）：零账号时该行只剩一个不可操作的下拉，选项文本是「自动 —— 设置 → 环境变量 → 保险库」，对没有账号的用户是一句无法解读的话；单账号时「自动」等于唯一候选，切换是空操作。两种情况都不再画这一行。
- **模型行的名称与倍率对齐 workbuddy 渲染**：倍率由本地化句子 `积分 0.79x` 改为 workbuddy 的 `(0.79x)` 括号形态（`toFixed(2)` 固定两位，免费模型显示 `(0.00x)`）；模型名下方那行模型 id 不再渲染（workbuddy 的行从不显示 id），id 降级为名称的 `title` 悬停提示。随之删除失去引用的 `row.modelRate` 文案键与 `.dsm-qoder-model-id` 样式。
- **账号池「目标测试模型」下拉显示模型名与倍率**（原直接渲染模型 **id**，如 `qmodel_latest`）：改为 workbuddy 的 `名字 (x0.79)` 形态。为此 `RenderSettings` 的 `catalog` 由 id 数组改为模型对象数组。
- **账号池目录补回真实倍率**：路由层投影（`poolModelOf` 与 pool 视图的 `targetModels`）此前只对免费模型写 `creditMultiplier: 0`，**付费模型一个数字都没有**——选项读起来像免费。现改为透传上游 `priceFactor`；未声明倍率的仍保持缺省（不编造数字）。
- **区块顺序对齐 workbuddy**：账号池管理（账号池表格与设置）从模型列表**之后**移到**之前**（账号行 → 账号池 → 模型列表）。原顺序要求用户先翻过整张模型表才够得到池设置；workbuddy 的 `AccountPool` 就在模型区之前。
- **模型行体验对齐 workbuddy（四项）**：
  - 测试按钮从「每行独占一个 details 行」挪进**头部行右端**，说明文字只作按钮悬停提示（`title`）——此前未测试的每个模型行都铺着一整段相同的「对该模型发一条真实聊天请求……」说明；探测结果行改为仅在有结果时渲染（workbuddy 的 `result === undefined → null` 同规），并改为单段 `<p role="status">`（结果 + ` · 原因`，全文进 `title`）。
  - 删除「推理强度：」空尾巴标签：它来自 `t('row.modelReasoning', { efforts: '' }).replace(': ', '')` 的 hack——全角冒号根本匹配不到 ASCII `': '`，且 Qoder 上游不给 effort 列表，这个标签永远只渲染半个句子。随之删除失去引用的 `row.modelReasoning` 文案键。
  - 上下文档位选择器从 details 行挪进头部行（workbuddy 的 context-budget fieldset 同位）。
  - 列表尾部补上能力声明注记（`row.modelCapabilityPending`，「仅展示 Qoder 接口明确公布的模型能力。」——locale 键早已存在但此前从未渲染），并补 `.dsm-qoder-model-capability-note` 样式。
- **倍率为 1 的模型也显示 `(1.00x)`**：`webModelOf` 曾把 `priceFactor === 1` 当「无倍率」丢掉（兜底目录全部中招，卡片上一个倍率都看不到）；`modelDisplayName` 同样在 1 时省略后缀。两边都改为一律透传/照写，与 workbuddy 卡片、DSH 选择器及 Qoder 自家菜单（`· x1.0`）一致。


- **恢复建议从未实测，却在断言（用户实拍）**：卡片上的「本区域还有其他账号，但刚才都没能通过上游校验」是**猜**出来的——`web-status` 写的是 `reloginRequired: accounts.length <= 1`，只要存在第二条记录就宣称「可以切换一个试试」，而那条记录可能同样过期（用户实拍：同一个邮箱的两条记录，一条已过期，卡片却让它去切换）。`credential-recovery.ts` 里早就写好了一个会**逐个探测**其余账号、只把真正答过话的那个承诺给用户的实现，但**从未被任何地方调用**。现在接线为 `credentialRecovery` dep：切换建议基于实测，「其他账号也没通过」也基于实测。
- **「移除账号」按钮渲染了整句说明**：按钮文字用的是 `row.accountRemoveHint`——那是一整句解释（「把这个账号的 PAT 从插件保险库移除。设置中的 PAT、环境变量 PAT 与 Qoder 官网本身的登录不受影响。」），按钮因此撑成一大块；两个同名账号的按钮挤在一起，完全读不出是干什么的。新增短标签 `row.accountRemoveShort`（移除 / Remove），整句说明留在 `title` 上继续可达。
- **同名账号无法区分**：同一个邮箱重新签发 PAT 会得到**两条**记录（id 由 PAT 推导，是不同的），两条都叫同一个名字——下拉与删除按钮上只显示名字，「移除哪一个」「当前在用哪一个」都看不出答案。现在重名时补 id 尾号（末 4 位），正在计费的那条带「使用中」标记；下拉与删除按钮共用同一套标签，避免「在下拉里选中一个、到按钮上又认不出」。
- **添加 PAT 时填的显示名没有任何地方使用**（用户实拍指出）：客户端一直会把这个名字随请求发给宿主，但路由里的 `add` 分支**完全忽略它**——它只调 `validateForRegion` 拿上游解析出的名字并写库，于是用户给 PAT 起的名字（「公司号」「备用」）填了等于没填，列表里显示的永远是上游那个标识。现在**用户填的名字优先**，没填才退回上游解析出的名字（两者都空则写空串，卡片渲染「未命名」）；顺带让命中已存在 id 的添加也按本次输入改名。成功提示「已添加「X»。在上方选中它即可使用」也随之改掉——账号选择器只在多个账号时才出现，单账号下那句话没有对应控件。
  - **why it existed**: workbuddy 走 OAuth，昵称由上游直接给出，没有「手动填名字」这一步，所以对等审计时这一条没有可对照的实现——它是 qoder 特有的 PAT 模式才需要的功能，只做了前端、没接到存储。
- **凭据被上游拒时静默成空白（「积分看不到」的真正原因）**：实测过期 PAT 打上游返回 `401 TOKEN_EXPIRE / token is not active`，而 `fetchUsage` 把**所有**错误一律吞成 `undefined`，宿主于是走成功分支写入 `{usage: undefined}`——卡片既没有积分、也没有任何错误提示，只剩一片空白，用户无从判断发生了什么。现在 `fetchUsage` 区分两类失败：**凭据被拒（401/403）抛出**（两条回退路径都拒绝才抛，保留原始错误），其他错误（超时、5xx、网关抖动）仍返回 `undefined`（那是「这次没读到」，报成凭据被拒会把用户引去换一个没问题的 PAT）；宿主把 `kind === 'auth'` 记为 `credential-rejected`，卡片随之渲染「凭据被拒」区块与切换/添加 PAT 的出路。
  - 同一处静默还导致 `credential-recovery` 的凭据可用性判定**永远为真**：它靠 `try { await fetchUsage } catch { usable = false }` 判断，而原实现正常返回 `undefined`，`await` 不抛错——过期凭据因此被判定为可用，于是「切换到另一个账号」的恢复建议建立在错误的可用性判断上。
- **模型行补回思考强度档位**：上游模型条目带 `thinking_config.enabled.efforts`（实测形状 `{xhigh:{}, low:{}, medium:{is_default:true}}`，键即档位名），qoder 此前只从 `thinking_config` 读「能否关闭思考」一个布尔值，档位数据全部丢弃，卡片上没有任何强度信息。现在解析为 `thinkingEfforts` / `defaultThinkingEffort` 并在模型行的 meta 行渲染为 `推理强度：low / medium（默认） / xhigh`（workbuddy 的 `modelReasoning` 同位同形）。
  - **键序不可信**：上游给的顺序是 `xhigh, low, medium`，直接显示会让用户以为 xhigh 是最弱档；解析按强度语义序表（`minimal<low<medium<high<xhigh<max`）排序，未知档位名排在已知档之后以保证顺序稳定。
  - **不是每个模型都有档位**：`auto`、`qmodel_latest`、`mmodel` 等实测 `efforts` 缺失，此时字段缺席、卡片不渲染这一项（空标签会让人以为「支持思考却没有强度可选」）；档位名也不统一（Qwen 系 `low/medium/xhigh`、DeepSeek/GLM 系 `low/high/max`），只做展示、不做跨模型比较。

- **积分与目录的成败解耦**：`refreshUsage` 此前链在目录刷新成功的分支里——动态目录一挂（启动时网络抖动、网关超时……），积分就永远不来，卡片上「看不到积分」。现在目录失败只落兜底目录，积分照常拉取。
- **账号池投影的倍率规则统一**：`index.ts` 的 `poolModelsOf` 是第三处「只对免费模型写 0、付费模型没数字」的投影（前两处在 web-status，上一轮已修）。三处现统一为「免费折叠为 0（`resolveTargetModel` 只认 `=== 0` 的契约），付费透传真实 `priceFactor`」。
- **卡片头部补 `aria-label`**（「展开/收起：Qoder Connect」）：图标按钮此前对读屏没有名字（workbuddy 同规）。
- **模型行的图片/关闭思考复选框恒渲染**：是否可用只看写权限，不再按上游字段有无隐藏控件（workbuddy 同规）——隐藏会让能力未知的模型行缺控件，行与行控件数量不一、视觉抖动。
- **区域 error 分支不再渲染空壳**：usage 拉取失败时此前因 `regionOn` 兜底为 true 而继续渲染账号行/账号池/模型列表的空架子；现在与 workbuddy 同规，只留错误行。
- **「凭据被拒」区块重构为 workbuddy 同构**：`usage-error` 容器（`role="alert"`）+ `strong`/`p` 结构；「可切换 / 无号可切 / 有号但都失败」三态说明互斥，切换动作是独立按钮（busy 时显示「正在读取…」）。新增 `row.credentialRejectedSwitchAction` 文案键。
- **模型保存/区域开关/积分开关与账号池保存互斥**：账号池经新增的 `onBusyChange` 上报保存窗口，池保存期间卡片侧三类写入一律禁用（两边写同一个 region slot，并发会以旧快照互相回滚）；模型「保存」按钮同时补上「至少启用一个模型」的门栏（workbuddy 同规）。
- **账号池活动日志跨折叠/跨 tab 留存**：日志从组件 state 迁入模块级 `logStore`（每区域一份，上限 50 条，「清空」同时清 store）——此前折叠卡片或切换 tab 就清空历史，看起来像操作没发生（workbuddy 同规）。
- **账号池两张表合并回一张成员表（workbuddy 同构）**：成员复选框、状态点（排除=红/琥珀、未测=灰、测过=绿/琥珀）、账号名 +「使用中」标签 + 成员标签 + 测试时间/排除原因、积分（总数 + 临期高亮/最近到期）、探针（结果 + 来源/时长）、行操作同处一行；原「只读状态表 + 独立勾选表」双表拆除。成员表头带选中计数与全选/清空；区块顺序重排为 表 → 目标告警 → 设置（目标模型带来源一句话「当前：xx（你指定/自动挑选的免费模型）」）→ 区域说明 → 日志；陈旧目标在 select 中回退显示原值（`targetModelId || staleTargetModelId`），保存/行删除期间盖 BusyOverlay。
- **账号池成员行的积分列接通了数据**：此前 `buildPoolView` 从不填 `credits`/`expiringSoon`/`nearestExpiryMs`，积分列恒为「—」。新增 `memberCredits` dep（按成员逐账号读 usage，单账号失败只让该行显示「—」），并把读数写入 10 分钟快照供请求路径的 failover 排名使用（`rankPool` 的积分打分项此前永远按 0 排；workbuddy 的 `creditsSnapshot` 同规）。
- **账号池设置区补回外壳与保存行细节（workbuddy 同构）**：设置区自己的小标题（「账号池设置」）+ 脏标记 + 说明行（「下面是偏好设置：点保存才生效……」——locale 键早已存在但从未渲染）；保存行左端补仓库链接（★ 鼓励一下），「放弃修改」改为恒渲染（未改动时禁用，不再条件渲染导致这一行左右跳动），并去掉保存行里与标题重复的脏标记。
- **探针「来源」药丸接上未知态样式**：`.dsm-qoder-pool-prov-unknown`（带描边）规则早已存在但 JSX 从未使用——来源未知的旧记录此前与「测试写入」渲染得一模一样。同时把失败原因从独立药丸改为并入探针主行（`结果 · 原因`，workbuddy 的 `probeLine` 同规）：该药丸原被硬编码成琥珀色的「live-request」样式，而原因可来自任何失败结果，颜色在说谎；全文仍在行 `title` 中。
- **账号工具移到账号池设置区顶部的虚线框**（用户实拍对照）：「添加 PAT / 导出导入账号」两行此前直接堆在账号行末尾、没有外框；现在与 workbuddy 同构——`pool-tools` 虚线框落在「账号池设置」标题之下、设置说明行之上（两个工具立即生效，说明行讲的是「下面这些偏好要保存」，顺序颠倒会让读者以为工具也要保存）。为此 `AddAccount`/`AccountTransfer` 由卡片注入账号池（`accountTools` prop），因为它们需要卡片的刷新与区域。同时删掉两行常驻说明（`.dsm-qoder-bar-hint` 用法）：workbuddy 的对应行只在等待/完成/出错时出现状态文本，常驻说明把每行撑成三行高，而它讲的「本区域生效的账号」「导出为 JSON…」分别是账号行与弹窗里的话题。导出按钮补上 `accounts.length === 0` 门栏。
- **「正在计费」的行补回左侧竖条**：`.dsm-qoder-pool-row-current` 此前只有 7% 透明的背景色，暗色主题下几乎看不出哪一行在用；现补上 workbuddy 同款的 `inset 3px 0 0` 品牌色竖条（同一个类名的第二条规则）。

### Changed

- **插件图标改回 LaoDing 插件家族通用的 LD 品牌标**：`icons/dsh-connect-qoder-{128,64}.png` 与卡片头部内联 data URI 均与 dsh-connect-trae / dsh-connect-workbuddy 字节一致（家族约定：图标标识「同一家族的插件」，产品区分由标题与描述承载）。取代 0.2.0 的 Qoder 品牌紫白 Q 磁贴。

### Docs

- 新增 [`docs/PAT.md`](docs/PAT.md)：PAT 是什么、从控制台哪里签发（国内版/国际版各自入口）、卡片粘贴与环境变量两条配置路径、优先级与常见问题；README 的 PAT 段落改为指向它并补上发证入口。`package.json` 的 `files` 由 `docs/assets` 改为 `docs`，使 `docs/*.md` 随包发布（此前 README 与包内的 DESIGN 文档链接在 npm 页面上是死链）。

### Tests

- `tests/shim.spec.ts` 从 10 用例扩到 20 用例：非 loopback Origin 拒绝 / 回环 Origin 放行、请求体上限 413、`/healthz` 鉴权、首字节前失败回 JSON 且 code 翻译、流中失败仍走 SSE 错误帧、`tool_choice:"none"` 丢 tools、换号可见通知、耗尽时每个失败账号都记测量且消息注明尝试数、重复候选刹车、换号间隔生效、400 不换号。
- 新增首个**客户端真实渲染**测试 `tests/card-render.spec.tsx`（jsdom 挂载真组件，key-preserving 翻译）：断言 tab 栏结构（圆点只在按钮内、激活/停用类落在按钮上）与模型行文案（displayName 与 `row.modelFree`，而不是键字面量）。本轮三个视觉缺陷全部来自「363 个 host 测试从不执行组件」这一盲区，此文件补上这一层。

## 0.2.0 (2026-01-01)

与同族插件 `dsh-connect-workbuddy`（参考实现）对齐外观与能力，同时贴合 Qoder 的 PAT 上游现实。

### Features

- **多账号池（PAT）** —— 每区域一个 `$DSH_HOME/.qoder-accounts.<region>.json` 本地 vault（0600），叠加设置 PAT 与环境变量，三者按 settings → env → vault 去重合并；卡片可新增 / 移除 / 改名账号，也可显式选择某账号服务（`regions.<region>.accountId`，留空自动）。
- **账号池按实测排序与故障转移** —— 「测一测」批量对每个成员发真实请求，结果落 `$DSH_HOME/.qoder-pool.<region>.json`；聊天流在首字节前按 `rankPool`（可用性 → 额度从高到低 → 到期最近 → id）自动换账号，失败回写 `live-request` 探测记录。Qoder **没有每日签到**，故 `checkinSupported` 恒为 `false`、卡片不出现签到列。
- **账号转移（导入 / 导出）** —— 按区域导出 vault 账号为传输文件，预览后按索引导入；跨区域域名（`qoder.com.cn` / `qoder.sh`）正向匹配，不匹配的记录计入 `skipped`。
- **PAT 校验与增删** —— 新增 PAT 时经 Qoder `JobToken` 交换校验并取回显示名，失败即拒绝；移除只删 vault 条目，不碰设置 PAT / 环境变量。
- **上下文预算（context tiers）** —— 从上游 `context_config` 解析模型声明的档位，卡片按档位选择上下文预算，仅在已声明档位内生效（否则回落原生值）。
- **积分读数进 composer** —— `conversation.input.left` 插槽（order 4）按区域显示 `QD CN` / `QD AI` 与当前账号余额，受每区域 `showCreditsInMainUi`（默认开，opt-out）控制；每账号明细走 `account-credits` 路由。
- **CLI 增强** —— `doctor` 增报 pi-ai 代际、宿主心跳存活、vault 账号计数；`status` 增报凭据来源与当前剩余积分；新增 `logout [--region cn|global]` 清除本区域 vault 账号与账号池测量副本。
- **回环路由扩展** —— 新增 `usage`（每区域快照）、`account-credits`、`accounts add/remove`、`pool test/remove`、`transfer export/preview/import`、`__save`（两段式合并，防部分写入误删兄弟区域）。

### Changed

- **客户端对齐同族 `dsm-*` 视觉语言** —— `dsm-qoder-*` 组件类 + 与 workbuddy 逐字一致的共享 `.dsm-plugin-card*` / `.dsm-btn*`；文案迁移到 `row.*` / `composer.*` 双语键；新增账号池表、账号转移面板、PAT 新增表单、composer 积分读数与忙碌遮罩等组件。
- **PI 代际兼容桥** —— 适配器按 `piAiRuntimeInfo()` 代际门控：legacy pi-ai 把 0.87 形态 transcript 折回 0.85 形态（system 消息与 tools 折叠到 `systemPrompt`/`tools`），modern 代际原样透传；Qoder 上游接受 user-first 会话，故不注入兜底 system prompt。
- **推理档位** —— Qoder 推理线上量是布尔 `model_config.is_reasoning`（非 effort 档），故 `qoderThinkingLevelMap` 只表达 `off`（仅 `canDisableThinking` 模型提供），各 effort 档位映射 `null`。
- **插件图标** —— 改用 Qoder 桌面版**应用图标本体**（`icon.icns` 解出的白底黑 Q），替换此前那张与深色卡片几乎融为一体的黑底磁贴；共享 `.dsm-plugin-card-icon`（32×32、radius 7px）与 workbuddy 逐字节一致。
- **探针结果文案统一** —— 抽出 `client/probe-label.ts` 作为**唯一**渲染规则：模型行与账号池表此前各写一套（耗时一处毫秒一处秒、恢复时刻一处只有时:分:秒一处是日期+时间），同一份测量两种说法；并补回缺失的耗时（`probeOkMs`）与上游给出的恢复时刻（`probeRateLimitedAt` / `probeOutOfCreditAt` + 相对时长）。

### Fixed

- **图片输入的默认值不再采信平台标记** —— 上游 `is_vl` 是**平台**声明而非模型原生能力（内置目录里几乎全是 `true`，连纯文本模型也是），据此默认勾选会在纯文本模型上开出图片输入、一发图即 400。改为按精确 model id 键控的人工核对表（`native-modality.ts`），只有文档确认 `multimodal` 才预勾选，未核实一律不勾。
- **图片勾选改为独立持久集合** `regions.<region>.imageModelKeys`（原与 `lastCatalog` 快照耦合，目录重写可能连带改变图像答案），运行时只从该集合派生图像能力。
- **「可关闭思考」增加校正机制** —— 上游声明的 `canDisableThinking` 不可全信（workbuddy 实测有模型对 `reasoning_effort:"off"` 直接 400，且失败会在此后每次请求重演）。新增 `off-thinking.ts`：拒绝集 + 首读种子 + 运行时盖印。本插件暂无实测样本，拒绝集留空而非虚构（行为不倒退，有样本时加一行即可生效）。
- **脱敏缺陷** —— `redactUpstreamText` 原实现 `'$1[redacted]'` 把含密钥的捕获组原样保留，等于没有脱敏；改为 `key=` 保留键名抹值、裸 `pt-` token 整段替换。
- **账号删除改为二次确认** —— vault 是这些账号的**唯一**存储位置，硬删无法找回（workbuddy 的删除是可找回的「暂时隐藏」，故它不需要确认）；两步内联确认替代一键删除。
- **探针结果按区域分别存放** —— 原为扁平命名空间，切换 tab 会串台；改为与 workbuddy 同构的按区域键控，刷新目录不再丢失已测结果。
- **账号池目标下拉补失效项** —— 已保存但已下架的 `targetModelId` 缺少自己的 option 时，受控 select 会退回显示第一项而值仍是旧 id（显示与取值分叉，下次保存又把旧 id 写回）；补一个 disabled 的失效项。

### Docs

- README / README.en.md（双语）更新为 0.2.0 的多账号池、转移、上下文预算与 composer 积分能力。
- 新增 [`docs/DESIGN.md`](docs/DESIGN.md)：模块结构、凭据与账号池、以及从 workbuddy 继承的三条「已修缺陷」教训与取舍依据。
- 新增 `scripts/probe-cosy.mjs`（不依赖宿主直连 cosy 链路验证）与 `scripts/dump-vault.mjs`（只读 dump vault / 账号池测量），并加 `pnpm run probe:cosy` / `probe:vault` 入口。

### Tests

- 测试覆盖从 9 个 spec / 82 用例扩到 **21 个 spec / 349 用例**：为此前零测试的 host 模块补齐规格（account-pool 三件套、accounts vault、credentials、transfer、probe、credential-recovery、web-status 全路由、adapter、native-modality、off-thinking，并扩展 catalog）。
- 测试基建对齐 workbuddy：per-file 隔离 `DSH_HOME`（`tests/setup-per-file-home.ts` + `vitest.config.ts` 的 env 隔离），避免 vault/账号池/心跳文件在用例间互相污染。

## 0.1.0 (2026-01-01)

首个公开发布版本。

### Features

- **双区域并行接入** —— 国内版注册为 `qoder` provider（`gateway.qoder.com.cn`），国际版注册为 `qoder-global` provider（`api1.qoder.sh`）；有 PAT 的区域其模型出现在 DSH 模型选择器里，两个 provider 可同时使用。
- **PAT 凭据** —— 设置卡片内粘贴（`regions.<region>.pat`）或环境变量（`QODER_PERSONAL_ACCESS_TOKEN` / `QODERCN_PERSONAL_ACCESS_TOKEN`），设置项优先；凭据只写入本地插件配置，从不进入网络请求。
- **模型目录与倍率** —— 从 cosy 网关实时拉取模型清单，价格因子以内嵌 `· xN.NN` 显示；逐项勾选启用（`enabledModelKeys`），保存立即生效；上游不可达时回退内置静态目录。
- **用量概览** —— 每区域只读展示基础额度 / 附加额度 / 组织额度的已用、总量、剩余、占比与到期时间。
- **模型可用性测试** —— 卡片内对单个模型「测一测」，直达上游确认可用性，限流 / 凭据无效 / 内容审核分别报因。
- **区域开关（opt-out）** —— 每个区域右侧勾选框，显式取消勾选即把该 provider 从选择器整体撤下；账号配置全部保留，重新勾选即恢复。
- **安全 loopback shim** —— 每区域一个随机端口 + 进程内随机 secret，真实 PAT 不交给 pi-ai。
- **命令行诊断** —— `dsh-connect-qoder doctor|status [--json]`，无需浏览器即可确认 PAT 来源、指纹派生与上游可达性。

### Docs

- README / README.en.md（双语）、CHANGELOG、THIRD_PARTY_NOTICES、RELEASING（发布流程）。
- 收录草稿：`awesome-dsh-plugin-submission/`（Awesome DSH Plugin 注册表）。

### 说明

- 首次发布按 `RELEASING.md` 流程执行；`npm publish` 若走暂存发布（staged publishing），需 2FA 批准后再核对 registry。
