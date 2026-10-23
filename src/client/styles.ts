/**
 * Client styles for the Qoder plugin card + composer credits readout.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 整套 `dsm-*` 卡片样式系统（卡片外壳、折叠 caret、按钮原语、
 *     `--dsw-alias-*` 主题变量与十六进制回退值、账号池表格、缓冲遮罩、
 *     对话框、composer 面板）逐字沿用自该项目，其又逐字复制自
 *     dingminhua/dsh-connect-trae（MIT）与
 *     dingminhua/dsh-subagent-default-model（MIT）的 SETTINGS_CSS。
 *     沿用的目的与那两个项目相同：**让同族的插件在同一张卡片列表里共享
 *     同一套外部表现语言**——外壳尺寸、按钮形态、圆角、间距、主题变量
 *     都一致，只有各自的功能区不同。
 * 改动：
 *   1. 类名前缀由 `dsm-workbuddy-*` 改为 `dsm-qoder-*`（共享的
 *      `.dsm-plugin-card*` 与 `.dsm-btn*` 保持原名，那是家族语言本身）；
 *   2. 移除 searched-paths 与 OAuth 二维码的样式（Qoder 无此功能），
 *      新增 PAT 粘贴表单用到的 bar / transfer-dialog 类（沿用家族类）；
 *   3. 模型行按 Qoder 上游给的字段（积分倍率、上下文/输出上限、是否支持
 *      推理与图像、默认/免费）排版；探针结果行沿用同一套语义色。
 *
 * @module dsh-connect-qoder/client/styles
 */

