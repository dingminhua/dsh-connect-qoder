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

  it('积分勾选框一行不再撑出空白（用户实拍要求上移）', () => {
    // 该行原本套着 .dsm-qoder-usage（padding:16px 0 4px + gap:16px），那是给
    // 「积分明细列表」准备的；明细移到账号池表格后，这些内边距就是纯粹的空白。
    const row = ruleOf(QODER_CARD_CSS, 'dsm-qoder-credits-row')
    expect(row).toBeDefined()
    expect(row).not.toContain('16px 0 4px')
    expect(row).toContain('padding:12px 0 2px')
    // 勾选框自己不再另加 margin（间距由这一行统一负责）。
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-credits-switch')).toContain('margin:0')
    // 账号池的上内边距收紧，否则「分隔线之上」会留一截看着像丢内容的空档。
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-pool')).toContain('padding:8px 0 4px')
  })

  it('账号池表格自己的数字框仍然保留', () => {
    // 它是家族共用的规则（workbuddy 也有同名规则），不要因为「卡片里没人用」
    // 就删掉——那会制造一处与同族插件不一致的差异。
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-pool-num')).toBeDefined()
  })
})
