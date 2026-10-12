/**
 * 样式规则的结构断言（不需要 DOM，纯文本解析）。
 *
 * 这类回归在浏览器里才看得见，但根因是**规则本身写岔了**——比如同一个
 * 「保存行」在模型区和账号池区各写一套、其中一套多了 `flex-wrap`，运行时
 * 就表现为「这两个地方样式不统一」（用户实拍）。把它们钉在同一份断言里，
 * 以后再改就只有一处可改。
 */
import { describe, expect, it } from 'vitest'
import { QODER_CARD_CSS } from '../src/client/styles.ts'

/** 取出一条类规则的声明体（第一条匹配；找不到返回 undefined）。 */
function ruleOf(css: string, className: string): string | undefined {
  const match = css.match(new RegExp(`\\.${className}\\{([^}]*)\\}`))
  return match?.[1]
}

describe('QODER_CARD_CSS', () => {
  it('两条「保存行」共用同一套规则', () => {
    // 模型保存行（模型区）与账号池保存行（池设置区）是同一种东西：左边一个
    // 仓库链接、右边一对按钮。此前池那条多了 `flex-wrap:wrap`、按钮组多了
    // `flex:none`，于是空间紧时只有它会换行——看起来就是两套样式。
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-pool-save-bar'))
      .toBe(ruleOf(QODER_CARD_CSS, 'dsm-qoder-model-actions'))
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-pool-save-buttons'))
      .toBe(ruleOf(QODER_CARD_CSS, 'dsm-qoder-model-actions-buttons'))
  })

  it('模型行选择器用行内样式，不用账号池表格的实心方块', () => {
    // pool-num 是 13px、74px 宽、8px 圆角的实心方块，只属于账号池表格；
    // 放进 11px 的模型行会突兀（用户实拍）。模型行统一用 inline-select。
    const inline = ruleOf(QODER_CARD_CSS, 'dsm-qoder-inline-select')
    expect(inline).toBeDefined()
    expect(inline).toContain('appearance:none')
    expect(inline).toContain('font-size:11px')
    expect(inline).toContain('border:0')
    expect(inline).toContain('background-color:transparent')
    // 系统绘制的选项不继承行内样式，必须自带背景，否则展开是一列透明文字。
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-inline-select option')).toContain('background')
  })

  it('说明行（tab 提示语）上下的空白都收紧（用户圈出的那两处）', () => {
    // 用户圈的是**那句说明文案上下的两处空白**：
    //   tab 栏 → 说明行，以及 说明行 → 账号池分隔线。
    // 「账号池自己的上下间距」不在此列（上一轮我误改成了它）。
    const usage = ruleOf(QODER_CARD_CSS, 'dsm-qoder-usage') ?? ''
    const hint = ruleOf(QODER_CARD_CSS, 'dsm-qoder-usage-hint') ?? ''
    const pool = ruleOf(QODER_CARD_CSS, 'dsm-qoder-pool') ?? ''

    // 分隔线 → tab 栏
    expect(usage).toMatch(/padding:12px 0 2px/)
    // tab 栏 → 说明行（容器 gap 负责）
    expect(usage).toMatch(/gap:10px/)
    // 说明行自己的上下内边距（它此前只有 padding-left）
    expect(hint).toMatch(/padding:2px 0 2px 19px/)
    // 账号池**自己的**间距保持 8px —— 它不属于用户圈的那两处。
    expect(pool).toMatch(/padding:8px 0 4px/)
  })

  it('积分开关与标题同行（workbuddy 的 pool-head-extra 同规）', () => {
    // 它原本在卡片正文里独占一行、套着为「积分明细列表」准备的 .dsm-qoder-usage
    // （padding:16px 0 4px + gap:16px）；明细移到账号池表格后，那层留白就成了
    // 纯空档。现在紧挨标题同行（用户要求「节约点空间」）。
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-credits-switch')).toContain('margin:0')
    // 那个为明细列表准备的外壳不该再套在开关上。
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-credits-row')).toBeUndefined()
    // workbuddy 是 `head{gap:10px}` + `head-extra{inline-flex}` +
    // `current-badge{margin-left:auto}`，qoder 逐字对齐。
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-pool-head')?.replace(/\s/g, ''))
      .toBe('display:flex;align-items:center;gap:10px;flex-wrap:wrap')
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-pool-head-extra')).toContain('inline-flex')
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-pool-current-badge')).toContain('margin-left:auto')
  })

  it('账号池表格自己的数字框仍然保留', () => {
    // 它是家族共用的规则（workbuddy 也有同名规则），不要因为「卡片里没人用」
    // 就删掉——那会制造一处与同族插件不一致的差异。
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-pool-num')).toBeDefined()
  })
})
