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
/*
 * 同一条活动规则，但**此刻不在窗口内**（promoDisplayAt 的 pending）。
 *
 * 灰显不是为了好看，是为了让「还没到点」和「正在打折」在同一行里一眼分得开：
 * 两种状态挂着同一句上游文案（「错峰 4 折」），只靠颜色深浅区分会让人读成
 * 「现在就在打折」。所以这里同时换三样东西——品牌色换成 tertiary 灰、底色退回
 * 中性、描边改成虚线（虚线是形状差异，不依赖颜色，色觉障碍与高对比度主题下
 * 仍然成立）。悬停里写明几点生效，那才是这个状态真正的信息。
 */
.dsm-qoder-model-promo-pending{color:var(--dsw-alias-label-tertiary,#9aa0a8);background:rgba(174,179,187,.10);border-style:dashed;border-color:rgba(174,179,187,.32)}
/*
 * 模型选择器里的同两枚徽标（issue #12）。
 *
 * 宿主把这段内容内联进 picker 的模型行，外面没有卡片外壳，所以这里只管三件
 * 事：基线对齐（行高由 picker 决定，抬到 middle 会跟名字错位）、不换行（窄行
 * 里换行会把整行撑高）、以及菜单行里给胶囊一个宽度上限（trigger 行宽，菜单行
 * 窄；不限宽时较长的上游文案会把模型名挤成省略号，主次颠倒）。
 * 颜色、圆角、虚线灰显全部复用上面的 .dsm-qoder-model-promo* 一族，两个表面
 * 不各写一套。
 */
.dsm-qoder-model-label{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;vertical-align:baseline;min-width:0}
.dsm-qoder-model-label-promo{max-width:6em;overflow:hidden;text-overflow:ellipsis}
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
/* 批量动作条：成员卡片内部一行，所以没有上边框——分隔线会把按钮和上一行
   「已选 N / M」切开，而那两个数字正是这些按钮的作用范围。左右内边距跟着卡头
   走，三行的左对齐线才是同一条。 */
.dsm-qoder-pool-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:0 14px 12px}
.dsm-qoder-pool-actions-group{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-qoder-pool-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-qoder-pool-note{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-qoder-pool-warn{margin:0;padding:9px 11px;border-radius:9px;font-size:12px;line-height:17px;color:var(--dsw-alias-state-warn-primary,#f59e0b);background:rgba(245,158,11,.09);border:1px solid rgba(245,158,11,.3)}
/* 空状态（这一区一个账号都没有）：不是警告，是引导 —— 用中性色，别让「还没添加」
   读起来像「出问题了」。 */
.dsm-qoder-pool-empty{margin:0;padding:9px 11px;border-radius:9px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-fill-tertiary,rgba(127,127,127,.08));border:1px dashed var(--dsw-alias-border-secondary,rgba(127,127,127,.3))}
.dsm-qoder-pool-error{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-state-error-primary,#ef4444);white-space:pre-line}
.dsm-qoder-pool-table{
  /* CONTAINMENT ROOT */
  container-type:inline-size;
  /* 列轨道写在变量里，由表格自己按「有没有签到列」声明一次；行与表头都读它。
     此前是两条规则各写一遍 grid-template-columns，于是「有签到列」那条
     （.dsm-qoder-pool-table-checkin .dsm-qoder-pool-row，两个类）在层叠上
     压过了媒体查询里的宽屏那条（一个类）——**宽屏形态从来没有渲染过**，
     窗口多宽都是两行紧凑排法。变量只在一处声明，行与表头不可能再分叉。 */
  /* 尾部两列用**固定 px**，不用 fr / auto：表头第 5 格没有标签可写，是个空
     span——若它是 auto 轨道，表头里这条轨道塌成 0px，四条 fr 轨道于是各多分到
     一点，标签就整体右移约 30px（实测表头「账号」w=275 而数据格 w=246，越往右
     错得越多）。固定宽度让表头与数据行落下**同一条**轨道上，与格子里有没有内容
     无关。 */
  /* 签到列给 118px：这一格的文案是「23:59:59 后可再签到」这种**最长**形态，
     实测 116px。给 96px 时它会溢出自己的轨道、直接压到右边那颗「测试」按钮上
     ——数字每秒在变，溢出量也跟着变，看着像按钮在抖。 */
  --dsm-qoder-pool-cols:minmax(0,1.45fr) minmax(0,.95fr) minmax(0,1.35fr) 118px 96px;
  /* 表格不再自己描边：它现在是成员卡片里的一段，卡片已经有那圈边框了。
     自己再描一圈会得到「框中框」——两圈相距 1px，看着像渲染出错。 */
  border:0;border-radius:0;overflow:hidden;
  border-top:1px solid var(--dsw-alias-border-l1,#2c2d31);
  background:var(--dsw-alias-bg-layer-2,#24262c);
}
/* 国际版暂不通签到，把空出的那条轨道让给操作列（4 条轨道）。 */
.dsm-qoder-pool-table:not(.dsm-qoder-pool-table-checkin){--dsm-qoder-pool-cols:minmax(0,1.6fr) minmax(0,.9fr) minmax(0,1.4fr) 96px}
/* 行布局：**窄是默认，宽由容器查询升级**。
 *
 * 断点测的必须是**这张表**的宽度，不是视口。这张卡同时画在三处，宽度与窗口毫无
 * 关系：输入框卡片、整页版（上限 860px）、以及设置面板的内容列（1400px 屏上是
 * 578px）。此前用的是 @media (min-width:761px)——在 1440px 的窗口里它永远成立，
 * 于是 578px 的表格拿到了宽屏那套，账号列被撑到 402px、行高 108px，而右侧 134px
 * 的积分列里只有两位数。实测（1440 视口 / 578px 表格）：
 *   账号 x=1159 w=402 │ 积分 x=1573 w=134 │ 状态 x=1159 w=402 │ 签到 x=1573 w=36
 *
 * 窄形态用 flex + wrap，并且按**三行**排（与 dsh-connect-trae 的窄形态同构）：
 *
 *   第一行：账号（最需要辨认的一端，占满）
 *   第二行：积分 · 状态 · 签到（三个事实，放得下就一直线，放不下在它们之间折）
 *   第三行：操作按钮（最需要动手的一端，自己一行）
 *
 * 前两版都试错了，记在这里免得再走一遍：
 *   - 全部 flex-wrap 挤成一行时会变成「1240  100 积分 3 天内过期  可用(1.5s)
 *     测得 · 1 分钟前  已签到  [测试] [删除]」——积分、状态、按钮三种东西读起来
 *     是同一类事实，而其中两个是可点的；
 *   - 固定 grid 两行时账号名短也撑满整行，横向空出一大片。
 *
 * 操作按钮 flex-basis:100% 独占一行是这个形态的关键：删除是不可逆动作，它不该
 * 与「已签到」这种只读事实并排成一句话。
 */
.dsm-qoder-pool-row{
  display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;padding:10px 14px;
  border-top:1px solid var(--dsw-alias-border-l1,#2c2d31);font-size:13px;color:var(--dsw-alias-label-secondary,#c6c9d0);
}
.dsm-qoder-pool-account{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 100%}
.dsm-qoder-pool-credits{display:flex;flex-direction:row;flex-wrap:wrap;align-items:baseline;gap:2px 8px;min-width:0;flex:0 1 auto;font-variant-numeric:tabular-nums}
/* 状态这一格允许自己折行：主行（结果 · 原因）与出处行本来就是一句话。 */
.dsm-qoder-pool-probe{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#999);min-width:0;flex:1 1 auto;overflow-wrap:anywhere}
/* 签到贴到第二行的右端：它是那一行里最后一个只读事实。 */
.dsm-qoder-pool-checkin{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap;flex:none;margin-left:auto}
.dsm-qoder-pool-row-actions{display:flex;gap:6px;align-items:center;flex:1 1 100%;justify-content:flex-start;padding-top:2px}
/* 窄形态不画表头：它的标签描述的是宽屏那套轨道，折行之后每一个标签都对不上
   自己的值——实测「签到」标签停在 x=1476，它的值在 1573，差 97px。一堆对不上的
   表头比没有表头更糟（dsh-connect-trae 在 700px 以下是同一条判断）。 */
.dsm-qoder-pool-row-head{display:none;padding:8px 14px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase}
.dsm-qoder-pool-row:first-child{border-top:0}
/* 宽屏：这张表自己够宽时才排成一行 5 列，一眼横向可比。
 * 阈值 700px 与 dsh-connect-trae 取同一个数，理由相同：表格没有「稍微窄一点」的
 * 形态值得保留——要么放得下这些列，要么放不下。 */
@container (min-width:700px){
  .dsm-qoder-pool-row{display:grid;grid-template-columns:var(--dsm-qoder-pool-cols);align-items:center;gap:12px}
  /* 宽屏那张表是**单行**，所以每一格回到自己的轨道：窄形态那几条 flex 覆盖
     （100% 占满、margin-left:auto 推右）必须在这里让位，否则操作按钮会带着
     flex-basis:100% 挤到第二行，五行变六行。 */
  .dsm-qoder-pool-account,.dsm-qoder-pool-credits,.dsm-qoder-pool-probe,
  .dsm-qoder-pool-checkin,.dsm-qoder-pool-row-actions{flex:none;margin-left:0;padding-top:0}
  .dsm-qoder-pool-credits{flex-direction:column;align-items:flex-start;gap:1px}
  .dsm-qoder-pool-probe{flex-direction:column;align-items:flex-start;gap:4px}
  .dsm-qoder-pool-checkin{margin-left:0}
  .dsm-qoder-pool-row-actions{justify-self:end}
  /* 表头回到宽屏那套轨道上——它现在与行读的是**同一个变量**，不会再错位。 */
  .dsm-qoder-pool-row-head{display:grid;grid-template-columns:var(--dsm-qoder-pool-cols);align-items:center;gap:12px}
  .dsm-qoder-pool-row-head > span:last-child{display:block}
}
.dsm-qoder-pool-row-current{background:rgba(86,134,254,.07)}
/* 左侧 3px 竖条：正在计费的那一行必须一眼可见。只靠 7% 的背景色，在暗色主题
   下几乎看不出区别（workbuddy 同规，两条规则共用同一个类名）。 */
.dsm-qoder-pool-row-current{box-shadow:inset 3px 0 0 var(--dsw-alias-brand-primary,#5686fe)}
.dsm-qoder-pool-account-name{display:flex;flex-direction:column;gap:2px;min-width:0}
/* 第一行：名字 + 名次 + 「当前使用」+ 上下移，全部**同一行**。
   这一列原来是 5 行竖排（名次 / 箭头 / 徽章 / 测试于 / 上一行结果），把整行
   撑到 90px 以上，而同一行的另外四列各自都只有一行 —— 高度全浪费在这里。
   现在压缩成 2 行：身份 + 一句话原因。 */
.dsm-qoder-pool-account-line{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.dsm-qoder-pool-account-name b{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary,#e6e6e6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dsm-qoder-pool-account-name span{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-qoder-pool-account-name .dsm-qoder-pool-current-tag{margin:0;padding:1px 6px;border-radius:999px;background:rgba(86,134,254,.16);color:var(--dsw-alias-brand-primary,#5686fe);font-size:11px;font-weight:600;line-height:16px;white-space:nowrap;flex:none}
/* 上下移贴着名字那一行的右端：它是这一行唯一一组成对控件，贴着名字会让人
   以为它只作用于名字（它改的是名次，而名次就画在名字旁边）。 */
.dsm-qoder-pool-account-line .dsm-qoder-pool-move{margin-left:auto}
/* 宽屏这一格只有约 240px，装不下「名字 + 自动排序 + 当前使用 + ↑↓」一整行，
   于是它会折成两行——这时 ↑↓ 若仍是 margin-left:auto，会被推到**所在那一行的
   最右端**，与它旁边那几个标签隔开一大截，读起来像个掉队的控件。改成紧贴标签：
   折行时它跟着标签走，不折行时它就在标签右边，两种情形读起来都是同一句话。
   （这条必须放在基础规则**之后**：容器查询不增加特异性，靠层叠顺序才赢。） */
@container (min-width:700px){
  .dsm-qoder-pool-account-line .dsm-qoder-pool-move{margin-left:0}
}
.dsm-qoder-pool-excluded{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-qoder-pool-credits b{color:var(--dsw-alias-label-primary,#e6e6e6);font-weight:600}
.dsm-qoder-pool-soon{font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-qoder-pool-soon-plain{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999)}
/* 套餐到期（issue #31 建议 1）：与「积分何时作废」是两件事，所以不用警告色 ——
   套餐到期是账号事实，不是「有分要浪费了」那种需要立刻行动的信号。 */
.dsm-qoder-pool-plan{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999);opacity:.85}
.dsm-qoder-pool-probe-main{color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-qoder-pool-probe-prov{display:flex;align-items:center;gap:5px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#999);min-width:0;flex-wrap:wrap}
.dsm-qoder-pool-prov-tag{padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-tertiary,#999);font-size:10px;font-weight:600;line-height:15px;white-space:nowrap}
.dsm-qoder-pool-prov-live{background:rgba(245,158,11,.16);color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-qoder-pool-prov-unknown{background:var(--dsw-alias-bg-layer-3,#2a2c33);border:1px solid var(--dsw-alias-border-l1,#2c2d31);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-qoder-pool-prov-sep{color:var(--dsw-alias-label-dimmed,#9aa0a6);opacity:.7}
.dsm-qoder-pool-prov-age{color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap}
/* 成员区是一张**卡片**：卡头（标题 + 已选/全选/全不选）、批量条、表格全在同一个
   边框里（学 dsh-connect-trae 的 .dsm-trae-pool-card）。
   此前是「标题浮在外面 + 表格自己描一圈边」：标题与表格之间隔着一条 gap，读起来
   像两个不相干的东西，而卡头上那枚「已选 2 / 2」与它要看管的复选框之间又隔着
   一条批量条。一张卡片、一条分隔线，谁管谁就一目了然。 */
.dsm-qoder-pool-members{display:flex;flex-direction:column;gap:0;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-qoder-pool-members-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 14px 12px}
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
/*
 * 账号工具（添加 PAT / 导出 / 导入）：三颗按钮共用一行。
 *
 * 两条工具条各自是 <section class="dsm-qoder-bar">，这里用 display:contents 把它们
 * 的壳塌陷掉——「添加 PAT」与「导出 / 导入」的按钮、状态行、对话框直接参与外层的
 * 排列，于是三颗按钮落在同一行，右端对齐，间距由 gap 统一。
 *
 * 对话框用 flex-basis:100% 强制换行、独占一行：让它保持在按钮**下方展开**的原有
 * 行为（不改成绝对定位的浮层——浮层要盖住下面的成员表，还得自己管阴影与遮挡）。
 *
 * 备注：display:contents 会让 <section> 的名字在某些浏览器里从无障碍树消失，
 * 所以两个 .dsm-qoder-bar-actions 各自带 role="group" + aria-label（组件里）。
 */
.dsm-qoder-pool-tools{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;border:1px dashed var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;padding:6px 10px}
.dsm-qoder-pool-tools > .dsm-qoder-bar{display:contents}
/*
 * 两处必须覆盖，都是「塌陷成一行」之后才出现的：
 *
 * 1. 两组按钮各自带 margin-left:auto，在外层会**平分**剩余空间——实测第一颗
 *    停在行的中间、第二组贴着右端，中间空出一大截。右对齐交给容器的
 *    justify-content 统一负责，这里归零。
 * 2. DOM 顺序里「添加 PAT」的对话框夹在两组按钮中间。对话框一换行，跟在它后面
 *    的「导出 / 导入」就被挤到下一行（实测两颗按钮整行消失）。用 order 把对话框
 *    排到所有按钮之后。
 */
.dsm-qoder-pool-tools .dsm-qoder-bar-actions{margin-left:0}
.dsm-qoder-pool-tools .dsm-qoder-transfer-dialog{order:2;flex:1 1 100%;margin:0}
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
/* 操作列只有 .8fr（约 88px 内容宽），两颗按钮必须**不换行**：中文可以在任意
   两字之间断行，于是「测试」「删除」会被压成竖排的两个字（桌面宽度下实测）。
   nowrap + 略收窄的左右 padding，比给这一列加宽更划算——加宽要从「账号」列
   拿空间，而账号名那一列本来就挤（名次、箭头、徽章都在里面）。 */
.dsm-qoder-pool-row-actions .dsm-qoder-pool-small-btn{padding:2px 7px;font-size:12px;white-space:nowrap;flex:none}
/* 「删除」分三档，按「用户离不可逆操作还有多远」决定红的浓度。
 *
 *   1. 静止态 —— 淡红。它和「测试」并排，两者都是 outline 小按钮，若删除也用
 *      满饱和红，整行右侧会一直有一块红色在喊；而这一行在绝大多数时候是被扫视
 *      而不是被操作的。用 color-mix 把危险色调到 62% 再混一点标签灰，得到一个
 *      「看得出是危险动作、但不抢注意力」的强度。
 *   2. 悬停 —— 回到满饱和红，边框也跟着点亮。指针已经停在它上面，此刻该明确。
 *   3. 确认条里的「确认删除」—— 实心红底白字（见下面的 .dsm-btn-danger）。
 *      只有走到这一步才是真的要删。
 *
 * 兜底值写成 #c76a6a 而不是 #ef4444：不支持 color-mix 的环境（老 WebView）
 * 拿到的是同一条柔和红，而不是突然变回满饱和。
 * （注释里不能用反引号 —— CSS 整段是模板字符串，反引号会把它拦腰截断。这条
 * 在 1.17.x 里已经踩过两次。） */
.dsm-qoder-pool-delete-btn{color:#c76a6a;color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 62%,var(--dsw-alias-label-tertiary,#9aa0a8))}
.dsm-qoder-pool-delete-btn:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#ef4444);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 55%,transparent)}
/* 二次确认就地展开在这一行的操作格里，不弹窗：确认的是什么（哪个账号）必须
   和被确认的那一行待在同一视线内，隔到弹窗里就说错了对象。 */
.dsm-qoder-pool-confirm{display:flex;gap:6px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
.dsm-qoder-pool-confirm-text{font-size:11px;line-height:15px;color:var(--dsw-alias-state-error-primary,#ef4444);text-align:right}
.dsm-qoder-pool .dsm-btn-danger{border-color:var(--dsw-alias-state-error-primary,#ef4444);color:#fff;background:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-qoder-pool .dsm-btn-danger:hover:not(:disabled){opacity:.9}
@media (max-width:760px){.dsm-qoder-pool-select{max-width:180px}}
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
/*
 * 侧边栏那一行的图标，以及它打开的整页。
 *
 * 图标只有一个约束：它是 PNG 品牌标，所以在 currentColor 主题的图标格里
 * 必须**按自己的颜色**画（不能套 filter / fill:currentColor），选中态由
 * 宿主围着它画。圆角与卡片头部那个 32px 图标同规，只是尺寸小一号。
 */
.dsm-qoder-panel-icon{display:block;border-radius:4px}
/*
 * 整页（sidebar.panellist 行打开的 main 页）。
 *
 * 形状照 workbuddy 的同名页：整页占满中央那一列、内容居中限宽 860px，因为
 * 卡片正文在设置页里只有 ~600px 宽，铺满一屏会把它拉成一条极长的行。
 * overflow:auto 在**这一层**：页面比一屏高时滚动的是页面，不是外框。
 */
.dsm-qoder-page{box-sizing:border-box;height:100%;display:flex;flex-direction:column;align-items:center;gap:20px;padding:28px clamp(24px,4vw,48px) 48px;overflow:auto;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-qoder-page>*{width:100%;max-width:860px}
.dsm-qoder-page-head{display:flex;flex-direction:column;gap:6px}
.dsm-qoder-page-back{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-1,#17181b);color:var(--dsw-alias-label-secondary,#c7c7c7);border-radius:8px;padding:5px 12px;display:inline-flex;align-items:center;gap:6px;align-self:flex-start;font-size:13px;line-height:20px}
.dsm-qoder-page-back:hover{color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-qoder-page-back svg{flex:none}
.dsm-qoder-page-icon{width:40px;height:40px;border-radius:9px;align-self:flex-start;margin-top:14px}
.dsm-qoder-page-title{margin:0;font-size:20px;font-weight:600;line-height:1.4}
.dsm-qoder-page-desc{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#999)}
/*
 * 整页里的正文自带外壳：.dsm-plugin-card-body 在设置页里靠外层 <li> 提供
 * 边框与内边距，这里没有那个 <li>，所以由这条规则补上同一套外观——整页与
 * 设置页看到的是同一个盒子，而不是一个没有边界的裸列表。
 */
/*
 * 设置页（settings.section）形态：标题 → 总述 → 三条用途 → 正文。
 *
 * 这里不套 .dsm-plugin-card 那套列表外壳（折叠 header、边框）：设置页本身就是
 * 独立界面；正文自带的那层 .dsm-plugin-card-body 靠下面这条补上盒子外观，
 * 与侧边栏整页看到的是同一个盒子。
 */
.dsm-qoder-section{display:flex;flex-direction:column;gap:14px;min-width:0}
.dsm-qoder-section-heading{margin:0;font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-qoder-section-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#b8b8b8)}
.dsm-qoder-section-values{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#b8b8b8)}
.dsm-qoder-section-values li::marker{color:var(--dsw-alias-label-tertiary,#999)}
.dsm-qoder-section-body .dsm-plugin-card-body{margin:0;padding:20px 20px 8px;border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px}
.dsm-qoder-page-body .dsm-plugin-card-body{margin:0;padding:20px 20px 8px;border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px}
/*
 * 可选侧边栏开关那一行。类名与积分开关**刻意不同**（.dsm-qoder-pref-check
 * 是积分那一块用例的定位器，多一个同类勾选框会把那条选择器变成二义），
 * 布局规则则与 .dsm-qoder-credit-toggle 同源：勾选框 + 一段两行说明。
 */
.dsm-qoder-sidebar-panel-pref{cursor:pointer}
/* 开关自己的失败提示：与那一行同宽缩进（借复选框那一列），红字。 */
.dsm-qoder-sidebar-panel-error{padding-left:25px;color:var(--dsw-alias-state-error-primary,#ef4444)}

/* 活动区（Campaigns.tsx）。**这一段曾经住在 QODER_COMPOSER_CSS 里** —— 那份样式
   表由 composer 积分读数组件注入，而设置页从不渲染那个组件，于是活动区的类名
   一条规则都没有：界面上是一列没有边框、没有分栏的裸文字（见 1.18.0 的截图）。
   样式必须跟着**渲染它的组件**走：QoderCampaigns 挂在卡片正文里，它就该在卡片
   样式表里。 */
.dsm-qoder-campaigns{display:flex;flex-direction:column;gap:10px;margin-top:6px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
/* 区块标题，不是表格头。 */
.dsm-qoder-campaigns-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}
.dsm-qoder-campaigns-empty{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-qoder-campaigns-error{margin:0;color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px;line-height:18px;white-space:pre-line}
/* 瓦片网格：auto-fill + 260px 下限，在约 580px 宽的正文栏里自然排成两列，
   窄容器（侧边栏面板更窄时）退回一列。minmax(0,...) 而不是 1fr：没有它，
   一条长英文标题会把整列撑破（grid 的 min-content 陷阱）。 */
.dsm-qoder-campaigns-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
/* 每条活动是一张等高小卡片：边框 + 底色把它和相邻那条分开，align-items 默认
   stretch 让同一排的两张高度一致。 */
.dsm-qoder-campaign-row{display:flex;flex-direction:column;gap:6px;min-width:0;padding:11px 13px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#202126)}
/* 标题行：标题吃掉剩余宽度，额度不换行。 */
.dsm-qoder-campaign-row-head{display:flex;align-items:baseline;gap:8px;min-width:0;flex-wrap:wrap}
.dsm-qoder-campaign-row-title{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:19px;font-weight:600}
.dsm-qoder-campaign-row-amount{padding:1px 7px;border-radius:6px;background:rgba(34,160,107,.18);color:var(--dsw-alias-state-success-primary,#22a06b);font-size:11px;font-weight:600;line-height:16px;white-space:nowrap;flex:none}
/* 描述限两行：这是摘要位，不是正文。三条活动各带一段长描述时，不限行会让
   卡片高度随上游文案长短跳动，整排格子高低不齐 —— 全文仍在 title 悬停里。 */
.dsm-qoder-campaign-row-desc{margin:0;color:var(--dsw-alias-label-secondary,#b8b8b8);font-size:12px;line-height:17px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
/* 页脚贴底：状态在左、出口在右，同一排卡片因此共用一条基线。 */
.dsm-qoder-campaign-row-foot{margin-top:auto;padding-top:2px;display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.dsm-qoder-campaign-row-status{padding:1px 6px;border-radius:6px;font-size:11px;font-weight:600;line-height:16px;white-space:nowrap;flex:none}
.dsm-qoder-campaign-row-status-claimable{background:rgba(34,160,107,.18);color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-qoder-campaign-row-status-claimed{background:var(--dsw-alias-bg-layer-2,#25262b);color:var(--dsw-alias-label-tertiary,#9aa0a8);border:1px solid var(--dsw-alias-border-l2,#36373b)}
.dsm-qoder-campaign-row-link{font-size:12px;line-height:18px;color:var(--dsw-alias-brand-primary,#5686fe);text-decoration:none;white-space:nowrap;flex:none;margin-left:auto}
.dsm-qoder-campaign-row-link:hover{text-decoration:underline}
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
/* nowrap 不是洁癖：页头是一个标题加一颗 11px 的控件挤在约 250px 的浮层里，
   设置按钮一进来，标题当场折成两行（workbuddy 在真机 Desktop 上量到过
   「WB AI」/「积分」断开）。标题是这一行里唯一必须保持单行的东西，它后面
   跟着的东西按构造都是短的。 */
.dsm-qoder-composer-panel-title{flex:none;white-space:nowrap;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,CanvasText)}
/* 页头右侧控件的外壳。**不是**给按钮本身加 auto margin：那颗按钮并非总在
   （宿主没有去处的路由时根本不渲染），而一个始终存在的外壳让页头在两种情形下
   排布完全一致 —— 否则按钮消失时标题会因为 auto margin 的消失而左移。 */
.dsm-qoder-composer-panel-actions{flex:none;margin-left:auto;display:flex;align-items:center}
/* 安静的**药丸**，不是带框的按钮，也不是下划线链接（对齐 workbuddy 实测结论）：
   下划线会让一个单词的标签读成「碰巧能点的正文」，13px 页头里根本不像控件；
   带框按钮又太吵，13px 标题旁边一颗带框按钮读成工具栏。品牌色 10% 底色让它
   静止时就有形状 —— 可点击性正该在这个时刻被看见，而不是悬停之后。
   边框只在 hover/focus 出现，那里才真的需要提示。 */
.dsm-qoder-composer-panel-settings{
  appearance:none;flex:none;
  display:inline-flex;align-items:center;gap:4px;
  padding:3px 8px 3px 6px;
  border:1px solid transparent;border-radius:999px;
  background:rgba(86,134,254,.10);
  color:var(--dsw-alias-brand-primary,#5686fe);
  font:inherit;font-size:11px;line-height:16px;font-weight:500;
  cursor:pointer;
  transition:background-color .12s ease,border-color .12s ease,color .12s ease;
}
.dsm-qoder-composer-panel-settings:hover{
  background:rgba(86,134,254,.18);
  border-color:rgba(86,134,254,.34);
  color:var(--dsw-alias-brand-primary,#5686fe);
}
.dsm-qoder-composer-panel-settings:active{background:rgba(86,134,254,.26)}
.dsm-qoder-composer-panel-settings:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
/* 齿轮不许被压扁：flex 子项默认会 shrink，标签换成更长的词（「Settings」对
   「设置」）时，窄浮层里的图标会被挤成椭圆。 */
.dsm-qoder-composer-panel-settings-icon{flex:none;display:block}
/* 标签永不换行：16px 高的药丸里折成两行会把页头撑高，下面的表格就脱开了。 */
.dsm-qoder-composer-panel-settings-label{flex:none;white-space:nowrap}
/* 减弱动效：这个颜色过渡是装饰，关掉之后 hover 态依然完整可见。 */
@media (prefers-reduced-motion:reduce){
  .dsm-qoder-composer-panel-settings{transition:none}
}
/* 「刷新」颗按钮：**透明底**的安静药丸，hover 才出色。
   它与「设置」是**不同的视觉权重**：设置是品牌色底的胶囊（它离开面板），刷新
   作用于下面的表（本地、可重复）。两个一样响的胶囊会让页头读成一条工具栏。
   逐字对齐 dsh-connect-workbuddy 的同名控件（acc8f2f / 92078a8），那边在真实
   宿主里的渲染就是本图参照的样子：刷新是灰字透明底，设置是淡紫底深色字。 */
.dsm-qoder-composer-panel-refresh{
  appearance:none;flex:none;
  display:inline-flex;align-items:center;gap:4px;
  padding:3px 8px 3px 6px;margin-right:6px;
  border:1px solid transparent;border-radius:999px;
  background:transparent;
  color:var(--dsw-alias-label-secondary,#444);
  font:inherit;font-size:11px;line-height:16px;font-weight:500;
  cursor:pointer;
  transition:background-color .12s ease,border-color .12s ease,color .12s ease;
}
.dsm-qoder-composer-panel-refresh:hover:not(:disabled){
  background:rgba(127,127,127,.10);
  border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.34));
  color:var(--dsw-alias-label-primary,CanvasText);
}
.dsm-qoder-composer-panel-refresh:active:not(:disabled){background:rgba(127,127,127,.16)}
.dsm-qoder-composer-panel-refresh:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
/* 批次在飞时按钮是禁用的，而一颗**仍然在 hover 时亮起来**的禁用控件会招来第二次
   按压——那次按压会被忽略，用户只会更困惑。 */
.dsm-qoder-composer-panel-refresh:disabled{cursor:default;opacity:.6}
/* 循环箭头同样不许被压扁（与齿轮同一条理由）。 */
.dsm-qoder-composer-panel-refresh-icon{flex:none;display:block}
/* 在飞时转起来：用户看着一个不动的按钮等了半分钟，会以为它没点上。
   一圈 900ms：快到读得出在动，慢到不像渲染故障。 */
.dsm-qoder-composer-panel-refresh-icon-spin{animation:dsm-qoder-panel-refresh-spin .9s linear infinite}
@keyframes dsm-qoder-panel-refresh-spin{to{transform:rotate(360deg)}}
/* 标签永不换行（与设置按钮同一条理由）。 */
.dsm-qoder-composer-panel-refresh-label{flex:none;white-space:nowrap}
/* 减弱动效下不转，但箭头**不许消失** —— 它是「批次还活着」的唯一提示。改为变暗，
   而真正的指示是文案（「正在刷新…」）。 */
@media (prefers-reduced-motion:reduce){
  .dsm-qoder-composer-panel-refresh{transition:none}
  .dsm-qoder-composer-panel-refresh-icon-spin{animation:none;opacity:.55}
}
/* 表格**不许**被内容撑开（issue #34）。默认的 table-layout:auto 让列宽跟着内容走，
   width:100% 只是下限：账号行第二行的状态文案是一条**可长可短**的翻译句子
   （国内版「用量已达上限 · 约 7 小时后解禁（按今日额度窗口推算）」，国际版比它
   更长），它一长，整张表就比 248px 的浮层还宽 —— 右侧「积分」列于是连数字一起
   被推到浮层外面。实测（Chrome，真实 DOM + 本文件 CSS）：中文那条把表撑到 336px、
   溢出 102px，英文那条撑到 543px、溢出 309px。
   fixed 之后列宽按声明分配，内容再长也只在自己那格里换行或省略。 */
.dsm-qoder-composer-panel-table{
  width:100%;border-collapse:collapse;table-layout:fixed;
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
/* 「积分」这一列**定宽**（issue #34）。table-layout:fixed 之后列宽只认声明：
   不写宽度的话它与账号列平分剩下的 222px，账号列被砍掉一半去换一个永远只有
   三四位数的数字，反而更难读。
   64px 的来历是实测：Chrome、12px、tabular-nums 下「999,999」50.9px、
   「9,999,999」62px（最宽的一档），共用的 11px 表头「积分」/「Credits」更短。
   overflow+ellipsis 是**兜底**：真出现十位数的余额时把它截断成省略号，而不是让它
   画到浮层外面去（issue 报的正是「跑到框外」）。 */
.dsm-qoder-composer-panel-table thead th.dsm-qoder-composer-panel-num,
.dsm-qoder-composer-panel-table tbody td.dsm-qoder-composer-panel-num{
  width:64px;overflow:hidden;text-overflow:ellipsis;
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
/* **换行，不截断**（issue #34）。
   外层 .dsm-qoder-composer-panel-switch 为账号名设了 white-space:nowrap，这条会
   被继承；而这一格的文字是**翻译句子**，长度不受布局控制（国内版那句「用量已达
   上限 · 约 7 小时后解禁（按今日额度窗口推算）」30 个字，国际版那句更长），
   nowrap 于是让它一路顶出浮层。这里的两种候选结局里，多一行是**读得完**的，
   截断是**读不到**的 —— 「按今日额度窗口推算」正是这句里最该被读到的一半，
   它说明这个时刻是**推算**的、不是上游承诺的。
   overflow-wrap:anywhere：中文没有词间空格可断，不给它这条就只会在标点处折。
   （与 dsh-connect-workbuddy 的 issue #108 同一个判断，那边也是先截断、后改成换行。） */
.dsm-qoder-composer-panel-mark{
  font-size:11px;line-height:15px;
  color:var(--dsw-alias-state-error-primary,#ef4444);
  white-space:normal;overflow-wrap:anywhere;
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
/* 活动（Campaigns.tsx）：卡在区域作用域内、额度读数之下的一条列表。
   与模型区同款分隔线 + 标题；每行 = 标题 · 额度 · 状态 · 查看详情。
   空列表只显示一行淡字「当前没有活动」——不凭空造 banner；读不到则红字原因。 */

`