export const QODER_CARD_CSS = `
.dsm-plugin-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.dsm-plugin-card:hover{border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-plugin-card-open{background:var(--dsw-alias-bg-layer-2,#25262b);border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-plugin-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dsm-plugin-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-2px}
.dsm-plugin-card-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dsm-plugin-card-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-weight:600;line-height:1.4}
.dsm-plugin-card-description{color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}
/* Pure-CSS caret: the host primitives' chevron icon names differ per DSH line
   (0.1.5 Outline14 vs 0.1.7 OutlineRegular), so no static import can serve
   both. A border caret in the plugin's own CSS is version-proof. */
.dsm-plugin-card-chevron{color:var(--dsw-alias-label-tertiary,#999);flex:none;width:16px;height:16px;position:relative;transition:transform .16s}
.dsm-plugin-card-chevron::before{content:"";display:block;position:absolute;left:4px;top:5px;width:7px;height:7px;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(45deg)}
.dsm-plugin-card-chevron-open{transform:rotate(180deg)}
.dsm-plugin-card-body{border-top:1px solid var(--dsw-alias-border-l2,#36373b);margin:0 16px;padding:0 0 8px}
.dsm-plugin-card-icon{width:32px;height:32px;flex:none;border-radius:7px}
.dsm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-btn:disabled{opacity:.4;cursor:default}
.dsm-btn-outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;font-weight:500}
.dsm-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:rgba(255,255,255,.04)}
.dsm-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsm-btn-primary:hover:not(:disabled){opacity:.9}
/*
 * 卡片正文的第一块（tab 栏 + 说明行）。padding-top 提供与上方分隔线的间距，
 * gap 提供 tab 栏与说明行之间的间距。用户实拍「两个间隔都小点」指的就是这两处：
 * 它们原本各是 16px（与 workbuddy 一致）。
 *   - 上：16px → 10px（仍明显离开分隔线，只是不再空一大截）；
 *   - 中：gap 16px → 10px。
 * 下侧 4px 保持：说明行与账号池之间还隔着账号池自己的 padding-top 与边框。
 */
.dsm-qoder-usage{display:flex;flex-direction:column;gap:10px;margin:0;padding:12px 0 2px}
/*
 * Tab 栏：**两格独立的卡片**，不再是「一条通栏长条里塞两个按钮」。
 * 形状照 dsh-connect-trae（用户给了参照图并指出「这个区域的设计，学习一下」）：
 *   - 每格自带 1px 边框 + 圆角 + 自己的底色，格与格之间留 8px 缝；
 *   - **选中的那格**描品牌色边（--dsw-alias-brand-primary）、底色降一层；
 *   - 圆点/供应商名/开关三样都在同一格内，右侧开关前有一条细分隔线，
 *     让「这格是哪个供应商」与「它开没开」读成一个单位；
 *   - 未开启的供应商整格压到 55% 不透明度，而不是只压名字。
 * 通栏那条外框与「按钮自带 inset 边框」一起删掉了：外面一条、里面再一条，
 * 两道边框相距几像素，看起来像渲染出错（trae 的注释里记的正是这一条）。
 */
.dsm-qoder-tabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.dsm-qoder-tab-cell{display:flex;align-items:center;gap:4px;min-width:0;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#2a2c33);transition:border-color .15s,background .15s}
.dsm-qoder-tab-cell:hover{border-color:var(--dsw-alias-label-dimmed,#777)}
/* 选中态挂在 CELL 上：一格一个单位，开关也在这格的边框里。 */
.dsm-qoder-tab-cell-active{border-color:var(--dsw-alias-brand-primary,#5686fe);background:var(--dsw-alias-bg-layer-2,#232529)}
.dsm-qoder-tab{appearance:none;font:inherit;cursor:pointer;flex:1;min-width:0;border:0;border-radius:7px;padding:0;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;font-weight:600;line-height:20px;background:transparent;text-align:left;transition:color .15s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsm-qoder-tab:hover:not(:disabled):not(.dsm-qoder-tab-active){color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-qoder-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
/* 只管字色；边框与底色由上级那条 .dsm-qoder-tab-cell-active 负责。 */
.dsm-qoder-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-qoder-tab-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:baseline}
.dsm-qoder-tab-off{opacity:.55}
/* 开关与名字同一行、靠右，前面一条细分隔线；点击区只包住开关本身，不盖住
   按钮，否则点名字会被当成点开关。 */
.dsm-qoder-tab-switch{display:inline-flex;align-items:center;flex:none;margin-left:auto;padding-left:10px;border-left:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));cursor:pointer}
.dsm-qoder-tab-switch input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-qoder-tab-switch input:disabled{cursor:default}
.dsm-qoder-tab-switch:has(input:disabled){opacity:.6;cursor:default}
/*
 * 积分显示：设置区顶部的**两行**，结构照 dsh-connect-trae 的 .dsm-trae-pref*
 * （用户给参照图，圈出「在输入框工具栏显示积分读数 / 显示位置」这两行，要求
 * 「改成一样的样式」）。三条规矩逐字对齐：
 *   1. 一行一个开关，label 包住勾选框，**整行都是点击区**（不必瞄准那个小方块）；
 *   2. 主标题与副说明分两行：先说「这个开关做什么」，再说「它会带来什么」；
 *   3. 下级控件（显示位置的下拉）**排在主标题右侧同一行**，不甩到卡片另一头
 *      ——推到对面等于把一句话拆成两个物件，中间留半张卡片空白。
 * 上一版是「勾选框 + 短标签 + 下拉」挤在 <h3>账号池</h3> 之后，没有一句可见
 * 说明（三条说明只挂在 title 上，要悬停才看得见）。
 */
/* 底部留 8px：这句说明的下一行就是账号池那条分隔线，而说明自己只有
   padding-bottom:6px —— 实测文字到线只剩 4 CSS px，紧得像贴上去
   （用户实拍：「这里文字和线 距离不对」）。补 8px 后约 12px，与线下到
   「账号池」标题的那截间距相称。 */
.dsm-qoder-prefs{display:flex;flex-direction:column;gap:14px;padding:2px 2px 8px}
.dsm-qoder-pref{display:flex;align-items:flex-start;gap:10px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0);cursor:pointer}
.dsm-qoder-pref input{flex:none;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-qoder-pref-check{inline-size:15px;block-size:15px;margin:3px 0 0}
.dsm-qoder-pref-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsm-qoder-pref-label{font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6)}
/* 「显示位置 [下拉]」：从左侧排起、谁也不拉伸，控件贴着问它的那几个字。 */
.dsm-qoder-pref-lead{display:flex;align-items:center;justify-content:flex-start;gap:10px;min-width:0}
.dsm-qoder-pref-lead .dsm-qoder-pref-label{flex:none}
.dsm-qoder-pref input:disabled{cursor:default}
.dsm-qoder-pref:has(input:disabled){opacity:.6;cursor:default}
.dsm-qoder-pref-hint{color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:17px}
.dsm-qoder-pref span{min-width:0}
/* 这一行没有勾选框，借用它的那一列作内边距，好让标题和上面那条左边缘对齐
   （15px 勾选框 + 10px 间距 = 25px）。 */
/* 第一行先声明这一列，第二行才能吃到同一个值——两行的左边缘因此对齐到
   主标题，而不是各算各的（之前写死 25px，与勾选框的实际尺寸各算各的，
   位置一旦对不上就整体偏左）。 */
.dsm-qoder-credit-toggle{--dsm-qoder-pref-indent:25px}
.dsm-qoder-credit-position-pref{align-items:flex-start;padding-left:var(--dsm-qoder-pref-indent,25px)}
/* 下拉按自己那两个选项的宽度定尺寸，不拉伸：它回答的是一个很短的问题。 */
.dsm-qoder-credit-position{flex:none;max-width:none;margin-top:0;padding:3px 8px;font-size:12px;line-height:16px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:7px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6);cursor:pointer}
.dsm-qoder-credit-position:disabled{cursor:default}
.dsm-qoder-usage-account-actions{display:flex;gap:8px;margin:10px 0 0}
.dsm-qoder-account-confirm{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#2a2c33)}
.dsm-qoder-account-confirm-text{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-qoder-tab-off-notice{color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px;margin:0 0 4px;padding:8px 10px;background:var(--dsw-alias-bg-layer-3,#2a2c33);border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px}
/*
 * 分栏 tab 条（账号 / 模型 / 诊断）。
 *
 * 刻意**不是**上面那两格方块。那两格是区域作用域：二选一，每格还带自己的开关。
 * 这里则是同一份文档的分栏，形状就是宿主自己的设置窗口里那种下划线 tab——
 * 两排方块连在一起会被读成「四选一」。
 *
 * 真正起作用的是每个分栏上的 hidden 属性：非活动栏仍然挂载，所以切回来不重新
 * 拉取、不丢未保存的目录草稿、账号池日志不重建；隐藏同时把它移出无障碍树，这正是
 * role="tabpanel" 要的语义（用 CSS 类做 display:none 会被后面的规则覆盖，hidden 不会）。
 */
.dsm-qoder-panels{display:flex;align-items:stretch;gap:2px;margin:12px 0 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24))}
.dsm-qoder-panel-tab{appearance:none;font:inherit;cursor:pointer;border:0;background:transparent;padding:7px 11px;margin-bottom:-1px;border-bottom:2px solid transparent;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;font-weight:600;line-height:20px;white-space:nowrap;transition:color .15s,border-color .15s}
.dsm-qoder-panel-tab:hover:not(.dsm-qoder-panel-tab-active){color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-qoder-panel-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-qoder-panel-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6);border-bottom-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-qoder-panel{margin-top:12px}
/*
 * 分栏里的第一块不再画自己的上分隔线。
 *
 * 模型区带 border-top + padding-top——那是一列长页里的段落分隔线，作用是
 * 「告诉读者上一段结束了」。可模型区现在是模型栏里唯一的内容，而 tab 条自己
 * 已经有一条 border-bottom：两条线只隔 12px，读起来像渲染出错。段落边界由
 * tab 条表达，第一块就不必再说一遍。
 *
 * 只针对模型区：账号栏的第一块永远是积分偏好那两行（renderCreditsSwitch
 * 无条件渲染），账号池因此总是**第二块**——它要靠自己那条 border-top 把「谁在
 * 服务」与上方的偏好分开（用户实拍要求过那里的间距），所以不动它。
 */
.dsm-qoder-panel > .dsm-qoder-models:first-child{border-top:0;padding-top:0}
/*
 * 诊断栏：两列的事实表，不是散文。每一行都是卡片**真的读到的**一个值，所以一份
 * 问题反馈可以整段引用它，而不是把界面复述一遍。这里没有控件是刻意的——能改设置
 * 的诊断栏，只是一个名字更差的设置栏。
 */
.dsm-qoder-diag{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#232529)}
.dsm-qoder-diag-row{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:8px 12px}
.dsm-qoder-diag-row+.dsm-qoder-diag-row{border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24))}
.dsm-qoder-diag-label{flex:none;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-qoder-diag-value{min-width:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12px;line-height:18px;text-align:right;overflow-wrap:anywhere}
.dsm-qoder-diag-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dsm-qoder-diag-bad{color:var(--dsw-alias-label-caution,#e8b34b)}
.dsm-qoder-diag-hint{margin:10px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
/*
 * 那段说明行（「每个 tab 是一个独立供应商…」）。
 *
 * 它此前**只有** padding-left，上下间距全靠外层容器的 gap 与账号池的 padding——
 * 用户圈出的两处空白正是它的上下。给 line-height 18px 配 6px 上下边距，让这段
 * 与 tab 栏、与账号池标题都保持一个读得舒服但不过分的距离。
 * 上一轮我误把账号池自己的 padding-top 当成其中一处改小了，已恢复。
 */
/*
 * 那句说明行（「每个 tab 是一个独立供应商…」）。
 *
 * 它是 <p>，而**浏览器默认给 p 加 margin:1em 0（16px 上下）**。本文件里其他每
 * 一个 <p> 都写了 margin:0，唯独这条漏了 —— 于是它上下各顶出 16px 浏览器默认
 * 边距，再叠加容器的 gap 与 padding，看起来怎么调容器都「没有改善」：
 * 用户实拍「还是没有改善」，说的正是这个。
 * workbuddy 的同名规则也有同样的遗漏，所以那边同样偏松。
 *
 * 显式 margin:0 之后，上下间距才真正由这里与容器的 padding 控制。
 */
.dsm-qoder-usage-hint{margin:0;padding:6px 0 6px 19px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}
.dsm-qoder-account-error{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px;line-height:18px;white-space:pre-line}
.dsm-qoder-usage-select-wrap{position:relative}
.dsm-qoder-usage-select{appearance:none;width:100%;font:inherit;padding:10px 34px 10px 12px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-3,#2a2c33);cursor:pointer;transition:border-color .15s,box-shadow .15s}
.dsm-qoder-usage-select:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#5686fe);box-shadow:0 0 0 3px rgba(86,134,254,.22)}
.dsm-qoder-usage-select:disabled{opacity:.6;cursor:default}
.dsm-qoder-usage-select-wrap::after{content:"";position:absolute;top:50%;right:12px;width:7px;height:7px;transform:translateY(-65%) rotate(45deg);border-right:1.6px solid var(--dsw-alias-label-secondary,#c6c9d0);border-bottom:1.6px solid var(--dsw-alias-label-secondary,#c6c9d0);pointer-events:none}
.dsm-qoder-usage-text{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary,#b8b8b8)}
.dsm-qoder-usage-error{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-qoder-usage-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.dsm-qoder-models{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:14px}
.dsm-qoder-models-fold{display:flex;flex-direction:column;gap:10px}
.dsm-qoder-models-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsm-qoder-models-title-row{display:flex;align-items:center;gap:6px;min-width:0}
.dsm-qoder-models-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}
.dsm-qoder-models-dirty{margin-left:8px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-state-warn-primary,#f59e0b);color:#1b1d22;font-size:11px;font-weight:600;line-height:16px;vertical-align:1px;white-space:nowrap}
.dsm-qoder-models-summary{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
/* 模型列表：**每一条都排出来，不设高度上限、不自己滚动。**
 *
 * 用户要求：「模型的页面，所有模型要全部呈现，不用滚动条」。这条规则因此**没有**
 * max-height、也没有 overflow-y：盒子高度永远等于内容高度，20 多条目录就是 20 多
 * 行，靠**外层页面**滚动去看它们。同族的 workbuddy 曾经有 max-height:520px +
 * overflow-y:auto，结果是 20 多条只露七八行、其余藏在一条要先发现再拖动、并且叠在
 * 面板滚动条之上的**第二条**滚动条后面 —— 而一个「让人看见并勾选模型」的列表，
 * 恰恰不该是这个形状。
 *
 * overflow:hidden 必须留着，而且是有作用的而不是残留：圆角由这个带边框的盒子画，
 * 不裁剪的话首行与末行会把直角盖到圆角上。现在盒子高度等于内容高度，它不会再裁掉
 * 任何东西。tests/styles.spec.ts 与 scripts/model-list-layout.preview.tsx 分别从
 * 「规则文本」和「真实 Chrome 布局」两侧钉住这件事。 */
.dsm-qoder-model-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;overflow:hidden}
.dsm-qoder-model{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2,#232529);transition:opacity .16s}
.dsm-qoder-model-disabled{opacity:.55}
.dsm-qoder-model+.dsm-qoder-model{border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
.dsm-qoder-model-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.dsm-qoder-model-enabled{display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer;flex:1}
.dsm-qoder-model-enabled input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe);flex:none}
.dsm-qoder-model-image{display:inline-flex;align-items:center;gap:5px;flex:none;cursor:pointer;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-qoder-model-image input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-qoder-model-off{display:inline-flex;align-items:center;gap:5px;flex:none;cursor:pointer;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-qoder-model-off input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-qoder-model-copy{display:flex;align-items:baseline;gap:8px;min-width:0}
.dsm-qoder-model-name{display:inline-flex;align-items:baseline;gap:7px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:500;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-qoder-model-name-rate{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-weight:400;line-height:16px;flex:none}
/*
 * 上游的活动优惠徽标（「错峰 4 折」/「Off-Peak 60% off」）。
 *
 * 文案与颜色都**不是**插件选的：文案是上游 promotion.badge 的原话，颜色则
 * 只有一种——Qoder 的活动字段里没有颜色（对比 workbuddy 的促销给了
 * badge.color），所以这里统一用品牌色系，靠 color-mix 调出淡底+同色描边。
 * flex:none 是关键：模型名会省略号截断，徽标必须不被压缩。
 */
.dsm-qoder-model-promo{flex:none;display:inline-flex;align-items:center;padding:0 7px;border-radius:999px;font-size:10px;line-height:16px;font-weight:600;white-space:nowrap;color:var(--dsw-alias-brand-primary,#5686fe);background:rgba(255,255,255,.08);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#5686fe) 16%,transparent);border:1px solid transparent;border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#5686fe) 40%,transparent)}
.dsm-qoder-model-desc{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}
.dsm-qoder-model-details{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.dsm-qoder-model-meta{display:flex;align-items:center;gap:7px 12px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}
.dsm-qoder-model-meta-tag{padding:1px 7px;border-radius:999px;font-size:11px;line-height:15px;background:rgba(174,179,187,.11);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-qoder-context-budget{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex:none;margin:0;padding:0;border:0;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-qoder-context-budget label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
.dsm-qoder-context-budget input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
/* 思考强度选择器：与上下文选择器同一套观感（两者都是「一项设置」）。 */
.dsm-qoder-effort{display:inline-flex;align-items:center;gap:4px}
.dsm-qoder-effort label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
/*
 * 模型行里的两个选择器（上下文档位 / 思考强度）。
 *
 * 它们**不是**账号池表格里的数字输入框：pool-num 是 13px、74px 宽、8px 圆角
 * 的实心方块，放进 11px 的 meta 行会格外突兀（用户实拍：「这个字体样式很
 * 突兀」）。这里做成「行内值 + 小箭头」：无边框、无底色、字号与所在行一致，
 * 读起来像这一行的文字而不是一个表单控件；hover/focus 才显出可交互。
 */
.dsm-qoder-inline-select{
  appearance:none;
  padding:0 14px 0 0;
  margin:0;
  border:0;
  border-radius:0;
  background-color:transparent;
  background-image:none;
  color:inherit;
  font:inherit;
  font-size:11px;
  line-height:16px;
  cursor:pointer;
  /* 由外层的 ::after 画箭头：原生箭头在暗色主题下不可控。 */
}
.dsm-qoder-inline-select:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-qoder-inline-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px;border-radius:3px}
.dsm-qoder-inline-select:disabled{opacity:.6;cursor:default}
/* 选项列表由系统绘制，不继承行内样式：不加背景会在大面积卡片上渲染成
   透明的一列文字（暗色主题下尤其难读）。 */
.dsm-qoder-inline-select option{background:var(--dsw-alias-bg-layer-2,#24262c);color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-qoder-inline{position:relative;display:inline-flex;align-items:center}
.dsm-qoder-inline::after{
  content:"";
  position:absolute;
  top:50%;
  right:3px;
  width:5px;
  height:5px;
  transform:translateY(-70%) rotate(45deg);
  border-right:1.4px solid var(--dsw-alias-label-tertiary,#999);
  border-bottom:1.4px solid var(--dsw-alias-label-tertiary,#999);
  pointer-events:none;
}
.dsm-qoder-model-capability-note{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-qoder-models-head-actions{display:flex;align-items:center;gap:8px;flex:none}
.dsm-qoder-model-probe{flex:none;padding:3px 10px;font-size:11px;line-height:16px}
.dsm-qoder-model-probe-result{margin:0;font-size:12px;line-height:18px;word-break:break-word}
.dsm-qoder-model-probe-result-ok{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-qoder-model-probe-result-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-qoder-model-probe-result-bad{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-qoder-model-capability-note{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-qoder-model-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:12px}
.dsm-qoder-model-save-error{flex:1;min-width:0;color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px;line-height:16px;text-align:right}
.dsm-qoder-model-actions-buttons{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dsm-qoder-usage-cheer{display:inline-flex;align-items:center;gap:4px;flex:none;text-decoration:underline;text-underline-offset:2px;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5;transition:color .16s}
.dsm-qoder-usage-cheer-star{font-size:12px;line-height:1;display:inline-flex}
.dsm-qoder-usage-cheer:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-qoder-usage-cheer:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:2px}

/* ---- Account pool ---- */
/* 「账号池」标题行夹在**两条线**中间：上面是本块的 border-top，下面是
   .dsm-qoder-pool-actions 的 border-top。要让文字垂直居中，上内边距就必须
   等于它下方那截间距 —— 下方是容器的 gap:12px，所以这里也取 12px。
   原来是 8px，文字因此偏上 4px（用户实拍：「让文字在两条线中间垂直居中」）。
   上一版把上边距压到 8px 是为了回应「红色的部分向上靠拢一些」，那个诉求指的
   是**标题与上方说明行**之间的空档；几何上正解是让标题居中，而不是继续压小
   ——压到 8px 会让它离上线近、离下线远，反而更明显。 */
.dsm-qoder-pool{display:flex;flex-direction:column;gap:12px;margin:0;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
.dsm-qoder-pool-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
/* 「谁在服务」这一槽——池关着是选号下拉，池开着是「当前使用」芯片。
   两者由同一条 margin-left:auto 推到右端，标题行不会在两种状态之间跳。
   下拉此前住在下面设置区自己的一行里，于是同一个账号名在标题行、那一行、
   成员表里各出现一次（workbuddy 94c339f 同规）。 */
.dsm-qoder-pool-head-pick{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:12px}
.dsm-qoder-pool-head-pick-label{color:var(--dsw-alias-label-secondary,#c6c9d0);white-space:nowrap}
/* 积分开关已搬进设置区顶部那两行（形状照 dsh-connect-trae），标题行不再有
   额外的壳——它当初存在只因「开关要和标题挤一行」。 */
.dsm-qoder-pool-current-badge{margin-left:auto;padding:2px 10px;border-radius:999px;background:rgba(86,134,254,.16);color:var(--dsw-alias-brand-primary,#5686fe);font-size:12px;font-weight:600;line-height:18px;white-space:nowrap}
/* 池里没有可用账号时的芯片：灰掉，因为它在说「没有人在服务」而不是「是这个号」 */
.dsm-qoder-pool-current-badge-off{background:rgba(120,120,128,.14);color:var(--dsw-alias-text-secondary,#6b6b70)}
.dsm-qoder-pool-account-select{min-width:200px}
.dsm-qoder-pool-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
/* 模式条：整页的总开关，紧跟标题。沿用 .dsm-qoder-pool-settings 的带边框
   堆叠样式（组件测试把「启用账号池」定位为它里面的第一个复选框），另加一层
   品牌色描边与浅底，让它读作「这一页其余部分由我定义」而不是又一张设置卡。
   开关原先在**页面底部**，比它控制的一切低 400px。 */
.dsm-qoder-pool-modebar{padding:12px 14px;gap:8px;border-color:rgba(86,134,254,.36);background:linear-gradient(180deg,rgba(86,134,254,.10),rgba(86,134,254,.02)),var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-qoder-pool-modebar-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsm-qoder-pool-modebar-label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
/* 模式用文字说出来：开关的位置是一个 20px 的形状要解码，这枚芯片直接说
   现在是哪种模式，也就说清了下面那张表该怎么读。 */
.dsm-qoder-pool-modebar-state{flex:none;padding:1px 9px;border-radius:999px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-brand-primary,#5686fe);background:rgba(86,134,254,.14);border:1px solid rgba(86,134,254,.3)}
.dsm-qoder-pool-modebar .dsm-qoder-pool-dirty{margin-left:auto}
.dsm-qoder-pool-modebar .dsm-qoder-pool-note{margin:0;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
/* 「有人在服务但不在池里」：一条左竖线标它是上一行的旁注，不是警告 */
.dsm-qoder-pool-serving-note{padding-left:10px;border-left:2px solid rgba(86,134,254,.5);color:var(--dsw-alias-label-secondary,#c6c9d0)}
/* 批量动作条：成员区内部一行，所以没有上边框——分隔线会把按钮和上一行
   「已选 N / M」切开，而那两个数字正是这些按钮的作用范围。 */
.dsm-qoder-pool-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsm-qoder-pool-actions-group{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-qoder-pool-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-qoder-pool-note{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-qoder-pool-warn{margin:0;padding:9px 11px;border-radius:9px;font-size:12px;line-height:17px;color:var(--dsw-alias-state-warn-primary,#f59e0b);background:rgba(245,158,11,.09);border:1px solid rgba(245,158,11,.3)}
/* 空状态（这一区一个账号都没有）：不是警告，是引导 —— 用中性色，别让「还没添加」
   读起来像「出问题了」。 */
.dsm-qoder-pool-empty{margin:0;padding:9px 11px;border-radius:9px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-fill-tertiary,rgba(127,127,127,.08));border:1px dashed var(--dsw-alias-border-secondary,rgba(127,127,127,.3))}
.dsm-qoder-pool-error{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-state-error-primary,#ef4444);white-space:pre-line}
.dsm-qoder-pool-table{border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-qoder-pool-row{display:grid;grid-template-columns:1.6fr 1fr 1.3fr .9fr .8fr;gap:10px;align-items:center;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1,#2c2d31);font-size:13px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
/* 没有签到列时（国际版暂不通），把空出的轨道让给操作列。
   CN 有签到，走上面那套 5 列默认值。 */
.dsm-qoder-pool-table:not(.dsm-qoder-pool-table-checkin) .dsm-qoder-pool-row{grid-template-columns:1.6fr 1fr 1.3fr 1.7fr}
.dsm-qoder-pool-row:first-child{border-top:0}
.dsm-qoder-pool-row-head{padding:8px 14px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase}
.dsm-qoder-pool-row-current{background:rgba(86,134,254,.07)}
/* 左侧 3px 竖条：正在计费的那一行必须一眼可见。只靠 7% 的背景色，在暗色主题
   下几乎看不出区别（workbuddy 同规，两条规则共用同一个类名）。 */
.dsm-qoder-pool-row-current{box-shadow:inset 3px 0 0 var(--dsw-alias-brand-primary,#5686fe)}
.dsm-qoder-pool-account{display:flex;align-items:center;gap:8px;min-width:0}
.dsm-qoder-pool-account-name{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsm-qoder-pool-account-name b{font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-qoder-pool-account-name span{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-qoder-pool-account-name .dsm-qoder-pool-current-tag{align-self:flex-start;margin-top:2px;padding:1px 6px;border-radius:999px;background:rgba(86,134,254,.16);color:var(--dsw-alias-brand-primary,#5686fe);font-size:11px;font-weight:600;line-height:16px;white-space:nowrap}
.dsm-qoder-pool-excluded{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-qoder-pool-credits{display:flex;flex-direction:column;gap:1px;min-width:0;font-variant-numeric:tabular-nums}
.dsm-qoder-pool-credits b{color:var(--dsw-alias-label-primary,#e6e6e6);font-weight:600}
.dsm-qoder-pool-soon{font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-qoder-pool-soon-plain{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-qoder-pool-probe,.dsm-qoder-pool-checkin{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#999);min-width:0;overflow-wrap:anywhere}
.dsm-qoder-pool-probe{display:flex;flex-direction:column;gap:4px}
.dsm-qoder-pool-probe-main{color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-qoder-pool-probe-prov{display:flex;align-items:center;gap:5px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#999);min-width:0;flex-wrap:wrap}
.dsm-qoder-pool-prov-tag{padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-tertiary,#999);font-size:10px;font-weight:600;line-height:15px;white-space:nowrap}
.dsm-qoder-pool-prov-live{background:rgba(245,158,11,.16);color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-qoder-pool-prov-unknown{background:var(--dsw-alias-bg-layer-3,#2a2c33);border:1px solid var(--dsw-alias-border-l1,#2c2d31);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-qoder-pool-prov-sep{color:var(--dsw-alias-label-dimmed,#9aa0a6);opacity:.7}
.dsm-qoder-pool-prov-age{color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap}
.dsm-qoder-pool-members{display:flex;flex-direction:column;gap:10px}
.dsm-qoder-pool-members-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsm-qoder-pool-members-title{margin:0 0 3px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-qoder-pool-members-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-qoder-pool-small-btn{padding:3px 10px;font-size:12px}
.dsm-qoder-pool-check{display:inline-flex;align-items:center;flex:none;cursor:pointer}
.dsm-qoder-pool-check input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-qoder-pool-check input:disabled{cursor:default;opacity:.5}
.dsm-qoder-pool-checked{color:var(--dsw-alias-state-success-primary,#22a06b)}
/* 倒计时那一格现在是**唯一**的一句话（不再与「已签到」并排），所以没有 margin-left。
   数字逐秒变化，给它等宽数字（tabular-nums）—— 否则位数一变整格宽度就抖，表格列
   跟着左右晃。颜色沿用单元格本身的 label-tertiary：它就是这一格的主句。 */
.dsm-qoder-pool-checkin-next{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
/* 到点之后同样是主句、不缩进；绿色表示「此刻有事可做」，与「已签到」同色。 */
.dsm-qoder-pool-checkin-due{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-qoder-pool-unknown{color:var(--dsw-alias-label-dimmed,#9aa0a6)}
/* 优先级名次。手动排序用品牌色实心底（这是用户自己定的，是「生效的顺序」）；
   自动排序用虚线灰框（不占位、不抢注意力，也不假装名次已经固定）。 */
.dsm-qoder-pool-rank{flex:none;padding:0 6px;border-radius:9px;font-size:11px;line-height:17px;font-weight:600;color:var(--dsw-alias-brand-primary,#5686fe);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#5686fe) 14%,transparent)}
.dsm-qoder-pool-rank-auto{flex:none;padding:0 6px;border-radius:9px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-dimmed,#9aa0a6);border:1px dashed var(--dsw-alias-border-l2,#3a3d45)}
.dsm-qoder-pool-move{display:inline-flex;gap:2px;margin-left:2px}
.dsm-qoder-pool-move-btn{width:20px;height:20px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);background:transparent;color:var(--dsw-alias-label-secondary,#b6bcc6);font-size:12px;line-height:1;cursor:pointer}
.dsm-qoder-pool-move-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#5686fe);color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-qoder-pool-move-btn:disabled{opacity:.35;cursor:default}
.dsm-qoder-pool-move-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-qoder-pool-not-member{color:var(--dsw-alias-label-dimmed,#9aa0a6)}
/* 一道分节线，不只是间距：过这条线，页面从「池是什么」转到「改它的旋钮」。
   没有这条线，标题就浮在表格下面，主题换了却没有任何标记（workbuddy 同规）。 */
.dsm-qoder-pool-settings-wrap{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:14px}
/* 「更多设置」的副标题：比页面标题低一级，面板只有一个主标题而非两个一样响的。 */
.dsm-qoder-pool-card-head{display:flex;align-items:center;gap:8px}
.dsm-qoder-pool-card-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-qoder-pool-dirty{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-qoder-pool-settings{display:flex;flex-direction:column;gap:1px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#24262c)}
/* Add-PAT + export/import, above the 「更多设置」 heading. */
.dsm-qoder-pool-tools{display:flex;flex-direction:column;gap:2px;border:1px dashed var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;padding:4px 10px}
.dsm-qoder-pool-set{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:12px 14px;border-top:1px solid var(--dsw-alias-border-l1,#2c2d31)}
.dsm-qoder-pool-set:first-child{border-top:0}
.dsm-qoder-pool-set-copy{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.dsm-qoder-pool-set-copy b{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-qoder-pool-set-copy span{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-qoder-pool-set-ctl{flex:none;display:flex;align-items:center;gap:8px}
.dsm-qoder-pool-num{width:74px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:13px;text-align:center;font-variant-numeric:tabular-nums}
.dsm-qoder-pool-select{max-width:260px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:13px;cursor:pointer}
.dsm-qoder-pool-select:disabled,.dsm-qoder-pool-num:disabled{opacity:.5;cursor:default}
/* 提交行：面板在屏期间钉在视口底部。面板比一屏还高，而让任何编辑真正生效的
   两颗按钮原本在它最底部——用户改完的那一刻正好在视口之外，截图里干脆看不见。
   背景必须不透明：内容会从它下面滚过去。（workbuddy 94c339f 同规。） */
.dsm-qoder-pool-save-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:12px;position:sticky;bottom:0;z-index:2;padding-bottom:8px;background:var(--dsw-alias-bg-layer-3,#2a2c33)}
/* 与模型保存行同规：flex-wrap 去掉、按钮组 flex:none 去掉——两行是同一个
   组件族的同一种「保存行」，一行会换行、另一行不会，看起来就是两套样式
   （用户实拍：「这里的样式不统一」）。左端的仓库链接靠 usage-cheer 自带的
   flex:none 保持不压缩。 */
.dsm-qoder-pool-save-buttons{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dsm-qoder-pool-conflict{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:11px 13px;border-radius:10px;background:rgba(245,158,11,.08);border:1px solid var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-qoder-pool-pending{flex:none;align-self:center;font-size:12px;line-height:17px;color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-qoder-pool-conflict-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dsm-qoder-pool-conflict-main b{font-size:12px;font-weight:600;color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-qoder-pool-conflict-main span{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-qoder-pool-log{border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-qoder-pool-log-head{display:flex;align-items:center;justify-content:space-between;padding:9px 14px;background:var(--dsw-alias-bg-layer-3,#2a2c33);border-bottom:1px solid var(--dsw-alias-border-l1,#2c2d31);font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-qoder-pool-log-clear{padding:2px 10px;font-size:12px}
.dsm-qoder-pool-log-body{max-height:186px;overflow-y:auto}
.dsm-qoder-pool-log-row{display:flex;gap:10px;padding:7px 14px;border-top:1px solid var(--dsw-alias-border-l1,#2c2d31);font-size:12px;line-height:18px}
.dsm-qoder-pool-log-row:first-child{border-top:0}
.dsm-qoder-pool-log-time{flex:none;color:var(--dsw-alias-label-tertiary,#999);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dsm-qoder-pool-log-text{min-width:0;overflow-wrap:anywhere}
.dsm-qoder-pool-log-ok{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-qoder-pool-log-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-qoder-pool-log-error{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-qoder-pool-log-info{color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-qoder-pool-log-empty{padding:14px;font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-qoder-pool-row-actions{display:flex;gap:6px;align-items:center;justify-content:flex-end;flex:none}
/* 操作列只有 .8fr（约 88px 内容宽），两颗按钮必须**不换行**：中文可以在任意
   两字之间断行，于是「测试」「删除」会被压成竖排的两个字（桌面宽度下实测）。
   nowrap + 略收窄的左右 padding，比给这一列加宽更划算——加宽要从「账号」列
   拿空间，而账号名那一列本来就挤（名次、箭头、徽章都在里面）。 */
.dsm-qoder-pool-row-actions .dsm-qoder-pool-small-btn{padding:2px 7px;font-size:12px;white-space:nowrap;flex:none}
/* 「删除」在静止态刻意保持中性（outline）：它和「测试」并排，一个中性一个危险，
   每次看都要重新判断哪个会丢数据。危险色留给按下去之后那条确认条里的按钮——
   也就是用户已经明确表达「我要删」的那一刻。 */
.dsm-qoder-pool-delete-btn{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-qoder-pool-delete-btn:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary,#ef4444)}
/* 二次确认就地展开在这一行的操作格里，不弹窗：确认的是什么（哪个账号）必须
   和被确认的那一行待在同一视线内，隔到弹窗里就说错了对象。 */
.dsm-qoder-pool-confirm{display:flex;gap:6px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
.dsm-qoder-pool-confirm-text{font-size:11px;line-height:15px;color:var(--dsw-alias-state-error-primary,#ef4444);text-align:right}
.dsm-qoder-pool .dsm-btn-danger{border-color:var(--dsw-alias-state-error-primary,#ef4444);color:#fff;background:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-qoder-pool .dsm-btn-danger:hover:not(:disabled){opacity:.9}
@media (max-width:760px){.dsm-qoder-pool-row{grid-template-columns:1fr 1fr;row-gap:6px}.dsm-qoder-pool-select{max-width:180px}}
/* Pool switch, namespaced under .dsm-qoder-pool so it cannot collide with host styles. */
.dsm-qoder-pool .sw{position:relative;display:inline-block;width:38px;height:22px;flex:none;cursor:pointer}
.dsm-qoder-pool .sw input{position:absolute;opacity:0;width:0;height:0}
.dsm-qoder-pool .sw-track{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-border-l2,#3a3d45);transition:background .18s}
.dsm-qoder-pool .sw-track::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .18s;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.dsm-qoder-pool .sw input:checked+.sw-track{background:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-qoder-pool .sw input:checked+.sw-track::after{transform:translateX(16px)}
.dsm-qoder-pool .sw input:disabled+.sw-track{opacity:.4}
.dsm-qoder-pool .sw input:disabled{cursor:default}
/* Account action bars: Add-PAT and export/import. */
.dsm-qoder-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0;padding:0}
.dsm-qoder-bar-status{flex:1 1 auto;min-width:0;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#e8e9ed);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/*
 * 「PAT 从哪来」的那一句搬进对话框后，这条 bar 上只剩按钮与（偶发的）状态行；
 * 原来那条「.dsm-qoder-bar-hint」（常驻在标签与按钮之间）已无渲染者，随之删除。
 * 按钮靠 margin-left:auto 仍然贴右端。
 */
.dsm-qoder-bar-actions{display:flex;gap:8px;flex:none;margin-left:auto}
.dsm-qoder-bar a{color:var(--dsw-alias-brand-primary,#5686fe);text-decoration:none}
.dsm-qoder-bar a:hover{text-decoration:underline}
.dsm-qoder-bar-ok{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-qoder-bar-error{color:var(--dsw-alias-state-error-primary,#ef4444)}
/* 同 .dsm-qoder-usage-hint：<p> 的浏览器默认上下边距（1em = 16px）必须显式
   归零，否则行与行之间凭空多出两段空白。本文件里每一条渲染成 <p> 的规则都
   要写 margin:0 —— 这条此前漏了。 */
.dsm-qoder-hint{margin:0;color:var(--dsw-alias-label-tertiary,#999)}
/* The Add-PAT / transfer dialog is deliberately a block: it holds either the
   PAT paste field or a scrollable account list, which cannot live in a one-row
   bar. */
.dsm-qoder-transfer-dialog{margin-top:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;background:var(--dsw-alias-bg-secondary,transparent)}
.dsm-qoder-transfer-dialog p{margin:0 0 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#e8e9ed)}
.dsm-qoder-transfer-dialog-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.dsm-qoder-transfer-list{list-style:none;margin:0 0 8px;padding:0;max-height:180px;overflow-y:auto}
.dsm-qoder-transfer-list label{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary,#e8e9ed);cursor:pointer;padding:2px 0}
.dsm-qoder-transfer-list input[type="checkbox"]{flex:none}
.dsm-qoder-transfer input[type="file"]{font-size:12px;color:var(--dsw-alias-label-primary,#e8e9ed);margin-bottom:8px}
.dsm-qoder-transfer-file{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
/* PAT paste field inside the Add-PAT dialog. */
.dsm-qoder-addpat-input{width:100%;box-sizing:border-box;padding:8px 10px;margin-bottom:8px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e8e9ed);font:inherit;font-size:13px}
.dsm-qoder-addpat-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-qoder-addpat-name{width:100%;box-sizing:border-box;padding:6px 10px;margin-bottom:8px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e8e9ed);font:inherit;font-size:12px}
.dsm-qoder-addpat-name:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
/* 弹窗里的「如何创建 PAT？」入口：小字、品牌色、不抢主按钮的注意力。 */
/* 「PAT 从哪来」的文字路径 + 文档外链合成一块：左侧一道细竖线表示「参考信息」，
   与上面两个待填的输入框区分开。块内段落必须按「对话框 > 块 > 段落」的完整路径
   覆盖边距——「.dsm-qoder-transfer-dialog p」给了 8px 下边距，不覆盖的话两行会散开
   成两块。 */
.dsm-qoder-transfer-dialog .dsm-qoder-addpat-origin{display:flex;flex-direction:column;gap:2px;margin:0 0 10px;padding-left:9px;border-left:2px solid var(--dsw-alias-border-l2,#3a3d45)}
.dsm-qoder-transfer-dialog .dsm-qoder-addpat-origin p{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-qoder-addpat-doc a{color:var(--dsw-alias-brand-primary,#5686fe);font-size:12px;line-height:18px;text-decoration:none}
.dsm-qoder-addpat-doc a:hover{text-decoration:underline}
/* 「按下添加之后会发生什么」——紧贴按钮行上方，弱一档，不与主按钮抢注意力。 */
.dsm-qoder-transfer-dialog p.dsm-qoder-addpat-verify{margin:0 0 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
/* The shared busy veil: a fixed overlay for operations whose result only shows
   up after the list re-read (remove / import / add). It is NOT a modal: no
   control, no dismissal — only "this is running" and "here is why nothing
   moved yet". Fixed positioning so it covers the card regardless of which
   section started the operation, and a semi-transparent backdrop so the table
   stays visible underneath — the user is watching a specific row change, and
   hiding it would defeat the point.

   The mask and the card surface are the HOST's own tokens, not this file's
   invention. --dsw-alias-bg-mask-1 + --dsw-mask-blur is exactly what the
   host's own overlays use (see dsh-client-ui-settings-general's Dws9Sa_mask),
   so the veil now dims the way every other overlay in the shell does instead
   of laying its own black wash on top. The previous hardcoded rgba(0,0,0,.38)
   was tuned against neither theme: too weak next to the host's .24 mask in
   light mode, and it ignored the host's blur entirely.

   bg-layer-2 (not bg-primary, which does not exist in the host's token set
   at all and therefore always fell through to this file's near-black #1b1c20)
   is the same surface the host puts behind its panels — that near-black fallback
   is what made the veil read as a black slab with unreadable text on it. */
.dsm-qoder-veil{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.32));backdrop-filter:var(--dsw-mask-blur);cursor:progress}
/* --dsw-elevation-prominent is the host's own panel shadow (a hairline stroke
   plus two soft layers); the previous 0 8px 28px rgba(0,0,0,.35) was a
   hand-rolled drop shadow that read as a heavy grey box. */
.dsm-qoder-veil-card{display:flex;flex-direction:column;align-items:center;gap:8px;max-width:min(340px,80vw);padding:16px 20px;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.35))}
.dsm-qoder-veil-text{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#0f1115);text-align:center}
/* label-secondary, not label-tertiary: this line carries the operation's
   detail and must stay legible. tertiary is the host's dimmest tier
   (neutral-bluish-600 on light, neutral-bluish-400 on dark) and is meant
   for metadata, not for a sentence the user has to read while waiting. */
.dsm-qoder-veil-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b);text-align:center}
/* The spinner proves the UI is alive when the row under it has not changed yet
   — which is precisely the confusion the veil exists to remove. It follows the
   host's own state spinner (dsh's _dsh-state-dot-spin): an SVG arc whose
   dash breathes while it turns, currentColor so it inherits the tier it sits
   in, and the same 1.5s beat. The previous 18px border-ring at .7s was roughly
   twice the host's speed and visibly out of step with every other spinner in
   the shell — that mismatch, more than the shape itself, is what made it look
   cheap.

   Reduced-motion users get the static arc rather than a frozen ring, matching
   how the host degrades its own spinner. */
.dsm-qoder-veil-spinner{width:20px;height:20px;color:var(--dsw-alias-label-secondary,#61666b);animation:dsm-qoder-veil-spin 1.5s linear infinite}
.dsm-qoder-veil-spinner-track{opacity:.25}
.dsm-qoder-veil-spinner-arc{stroke-dasharray:12 150;animation:dsm-qoder-veil-dash 1.5s ease-in-out infinite}
@keyframes dsm-qoder-veil-spin{to{transform:rotate(360deg)}}
@keyframes dsm-qoder-veil-dash{0%{stroke-dasharray:12 150;stroke-dashoffset:0}50%{stroke-dasharray:24 150;stroke-dashoffset:-6}to{stroke-dasharray:12 150;stroke-dashoffset:0}}
@media (prefers-reduced-motion: reduce){.dsm-qoder-veil-spinner{animation:none}.dsm-qoder-veil-spinner-arc{animation:none;stroke-dasharray:18 150;stroke-dashoffset:-3}}
`

