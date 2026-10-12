# 更新日志（Changelog）

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## Unreleased

本轮为「与 dsh-connect-workbuddy 逐模块对等审计」的修复轮：以下各项均以 workbuddy 的已验证行为为基准，并对照 pi-ai / DSH 宿主源码逐条核实后修复。

### Fixed

- **账号池标题行整体对齐 workbuddy**（用户要求：「这部分区域的样式整体对齐 workbuddy」）：做了一次机械对比，而不是逐处猜。结论是**样式层已经高度一致**——表格 21 条同名规则逐字相同、DOM 类名顺序也完全一致；账号工具框与设置区 9 条同样一致。本轮真正修掉的是标题行：
  - `.dsm-qoder-pool-head`：`gap` 12px → **10px**、去掉 `justify-content:space-between`（workbuddy 同规）。
  - 积分开关改为 workbuddy 的 `pool-head-extra` 形态：**紧挨标题**的直接子项，而不是我上一轮自创的 `.dsm-qoder-pool-head-right` 分组（那多包一层、还改了换行与间距行为）。那个自创类已删除。
  - 「当前使用」芯片改用 `margin-left:auto` 靠右（workbuddy 同规）：开关文案长度随区域变化时芯片不再左右晃。
  - `.dsm-qoder-credits-switch`：`display:flex` → `inline-flex`（它现在嵌在标题行里）。
  - 保留三处**有意保留**的差异（都是前几轮用户明确要求的，不回退）：账号池 `padding-top:8px`（要求收紧空档）、保存行去掉 `flex-wrap`、按钮组去掉 `flex:none`（要求两条保存行样式统一）。
- **tab 栏不再顶着上面的分隔线**（用户实拍：「国际版 国内版 不要顶着上面这条线，最基本的统一样式」）：`.dsm-plugin-card-body` 这条家族共享规则只有 `padding:0 0 8px`——**上内边距为 0**，所以正文的**首个元素必须自带顶部间距**。workbuddy 的 tab 栏正是被 `.dsm-workbuddy-usage`（`padding:16px 0 4px`）托住的；qoder 这边在上一轮删掉积分块时，把那层容器一并拆掉了，于是 tab 栏直接贴在分隔线上。现在用同一条规则 `.dsm-qoder-usage`（本就存在）恢复同样的 16px 呼吸空间——不是新加特例，是恢复与同族插件一致的结构。
- **「在对话框显示积分」开关移到账号池标题行**（用户要求：「放到账号池这个标题旁边吧，节约点空间」）：它此前在卡片正文里独占一行，约 30px 高却只有一个勾选框。现在渲染在 `pool-head` 右端、排在「当前使用」芯片**之前**（可操作的控件在状态之前）。卡片仍然持有写权限与区域，所以由卡片构造这个节点、经 `creditsSwitch` prop 交给账号池安置（与 `accountTools` 同规）；原来那个只为它存在的 `.dsm-qoder-credits-row` 外壳随之删除。语义也更顺：它决定「积分怎么显示」，而积分明细正是下面那张表的内容。
- **「在对话框显示积分」那行上移**（用户实拍：「红色的部分向上靠拢一些」）：额度明细移除后，那一行仍套着为明细列表准备的 `.dsm-qoder-usage`（`padding:16px 0 4px` + `gap:16px`），连同 `.dsm-qoder-credits-switch` 自己的 `margin:8px 0 2px` 与账号池区块的 `padding-top:16px`，三处叠加出约 19px 的空档。现在：这一行换成自己的外壳 `.dsm-qoder-credits-row`（`padding:12px 0 2px`）、开关的 margin 归零（间距由外壳统一负责）、账号池的 `padding-top` 收到 8px。分隔线之上只剩约 11px。
- **「添加 PAT」那一行补上就地说明**（用户要求：「添加 PAT 后添加文本（登录网页 qoder.com / qoder.com.cn → 服务集成 → 新建令牌），国际国内域名不同」）：
  - 文案放在**入口这一行**（标签与按钮之间），而不是只留在对话框里的文档链接 —— 用户看到这个入口的瞬间，最想知道的就是「去哪弄一个令牌」。
  - 域名逐区域不同，由 `region` 决定：国内 `qoder.com.cn`、国际 `qoder.com`。
  - 新增 `QODER_CONSOLE_DOMAIN` 常量，与已有的 `knownQoderRegionOfDomain`（域名反查区域）**放在一起维护** —— 同一组事实的两种读法，分开放就很容易漂移而不被发现。
  - 注意国际版用的是**控制台域名 `qoder.com`**，不是网关用的 `qoder.sh`：用户在浏览器里看到的是前者。
  - `.dsm-qoder-bar-hint` 用 `flex:1 1 auto` + `min-width:0`：吃掉标签与按钮之间的余量，窄卡片上折行到按钮上方，而不是把按钮挤出可视区。
  - 新增 4 条渲染测试（两种区域的域名、同一行的顺序、域名表本身），防止两处域名漂移。
