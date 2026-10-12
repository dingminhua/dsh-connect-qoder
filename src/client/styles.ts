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
.dsm-qoder-usage{display:flex;flex-direction:column;gap:16px;margin:0;padding:16px 0 4px}
.dsm-qoder-tabs{display:flex;gap:6px;padding:4px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#2a2c33)}
.dsm-qoder-tab{appearance:none;font:inherit;cursor:pointer;flex:1;border:0;border-radius:7px;padding:7px 10px;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;font-weight:500;line-height:18px;background:transparent;transition:color .15s,background .15s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsm-qoder-tab:hover:not(:disabled):not(.dsm-qoder-tab-active){color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-qoder-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-qoder-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-2,#232529);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,#3a3d45)}
.dsm-qoder-tab-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:baseline}
.dsm-qoder-tab-cell{display:flex;align-items:center;gap:2px;flex:1;min-width:0}
.dsm-qoder-tab-switch{display:inline-flex;align-items:center;flex:none;padding:0 8px 0 2px;cursor:pointer}
.dsm-qoder-tab-switch input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-qoder-tab-switch input:disabled{opacity:.4;cursor:default}
/* One sidebar-credit switch, belonging to the ACTIVE tab's region. */
/*
 * 「在对话框显示积分」开关：现在渲染在账号池标题行右端（.dsm-qoder-pool-head-right），
 * 不再在卡片正文里独占一行——用户要求「放到账号池这个标题旁边吧，节约点空间」。
 * 它曾套着为「积分明细列表」准备的 .dsm-qoder-usage（16px 上内边距 + 16px gap），
 * 明细移走后那层留白变成纯空档；现在这一行整体消失，开关只占标题行的高度。
 * 字号继承卡片正文的小号（12px），不抢标题的视觉重量。
 */
.dsm-qoder-credits-switch{display:flex;align-items:center;gap:6px;margin:0;cursor:pointer;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-qoder-credits-switch input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-qoder-credits-switch input:disabled{opacity:.4;cursor:default}
.dsm-qoder-tab-off{opacity:.55}
.dsm-qoder-usage-account-actions{display:flex;gap:8px;margin:10px 0 0}
.dsm-qoder-account-confirm{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#2a2c33)}
.dsm-qoder-account-confirm-text{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-qoder-tab-off-notice{color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px;margin:0 0 4px;padding:8px 10px;background:var(--dsw-alias-bg-layer-3,#2a2c33);border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px}
.dsm-qoder-usage-hint{padding-left:19px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}
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
/* 区块分隔线之上只留 8px：上方的「在对话框显示积分」勾选框只有一行，
   16px 会让这截空档看着像丢了内容（用户实拍：「红色的部分向上靠拢一些」）。 */
.dsm-qoder-pool{display:flex;flex-direction:column;gap:12px;margin:0;padding:8px 0 4px;border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
.dsm-qoder-pool-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
/* 标题行右端：可操作的积分开关 + 「当前使用」状态芯片。 */
.dsm-qoder-pool-head-right{display:flex;align-items:center;gap:14px;flex-wrap:wrap;min-width:0}
.dsm-qoder-pool-current-badge{padding:2px 10px;border-radius:999px;background:rgba(86,134,254,.16);color:var(--dsw-alias-brand-primary,#5686fe);font-size:12px;font-weight:600;line-height:18px;white-space:nowrap}
.dsm-qoder-pool-account-select{min-width:200px}
.dsm-qoder-pool-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-qoder-pool-badge{flex:none;padding:2px 9px;border-radius:999px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-brand-primary,#5686fe);background:rgba(86,134,254,.12);border:1px solid rgba(86,134,254,.32)}
.dsm-qoder-pool-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:12px}
.dsm-qoder-pool-actions-group{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-qoder-pool-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-qoder-pool-note{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-qoder-pool-warn{margin:0;padding:9px 11px;border-radius:9px;font-size:12px;line-height:17px;color:var(--dsw-alias-state-warn-primary,#f59e0b);background:rgba(245,158,11,.09);border:1px solid rgba(245,158,11,.3)}
.dsm-qoder-pool-error{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-state-error-primary,#ef4444);white-space:pre-line}
.dsm-qoder-pool-table{border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-qoder-pool-row{display:grid;grid-template-columns:1.6fr 1fr 1.3fr .9fr .8fr;gap:10px;align-items:center;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1,#2c2d31);font-size:13px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
/* No check-in column (Qoder never supports check-in): the freed track goes to the actions. */
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
.dsm-qoder-pool-unknown{color:var(--dsw-alias-label-dimmed,#9aa0a6)}
.dsm-qoder-pool-member{color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-qoder-pool-not-member{color:var(--dsw-alias-label-dimmed,#9aa0a6)}
.dsm-qoder-pool-settings-wrap{display:flex;flex-direction:column;gap:10px}
.dsm-qoder-pool-dirty{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-qoder-pool-settings{display:flex;flex-direction:column;gap:1px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#24262c)}
/* Add-PAT + export/import, hosted inside the pool settings block. */
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
.dsm-qoder-pool-save-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:12px}
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
.dsm-qoder-pool-row-actions .dsm-qoder-pool-small-btn{padding:2px 10px;font-size:12px}
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
.dsm-qoder-bar-label{flex:none;margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-qoder-bar-status{flex:1 1 auto;min-width:0;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#e8e9ed);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-qoder-bar-hint{color:var(--dsw-alias-label-tertiary,#999)}
.dsm-qoder-bar-actions{display:flex;gap:8px;flex:none;margin-left:auto}
.dsm-qoder-bar a{color:var(--dsw-alias-brand-primary,#5686fe);text-decoration:none}
.dsm-qoder-bar a:hover{text-decoration:underline}
.dsm-qoder-bar-ok{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-qoder-bar-error{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-qoder-hint{color:var(--dsw-alias-label-tertiary,#999)}
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
.dsm-qoder-addpat-doc{margin:0 0 8px}
.dsm-qoder-addpat-doc a{color:var(--dsw-alias-brand-primary,#5686fe);font-size:12px;line-height:18px;text-decoration:none}
.dsm-qoder-addpat-doc a:hover{text-decoration:underline}
/* The shared busy veil: a fixed overlay for operations whose result only shows
   up after the list re-read. It is NOT a modal. */
.dsm-qoder-veil{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.38);cursor:progress}
.dsm-qoder-veil-card{display:flex;flex-direction:column;align-items:center;gap:8px;max-width:min(340px,80vw);padding:16px 20px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;background:var(--dsw-alias-bg-primary,#1b1c20);box-shadow:0 8px 28px rgba(0,0,0,.35)}
.dsm-qoder-veil-text{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#e8e9ed);text-align:center}
.dsm-qoder-veil-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999);text-align:center}
.dsm-qoder-veil-spinner{width:18px;height:18px;border:2px solid var(--dsw-alias-border-l2,#3a3d45);border-top-color:var(--dsw-alias-brand-primary,#5686fe);border-radius:50%;animation:dsm-qoder-veil-spin .7s linear infinite}
@keyframes dsm-qoder-veil-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.dsm-qoder-veil-spinner{animation:none}}
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
.dsm-qoder-composer-panel-mark{
  font-size:11px;line-height:15px;
  color:var(--dsw-alias-state-warn-primary,#f59e0b);
}
.dsm-qoder-composer-panel-switch:hover:not(:disabled){
  background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));
}
.dsm-qoder-composer-panel-switch:focus-visible{
  outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-1px;
}
.dsm-qoder-composer-panel-switch:disabled{cursor:default}
.dsm-qoder-composer-panel-dot{
  flex:none;width:7px;height:7px;border-radius:50%;
  background:var(--dsw-alias-label-dimmed,rgba(127,127,127,.5));
}
.dsm-qoder-composer-panel-table tr.dsm-qoder-composer-panel-row-current .dsm-qoder-composer-panel-dot{
  background:var(--dsw-state-success,#22a06b);
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