/**
 * Composer credit readout styles, injected by the readout component itself.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   — 该项目的 `WORKBUDDY_COMPOSER_CSS`，类名改为 `dsm-qoder-*`，
 *     其余（尺寸、节奏、主题变量与回退值、表格对齐）逐条沿用。
 */
export const QODER_COMPOSER_CSS = `
.dsm-qoder-composer-credits{display:inline-flex;align-items:center;min-width:0}
.dsm-qoder-composer-credits-trigger{
  appearance:none;display:inline-flex;align-items:center;align-self:stretch;
  padding:2px 6px;border:0;border-radius:6px;background:transparent;
  font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-tertiary,#999);
  white-space:nowrap;cursor:pointer;
  font-variant-numeric:tabular-nums;
}
.dsm-qoder-composer-credits-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-qoder-composer-credits-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-qoder-composer-panel{
  position:fixed;z-index:1100;box-sizing:border-box;
  width:min(248px,calc(100vw - 24px));padding:12px;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));
  border-radius:var(--dsw-radius-lg,14px);
  background:var(--dsw-specific-menu,Canvas);
  box-shadow:var(--dsw-elevation-prominent,0 8px 32px rgba(0,0,0,.22));
  backdrop-filter:var(--dsw-menu-backdrop-filter,none);
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#444);
}
.dsm-qoder-composer-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.dsm-qoder-composer-panel-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,CanvasText)}
.dsm-qoder-composer-panel-refresh{
  appearance:none;flex:none;margin-left:auto;padding:3px 10px;
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.34));
  border-radius:7px;background:transparent;
  color:var(--dsw-alias-label-secondary,#444);
  font:inherit;font-size:11px;line-height:16px;cursor:pointer;
}
.dsm-qoder-composer-panel-refresh:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,rgba(127,127,127,.6));color:var(--dsw-alias-label-primary,CanvasText)}
.dsm-qoder-composer-panel-refresh:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-qoder-composer-panel-refresh:disabled{opacity:.5;cursor:default}
.dsm-qoder-composer-panel-table{
  width:100%;border-collapse:collapse;
  font-size:12px;line-height:18px;
}
.dsm-qoder-composer-panel-table thead th{
  padding:0 0 7px;font-weight:500;text-align:left;font-size:11px;
  color:var(--dsw-alias-label-tertiary,GrayText);
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
}
.dsm-qoder-composer-panel-num{
  text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;
}
.dsm-qoder-composer-panel-table thead th.dsm-qoder-composer-panel-num{padding-right:0}
.dsm-qoder-composer-panel-table tbody th{
  padding:0;font-weight:400;text-align:left;vertical-align:middle;
}
.dsm-qoder-composer-panel-table tbody td{
  padding:4px 0;vertical-align:middle;
  color:var(--dsw-alias-label-primary,CanvasText);
}
.dsm-qoder-composer-panel-table tbody tr.dsm-qoder-composer-panel-row-current td{font-weight:600}
.dsm-qoder-composer-panel-switch{
  appearance:none;display:flex;align-items:center;gap:7px;
  width:100%;padding:4px 6px;margin-left:-6px;
  border:0;border-radius:6px;background:transparent;
  color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer;
  white-space:nowrap;overflow:hidden;
}
.dsm-qoder-composer-panel-switch>span:last-child{overflow:hidden;text-overflow:ellipsis}
.dsm-qoder-composer-panel-who{display:flex;flex-direction:column;min-width:0;gap:1px}
.dsm-qoder-composer-panel-name{overflow:hidden;text-overflow:ellipsis}
/* 第二行的两种文字：原因（不能用的红字，与红点同义）与「当前选用」
   （能用的正向提示，绿字）。此前只有一个琥珀色的 reason 样式。 */
.dsm-qoder-composer-panel-mark{
  font-size:11px;line-height:15px;
  color:var(--dsw-alias-state-error-primary,#ef4444);
}
.dsm-qoder-composer-panel-pick{
  font-size:11px;line-height:15px;
  color:var(--dsw-alias-state-success-primary,#22a06b);
}
.dsm-qoder-composer-panel-switch:hover:not(:disabled){
  background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));
}
.dsm-qoder-composer-panel-switch:focus-visible{
  outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-1px;
}
.dsm-qoder-composer-panel-switch:disabled{cursor:default}
/* 点的颜色由数据驱动（行内 style，见 account-state.ts），这里只留尺寸。
   此前的两条规则把颜色钉死在 CSS 里 -- 面板于是不看数据就报「当前使用」，
   额度用尽的号顶着绿点、能用的号是灰的（用户实拍 2026-10-18）。 */
.dsm-qoder-composer-panel-dot{
  flex:none;width:7px;height:7px;border-radius:50%;
}
.dsm-qoder-composer-panel-foot{
  display:flex;justify-content:space-between;gap:8px;
  margin-top:9px;padding-top:7px;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
  font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,GrayText);
}
.dsm-qoder-composer-panel-empty{margin:0;color:var(--dsw-alias-label-tertiary,GrayText)}
.dsm-qoder-composer-panel-error{margin:8px 0 0;color:var(--dsw-alias-state-error-primary,#d92d20);font-size:11px;line-height:16px}
`