- **修掉 400 `developer is not one of [...]`：必须显式关闭 pi-ai 的 developer 角色**（用户实拍上游 400）。
  - pi-ai 的 openai-completions API 这样决定系统提示词的角色：
    ```js
    const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole
    const role = useDeveloperRole ? 'developer' : 'system'
    ```
    Qoder 上游只接受 `system` / `assistant` / `user` / `tool` / `function`，收到 `developer` 直接 400。
  - **这个分支只在同时满足「reasoning 为真」与「compat 未显式关闭」时才走。** 我让档位真正生效后 `reasoning` 从 false 变 true，把第一个条件打开了；`supportsDeveloperRole` 的默认值是**开启**，于是第二个条件也成立 —— 两个改动叠加才暴露出来（这也是为什么它此前一直没出现）。
  - 修法：`compat` 显式写 `supportsDeveloperRole: false`，系统提示词恒以 `system` 角色发出。`supportsReasoningEffort` 保持不变（档位功能不受影响）。
  - 新增两条回归测试：从真实适配器取出 pi-ai provider，断言推理模型 `reasoning === true` **且** `compat.supportsDeveloperRole === false`；非推理模型同样关闭。
- **「Provider is not configured」的真正原因：`auth.apiKey.resolve` 返回了 `undefined`**（用户实拍，并再次提示我去查参考项目 —— 两次都对）。
  - **错误文案的真实来源**（不在我们的代码里，在 vendored 的 pi-ai 里）：
    ```js
    // pi-ai dist/models.js → applyAuth
    const resolution = await this.getAuth(model, {...})
    if (!resolution) throw new ModelsError('auth',
      `Provider is not configured: ${model.provider}`)   // ← 用户看到的那句
    ```
    而 `resolve.js` 在「没有存储凭据」时会退回 ambient，调用 provider 自己的 `auth.apiKey.resolve({ credential: undefined })`。
  - **我们的 resolver 无条件 `return undefined`** → `getAuth` 返回 undefined → 直接抛错。**问题不在档位、不在目录、不在区域注册，而在这一行的返回值形状。**
  - **正确形状**（`dsh-llm-pi-ai` 自己的 `harnessApiKeyAuth()` 就是这样）：
    ```js
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === void 0 ? {} : { apiKey: credential.key },
      source: name,
    })
    ```
    关键：**即使没有 key 也必须返回一个对象**（`auth: {}`），把「是否真的需要 key」交给协议层判断；返回 `undefined` 才等于宣称「这个 provider 根本没配置」。
  - 本 route 的真实凭据不从这里来 —— 它靠 shim 的进程内 secret 认证，secret 由 `PiAiAdapter` 的 `resolveApiKey` 逐请求提供。所以 resolver 报「没有 key」是诚实的、也是正确的，只要它是一个对象。
  - 测试：新增两条，**走真实的 `createQoderAdapter`**（从 `piProvider.auth.apiKey.resolve` 取 resolver 调用，而不是复制一份实现），并做了**变异验证**：退回旧实现后两条立刻失败。
  - 前面两轮（档位 map 全 null 会作废整条路由）也是真实缺陷、也修掉了 —— 但它不是「not configured」的原因；我当时把两个不同层级的失败混为一谈了。
- **修掉「Provider is not configured: qoder」的真正根因**（用户实拍，并提示「之前参考的项目都是怎么做的」——对照 trae/workbuddy 的 `modelErrors`/`defaultContextWindow` 注释后，去 DSH 内核源码里找到了硬校验）。
  - **根因**：DSH 内核（`dsh-llm`）对适配器返回的推理元数据是**硬校验**的：
    ```js
    if (reasoning.efforts.length === 0)
      throw new LlmError('adapter returned invalid reasoning metadata …', 'INVALID_MODEL_REASONING')
    ```
    而 `dsh-llm-pi-ai` 的 `getSupportedThinkingLevels()` 把 `thinkingLevelMap[level] === null` 判为「不支持」，并把 `xhigh`/`max` 额外要求 `!== undefined`。于是**「全 null 的 map」解析出零个档位**。
  - 我此前在「上游没声明档位」时**仍然**返回全 null 的 map。上游的 `auto` 与 `qmodel_latest` 恰恰不声明 `thinking_config.efforts` → 零档位 → **整条 provider 路由被 DSH 作废**。用户看到的是「Provider is not configured: qoder」，而不是「这个模型没有档位」。
  - **修法**：`qoderThinkingLevelMap` 在「没有一个真实档位」时返回 `undefined`（而不是全 null 的 map）。DSH 读作「该模型不提供推理」→ 不渲染档位选择器（正确的降级），路由保持健康。
  - 新增两条回归测试：一条复刻 DSH 的 `getSupportedThinkingLevels()`，对九种上游形状断言「map 为 undefined，或至少解析出一个真实档位」——即**任何模型都不会让整条路由作废**。
  - 教训：`provider 整条路由」与「单模型能力」是两个层级。单模型的元数据写错，代价是整条 provider 消失，所以「降级」必须比「声明」更保守。
- **思考档位改为只映射上游**真正声明的档位**（用户要求：「学习 workbuddy 一样，显示可以选择的档位，然后保存到 DSH 自己的模型设置里」）。
  - 对照 workbuddy 发现两处关键差异：
    1. **workbuddy 的档位是「只显示」的纯文本**（`model.reasoning.supportedEfforts.join(' / ')`），它不保存用户选择；用户要的是**可选 + 存到 DSH**，所以保留 qoder 已有的可保存选择，只对齐它「显示哪些档位」的判断。
    2. **workbuddy 的 `workBuddyThinkingLevelMap` 只映射上游声明过的档位**（`supported.includes(level) ? level : null`）——DSH 的模型设置里因此只出现真实存在的档位。而 qoder 此前把六个档位**全部**置 `null`，只在 `off` 上有效：我当时的结论是「Qoder 的线是布尔 `is_reasoning`，表达不了半档」。**那个结论是错的** —— `thinking_config.enabled.efforts` 逐模型声明了真实档位，且不统一（Qwen 系 `xhigh/low/medium`，DeepSeek/GLM 系 `high/low/max`）。
  - 修法：`qoderThinkingLevelMap` 按声明映射**同名**档位，未声明的置 `null`；上游声明可关闭时额外给 `off`。上游没声明任何档位时仍给出 map（全 `null`），因为模型确实是推理模型 —— DSH 据此知道它支持推理，只是没有可选项。
  - 请求线不变：shim 侧仍按 `reasoning_effort` → 顶层 `reasoningEffort` + `parameters.reasoning_effort` 发送。
  - 实测效果：DSH 模型设置里 `Qwen3.8-Flash` 出现 low/medium/xhigh，`DeepSeek-V4-Pro` 出现 high/max（+可关闭）。
- **卡片改读实时目录，思考档位这才真正出得来**（用户实拍「还是没有思考强度」——即使刚点过「从 Qoder 刷新」）。
  - 上一个提交只修了 schema（字段不再被剥掉），但**没有解决「卡片读的是哪份目录」**。
  - `displayModels()` 的优先序是「保存的 lastCatalog → 实时目录 → 静态兜底」，而卡片读的就是它。`lastCatalog` 是**上一次保存时的快照**：上游后来声明的档位（`thinking_config`）只存在于实时目录里，快照里没有 → 卡片永远不渲染档位选择器。更糟的是旧 schema 已把档位从快照里剥掉，于是那份快照**永远不会**再有档位。
  - 修法：
    - 新增 `fullCatalog[region]` 保存**未过滤的实时目录**（`refreshRegionCatalog` 拉到的完整列表，含上游声明的档位）；
    - `displayModels()` 改为**实时目录优先**：反映上游当前声明了什么，保存快照退居兜底。
  - 静态兜底列表（`QODER_FALLBACK_MODELS`）**没有**档位是刻意的 —— 它是猜的，不该编造上游没声明的档位名；此时卡片不渲染档位选择器，等真实目录到达后自动出现。
  - 验证：实测上游确实返回档位（`qfmodel` → `['xhigh','low','medium']`，默认 `medium`；`dmodel` → `['high','max']`），且 `parseUpstreamModel` 解析正确。
- **修掉「拉取的思考模式又不见了」：保存的模型目录丢字段**（用户实拍）。
  - 客户端**确实**把 `thinkingEfforts` / `defaultThinkingEffort` / `contextTiers` 写进了 payload（`buildModelsPayload` 里三个字段都在）。
  - 但宿主的 `modelConfig` **没有声明**它们。schemastery 解析保存的 `lastCatalog` 时会**静默剥掉未声明的字段** —— 于是磁盘上根本没有这些字段，重启后 `thinkingEfforts === undefined`，卡片按「缺失就不渲染」的规则把整个档位选择器隐藏掉。
  - `modelFromStored` 同样没有把这两项读回来。
  - 修法：schema 里补上三个字段（`required(false)`，保持「缺失即不干预」），`modelFromStored` 把它们读回。
  - 新增回归测试：用真实的 region schema 验证「保存 → 读回」三个字段都不丢。
  - **教训**：这是同一类 bug 的第三例——「客户端写了，但读回时被丢弃」。写字段与读字段必须成对，且要有 round-trip 测试兜底。
- **修掉「保存模型保存不了」：`__save` 路由没有按区域合并**（用户报告「现在保存模型保存不了是什么原因」）。
  - **客户端**只发它要写的那**一个**区域（`{ [region]: value }`）——它读不到另一侧的当前状态，无法自己做合并。
  - **宿主路由此前**把这个 body **整个**写进 settings（`deps.settings.set(field, body.value)`），于是**保存 cn 模型的这一次操作会静默删掉整个 global 槽位**。
  - 后果已经发生：磁盘 `cordis.patch.yml` 里 `regions` 只剩 `cn`，`global` 的全部配置被抹平。用户看到的现象是「保存不了」，而实际被抹掉的是另一侧的一切。
  - 修法：宿主有 `settings.describe()` 能读到现值，所以合并放在服务端做（`mergeSlotWise`）：请求里出现的区域**整份替换**，未出现的区域**原样保留**；顶层其他字段一并保留。槽位内部的字段级合并仍由客户端的 `nextRegionModels` 负责（它从现槽位起 merge）。
  - 新增回归测试，并做了**变异验证**：把合并去掉，该测试立刻失败（防止写成永远绿的断言）。
- **修掉真正的根因：`<p>` 的浏览器默认边距**（用户实拍「还是没有改善」）。前两次我都在调容器的 `gap`/`padding`，但那根本不是空白的来源 —— `.dsm-qoder-usage-hint` 渲染成 `<p>`，而**浏览器默认给 `p` 加 `margin:1em 0`（上下各 16px）**。本文件里其他每一条渲染成 `<p>` 的规则都写了 `margin:0`，**唯独它和 `.dsm-qoder-hint` 漏了**。于是那 16px 一直顶在那里，改容器当然「没有改善」。
  - 修法：两条规则都显式 `margin:0`，上下间距真正交还给容器控制（`usage-hint` 用 `padding:6px 0 6px 19px`）。
  - workbuddy 的同名规则有同样的遗漏（所以那边同样偏松），但此处按用户的判断修，不做「保持一致」。
  - 新增一条**机制性**测试：凡渲染成 `<p>` 的类，其规则必须含 `margin:`。这类 bug 靠看截图很难定位（浏览器默认样式不出现在任何 CSS 文件里），但可以机械拦住。
  - 同时修掉了测试辅助函数 `ruleOf` 的正则未转义类名里的点 —— 它此前会把 `.dsm-qoder-hint` 当成通配模式匹配，可能命中别的规则或匹配不到（假绿灯）。
- **「保存的模型」终于真的生效了（第 2 次修，这次找到了架构层面的根因）**（用户实拍：「模型的保存还是不对」）。我上一次只改 `deriveCatalog` 本身，那是治标。真正的根因是**两个模型视图被我混成了一层** —— workbuddy 分得很清楚：
  | 视图 | 数据源 | 是否按勾选过滤 | 谁在读 |
  |---|---|---|---|
  | 运行时目录 | `stacks[region].catalog` | **✅ 过滤** | 适配器 `getModels()` → **DSH 内置选择器** |
  | 卡片显示 | `displayModels()` | ❌ 不过滤 | 卡片的模型列表（要能勾上未勾的） |
  - 我此前把过滤放在 `registerModelDiscovery` 回调里，而 **DSH 的选择器读的是运行时目录**（经适配器 `getModels()`）—— 过滤根本没作用到用户看到的那份列表上。
  - 更要命的是 `applySelection()`：它在**每次配置写入时**跑，把完整目录重新装回运行时目录，直接覆盖掉刷新时的过滤结果。这就是「保存了还是一整份」的直接原因。
  - 现在：运行时目录在两处（刷新、配置写入）都按勾选过滤；卡片改走新增的 `displayModels()`（上次保存 → 实时目录 → 静态兜底，workbuddy 同规），所以未勾选的模型仍在卡片里可见、可勾。
- **DSH 选择器里的模型名补上倍率**（用户实拍：「模型没有倍数」）。卡片自己的列表早已把倍率画在名字旁，但适配器交给 DSH 的 `name` 是裸名字（`info.displayName`），于是同一个模型在两处显示不一致。现在与 workbuddy 同规，`toPiModel` 用 `modelDisplayName(info)`，选择器里显示成 `Qwen3.7-Max · x1.00`。纯显示改动：DSH 侧所有关联都按模型 id 做（选择器当前项、会话事件、agent 默认模型、请求线上的 `model`）。
- **接通每日签到（Qoder 确实有，此前是我误判为「没有」）**（用户指出「qoder有签到啊」——用户是对的）。我早期把 `checkinSupported` 写死为 false，注释还写着「网关没有签到端点」，那是**没实测就下的结论**：真实路径叫 `campaigns`（活动/权益），名字里没有「签到」二字，所以照着 checkin / signin / reward 猜必然 404（实测猜了 13 个）。以「我猜不到」论证「不存在」是方法论上的错误。
  - **协议**（社区参考实现 L0NE-6/Qoder-Daily，已在本机 CN 账号实测通过）：`GET {openapi}/sash/api/v1/me/campaigns?forceRefresh=true` 拉活动，`POST …/{campaignId}/claim` 领取；认证用与用量查询同一套 `jt-` 令牌，另需 `cosy-clienttype:10` 与 `user-agent:Qoder`。只有 `actionType=CLAIM_BENEFIT` 且 `claimStatus=CLAIMABLE` 的可领；重复领取（`CLAIMED` / 409 / `ALREADY_CLAIMED` / `replayed`）是幂等的「今日已领」，**不算失败**。实测你的账号返回 100 Credits / 30 天有效、状态 `CLAIMED`，与桌面端截图一致。
  - **`checkinSupported` 改为真实检测**：CN 为 true、国际版暂为 false（国际版同样有该活动，但需要本机 UMID 组件生成的设备风控头 `Cosy-MachineToken/MachineCode/MachineType`，未接通——字段保留，卡片按它隐藏整列）。
  - **UI 对齐 workbuddy**：账号池表格补回「签到」列（5 列 grid，规则本就存在）、批量动作里补回「一键签到所有账号」（primary、排最前，签到是唯一带来收益的动作），以及签到日志（逐账号三态：已领取 N Credits / 今天已领过 / 失败原因）。签到单元格是**三态**而不是两态——还没读到的账号说「未知」，不说「未签到」，否则会与用户刚亲眼看到的领取结果矛盾。
  - 签到会改变积分余额，因此批次结束后作废该区域的用量缓存，卡片不会继续显示领取前的数字。
- **卡片正文不再重复额度明细**（用户实拍：「红色框出来的部分，也不需要了，因为下面已经显示了」）：那行「附加额度 · 92 / 100 (12/31, 08:00 到期)」与账号池表格的「积分」列是同一组数字（连日期的分钟都一致），而池里是**逐账号**显示、粒度更细。成功状态下这一块不再渲染；`renderCredits` / `bucketLabel` / `formatDate` 三个随之失去引用的函数一并删除。
  - **但「读不到」的情况保留**：池行只能显示一个「—」，说不出原因，而 `creditsError`（凭据被拒 / 上游未响应）只存在于这份 usage 文档里——池行拿不到。所以现在只渲染失败文案，成功时什么都不显示。这一条同样有测试守着（做过变异验证：把失败文案也删掉，测试会失败）。
- **幽灵成员（凭据已删除的池成员）改为自动清理，不再提示用户**（用户实拍：「这个我之前移除了 2 个 PAT，你应该直接就清理掉，而不是再给我这么一个提示，而且我测试的时候这两个也会涵盖进去」）。三处一起改：
  - **客户端自愈**：`memberAccountIds` 里留有已删除凭据的 id 时，静默把名单收敛为实际存在的成员并写回（`pruningRef` 防重入；只在不脏、不忙、可写时动手——正在编辑草稿时偷改会覆盖用户的选择）。原先那句「有 N 个已保存的账号当前没有可用的 PAT……**再保存一次即可移除它们**」把插件的内部记账问题推给了用户：他删完 PAT 还得回来再点一次保存，而他本来就不想要这些账号。文案键 `poolGhostMembers` 与 `ghostMemberIds` helper 一并删除。
  - **测试路径不再遍历空壳**（用户指出的「测试的时候这两个也会涵盖进去」）：批量测试此前对 `memberAccountIds` **原样**建目标，于是每个幽灵 id 都被「测」一遍，只得到一条假的 `credential-rejected`（`no stored credential for this account`），白跑一轮还往池里写脏数据。现在先 `credentialFor` 过滤，只测真的有凭据的成员。
  - 残留的探针记录无害、也不再增长：failover 排名在 `credentialFor === undefined` 时就 `continue`，压根不会读到它们的探针；而新的批量测试不会再为幽灵 id 写记录。
- **账号行删掉「重新读取账号」与「移除」两个按钮**（用户实拍：「现在都不用授权文件了，哪里还有什么重新读取账号」）：
  - 「重新读取账号」做的事（重读快照 + 刷新）现在由账号池的测试/添加等操作自动完成，而「重新读取**授权文件**」这个语义本身早已过时——凭据走 PAT，不再依赖授权文件。用户说得对，这个按钮不该存在。
  - 「移除 · <账号>」与账号池表格的「移除」是**两个不同操作**（前者删保险库里的 PAT 记录，后者只把账号移出池成员），摆在一起只会让人分不清删的是哪一个。保留池里的那个；真要清理凭据用 `dsh-connect-qoder logout`。
  - 连带清理：`rescanAccounts` / `removeVaultAccount` 两个函数、`confirmRemoveId` state、三个只被它们用到的导入（`QODER_ACCOUNTS_PATH` / `QODER_ACCOUNTS_REFRESH_PATH` / `withQoderRouteAction`）、以及 8 个随之失去引用的文案键。账号选择器（多账号时手动指定）保留——它仍是账号池不可用时唯一的指定入口。
- **积分区不再把同一组数字说两遍**（用户实拍圈出要求清理）：顶部那行「92 Token 余额 · 最近积分包 12/31 过期」是**合计**，紧接着的「附加额度 · 92 / 100 (12/31 到期)」是同一组数字的**明细**（还带进度条）。合计行删除，只留明细；`usageToken` / `usageNearestExpiry` / `usageExpiringSoon` 三个随之失去引用的文案键一并清掉。「即将过期」的信息没有丢——账号池的每个账号行各自标 `pool-soon` / `pool-soon-plain`，那里的粒度更有用（哪个账号要过期）。顺带删掉 `renderCredits` 里一个算出来从没用过的 `pct` 变量。
- **积分（用量）查询一直 401 —— 用错了凭据**（用户实拍「没有积分」，并指出令牌明明是新的）。`fetchUsage` 打 `{openapi}/sash/api/v2/me/usage` 时带的是 **COSY 签名 bearer**（和聊天/模型列表同一套），而该端点不认它。实测三种凭据（2026-10，CN，同一张有效令牌）：

  | 凭据 | 结果 |
  | --- | --- |
  | 裸 PAT `pt-…` | 401 `TOKEN_EXPIRE / token is not active` |
  | COSY 签名 bearer | 401 `TOKEN_INVALID / invalid token` |
  | jobToken 的 `securityOauthToken`（`jt-…`） | **200 + 完整 `qoderUsage`** |

  `sash` 是**浏览器会话面**的接口：缺 Authorization 时它回 `UNAUTHORIZED / missing cookie header`，可见它本为 cookie 会话设计，既不收 PAT 也不认 cosy 协议头。`TOKEN_EXPIRE / token is not active` 这条消息误导性极强——它让人以为令牌失效，实际只是「这种凭据不适用于这个端点」。新增 `jobTokenGet()`（只换 Authorization，不带 cosy-* 头）专供 `sash` 系列取数；`fetchUsage` 改用它，PAT 直连降为兜底。测试锁住「带的必须是 jt- 令牌」。
  - 顺带修正 `docs/PAT.md`：原文据此把「积分读不到」写成了「令牌可能坏了」，已改为「令牌有效性不能只看单一端点」并附上面这张实测表。
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
- **思考强度：从「一行只读文字」做成真正可用的设置**（用户指出「没有地方可以选择」）。上游模型条目带 `thinking_config.enabled.efforts`（实测形状 `{xhigh:{}, low:{}, medium:{is_default:true}}`，键即档位名）；上一轮只在模型行渲染了一行只读文字，这一轮补上真正的选择器与**发送链路**：逐模型保存的 `thinkingEfforts`（一项设置——选好保存后每个请求自动带上，与 Qoder 客户端的 `reasoning-effort-changed` 同形态），卡片上是带「跟随上游默认」选项的下拉。
  - **档位确实发得出去**（修正上一轮的错误判断）：我此前查了 `model_config` 只有四个字段就断言「发不了档位」——查得不够。档位走的是**另一个字段**：反编译 Qoder 官方客户端（`app.asar.unpacked` 里的 agent SDK）可见请求体为 `{..., reasoningEffort:"none", parameters:{...A.parameters, reasoning_effort:"none"}}`，即顶层 `reasoningEffort` 加 `parameters.reasoning_effort` 双写。现在两个位置都写，与官方客户端一致。
  - **选中档位即开启思考**：档位与布尔 `is_reasoning` 是同一件事的两个粒度，所以保存了档位就按开启处理；宿主明确要求 `reasoning_effort: "off"` 时让位（那一刻的意图优先于设置）。
  - **键序不可信**：上游给的顺序是 `xhigh, low, medium`，直接显示会让用户以为 xhigh 是最弱档；解析按强度语义序表（`minimal<low<medium<high<xhigh<max`）排序，未知档位名排在已知档之后以保证顺序稳定。
  - **不是每个模型都有档位**：`auto`、`qmodel_latest`、`mmodel` 等实测 `efforts` 缺失，此时字段缺席、卡片不渲染控件（空控件会让人以为「支持思考却没有强度可选」）；档位名也不统一（Qwen 系 `low/medium/xhigh`、DeepSeek/GLM 系 `low/high/max`），直接显示上游档位名、不做本地化与跨模型比较。

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
- **账号池保存行挪到设置卡片之外**（用户实拍：「还是不对」——上一轮我只改了 CSS 规则，没找到真正原因）：
  - **真正的根因是嵌套**：`pool-save-bar` 被放在了 `pool-settings`（那张 `overflow:hidden` 的带边框圆角卡片）**内部**，于是左端的仓库链接紧贴卡片边框，而上方的「启用账号池」内缩 14px——同一条左对齐线断成两截。workbuddy 里它是那张卡片的**兄弟**。现在移出卡片，它自带的 `border-top` 也正是这一行与卡片之间的分隔。
  - 顺带修掉两条规则的措辞差异（池那条多写了 `flex-wrap:wrap`、按钮组多写 `flex:none`）——同一个「保存行」不该有两套写法。加了 `tests/styles.spec.ts`（纯文本 CSS 断言，不需要 DOM）与 `pool-render` 的嵌套断言把两件事都钉住。
- **删掉账号池尾部重复的区域说明**（用户实拍：「这行字不要，都重复了」）：`poolRegionNote`（「国内版与国际版是完全独立的两个账号池：账号、开关、目标模型互不影响」）与 tab 栏下方的 `tabHint`（「每个 tab 是一个独立供应商……一侧的改动不影响另一侧」）说的是同一件事。删掉池区那条渲染与两份文案键。同时清掉两个本轮失去引用的文案键（`modelReasoning` / `modelReasoningDefault`——思考强度从只读文字改成选择器后不再使用）。
- **探针「来源」药丸接上未知态样式**：`.dsm-qoder-pool-prov-unknown`（带描边）规则早已存在但 JSX 从未使用——来源未知的旧记录此前与「测试写入」渲染得一模一样。同时把失败原因从独立药丸改为并入探针主行（`结果 · 原因`，workbuddy 的 `probeLine` 同规）：该药丸原被硬编码成琥珀色的「live-request」样式，而原因可来自任何失败结果，颜色在说谎；全文仍在行 `title` 中。
- **账号工具移到账号池设置区顶部的虚线框**（用户实拍对照）：「添加 PAT / 导出导入账号」两行此前直接堆在账号行末尾、没有外框；现在与 workbuddy 同构——`pool-tools` 虚线框落在「账号池设置」标题之下、设置说明行之上（两个工具立即生效，说明行讲的是「下面这些偏好要保存」，顺序颠倒会让读者以为工具也要保存）。为此 `AddAccount`/`AccountTransfer` 由卡片注入账号池（`accountTools` prop），因为它们需要卡片的刷新与区域。同时删掉两行常驻说明（`.dsm-qoder-bar-hint` 用法）：workbuddy 的对应行只在等待/完成/出错时出现状态文本，常驻说明把每行撑成三行高，而它讲的「本区域生效的账号」「导出为 JSON…」分别是账号行与弹窗里的话题。导出按钮补上 `accounts.length === 0` 门栏。
- **「正在计费」的行补回左侧竖条**：`.dsm-qoder-pool-row-current` 此前只有 7% 透明的背景色，暗色主题下几乎看不出哪一行在用；现补上 workbuddy 同款的 `inset 3px 0 0` 品牌色竖条（同一个类名的第二条规则）。
- **上下文档位：去掉标签，并修掉重复档位**（用户实拍）：
  - **200K 出现两次**——为了「显式回落原生值」额外前置了一个原生窗口选项，而上游的 `contextTiers` 本身就以原生窗口开头（实测 `[200000, 400000, 1000000]`），于是同一个值渲染了两遍。现在选项**只**来自上游声明的档位。宿主侧 `contextTiersOf` 本来就用 `new Set` 去过重，重复纯粹是客户端多加的那一项。
  - 标签「上下文」也一并去掉（上一轮刚从「DSH 上下文预算」缩短而来）：它紧挨着模型自己的上下文信息（`最大上下文 200,000`），下拉里的 200K / 400K / 1M 已经说明在选什么。可见文字去掉，无障碍名 `aria-label` 保留——读屏用户不能因此失去这一行的含义。
  - **字体样式突兀**（用户实拍）：两个选择器此前复用了账号池表格的 `dsm-qoder-pool-num`——13px、74px 宽、8px 圆角的**实心方块**，放进 11px 的模型行（meta 行与头部控件行）里格外扎眼。改为新的 `.dsm-qoder-inline-select`：无边框、无底色、字号与所在行一致（11px / 16px 行高），读起来像这一行的文字而不是表单控件；箭头由外层 `.dsm-qoder-inline` 的 `::after` 绘制（原生箭头在暗色主题下不可控），hover 才提亮、focus 才出现焦点环。选项列表单独给背景色——系统绘制的下拉不继承行内样式，不加会渲染成一列透明文字。

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
