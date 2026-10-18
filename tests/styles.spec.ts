/**
 * 样式规则的结构断言（不需要 DOM，纯文本解析）。
 *
 * 这类回归在浏览器里才看得见，但根因是**规则本身写岔了**——比如同一个
 * 「保存行」在模型区和账号池区各写一套、其中一套多了 `flex-wrap`，运行时
 * 就表现为「这两个地方样式不统一」（用户实拍）。把它们钉在同一份断言里，
 * 以后再改就只有一处可改。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { QODER_CARD_CSS } from '../src/client/styles.ts'

const repoRoot = new URL('../', import.meta.url)

/** 取出一条类规则的声明体（第一条匹配；找不到返回 undefined）。 */
function ruleOf(css: string, className: string): string | undefined {
  // 类名里的点必须转义，否则 `.dsm-qoder-hint` 会被当成「任意字符 + qoder-hint」
  // 的模式去匹配，命中别的规则或干脆匹配不到。
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`\\.${escaped}\\{([^}]*)\\}`))
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

  it('每条渲染成 <p> 的规则都显式归零浏览器默认边距', () => {
    // 浏览器给 <p> 加 margin:1em 0（16px 上下）。凡是渲染成 <p> 的类，规则里
    // 必须写 margin，否则它上下凭空多出两段空白 —— 而且**调容器的 gap/padding
    // 完全看不出来**（用户实拍「还是没有改善」，根因就在这里）。
    // 这条测试是从「症状」反推出来的：前两次修间距都只改了容器，而真正的
    // 16px 来自浏览器默认样式。
    const pClasses = [
      'usage-hint', 'hint', 'usage-text', 'usage-error', 'tab-off-notice',
      'models-title', 'models-summary', 'model-capability-note', 'pool-note', 'pool-title',
    ]
    for (const name of pClasses) {
      const rule = ruleOf(QODER_CARD_CSS, `dsm-qoder-${name}`)
      expect(rule, `.dsm-qoder-${name} 规则应当存在`).toBeDefined()
      expect(rule, `.dsm-qoder-${name} 必须显式写 margin（<p> 默认 1em 0）`).toMatch(/margin:/)
    }
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
    expect(hint).toMatch(/margin:0/)
    expect(hint).toMatch(/padding:6px 0 6px 19px/)
    // 账号池标题行要**夹在两条线中间垂直居中**：上方是本块的 border-top，
    // 下方是 .dsm-qoder-pool-actions 的 border-top，中间隔着容器的 gap:12px。
    // 所以上内边距必须等于那个 gap（12px），否则文字离上线近、离下线远。
    // 原来是 8px —— 用户实拍：「让文字在两条线中间垂直居中」。
    expect(pool).toMatch(/padding:12px 0 4px/)
    expect(pool).toMatch(/gap:12px/)
  })

  it('积分偏好两行照 dsh-connect-trae 的 .dsm-trae-pref：整行可点、标题与说明分两行、控件贴左', () => {
    // 用户给参照图圈出 trae 那两行，要求「改成一样的样式」。结构（不是配色）
    // 才是被参照的东西，所以这里钉的是结构与间距：
    //   1. 一行一个开关，label 包住勾选框 → 整行都是点击区；
    //   2. 主标题 + 副说明**分两行**（此前三条说明只挂在 title 属性上，要悬停才看得见）；
    //   3. 下级控件（显示位置的下拉）排在标题右侧同一行，不甩到卡片另一头。
    const prefs = ruleOf(QODER_CARD_CSS, 'dsm-qoder-prefs')
    expect(prefs).toContain('display:flex')
    expect(prefs).toContain('flex-direction:column')
    expect(prefs).toContain('gap:14px')
    // 底部 8px：这组的最后一行说明下面紧跟账号池那条分隔线，说明自己只有
    // padding-bottom:6px，实测文字到线只剩 4 CSS px（用户实拍：「这里文字和线
    // 距离不对」）。补到 8px 后实测 12 CSS px，与线下到标题那截相称。
    expect(prefs).toContain('padding:2px 2px 8px')
    const pref = ruleOf(QODER_CARD_CSS, 'dsm-qoder-pref')
    expect(pref).toContain('align-items:flex-start')
    expect(pref).toContain('gap:10px')
    expect(pref).toContain('cursor:pointer')
    // 标题与说明是两行，不是挤在一行里的一句长话。
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-pref-copy')).toContain('flex-direction:column')
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-pref-label')).toContain('font-weight:500')
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-pref-hint')).toContain('line-height:17px')
    // 「显示位置 [下拉]」从左侧排起，谁也不拉伸。
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-pref-lead')).toContain('justify-content:flex-start')
    // 没有勾选框的那一行借用勾选框那一列做内边距，让两条标题左边缘对齐。
    // 缩进走变量：第一行声明 --dsm-qoder-pref-indent，第二行消费它——写死数值时
    // 两行各算各的，位置一旦对不上就整体偏左（用户实拍过这一幕）。
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-credit-toggle')).toContain('--dsm-qoder-pref-indent:25px')
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-credit-position-pref')).toContain('padding-left:var(--dsm-qoder-pref-indent')
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-credit-position')).toContain('flex:none')
    // 只为「和标题挤一行」而存在的两个类都不该再留规则。
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-credits-switch')).toBeUndefined()
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-pool-head-extra')).toBeUndefined()
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-credits-row')).toBeUndefined()
    // 芯片仍靠 margin-left:auto 靠右。
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-pool-current-badge')).toContain('margin-left:auto')
  })

  it('账号池表格自己的数字框仍然保留', () => {
    // 它是家族共用的规则（workbuddy 也有同名规则），不要因为「卡片里没人用」
    // 就删掉——那会制造一处与同族插件不一致的差异。
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-pool-num')).toBeDefined()
  })
})

describe('QODER_CARD_CSS template literal', () => {
  /**
   * The stylesheet is a template literal, so a stray backtick inside it
   * TERMINATES the string early — and TypeScript does not complain, because
   * what follows still parses as valid syntax. The result is a silently
   * truncated CSS bundle: every rule after the backtick is gone, so those
   * elements fall back to browser defaults with no error anywhere.
   *
   * That is not hypothetical. It happened in the sibling plugin
   * (dsh-connect-workbuddy) while reworking the busy veil's colours: the new
   * comments quoted CSS tokens in backticks, the literal split at the first
   * one, and the veil block vanished. typecheck and the build both passed;
   * only the "every class is styled" guard noticed.
   *
   * So the check is on the SOURCE, not the extracted string: parse the file and
   * count its top-level statements. A regex or `toContain` against the
   * extracted string cannot catch this — truncation makes the extracted string
   * simply SHORTER, and every selector the guard knows about is still in the
   * part that survives.
   */
  it('leaves no stray statements behind, which is what truncation produces', () => {
    // A stray backtick inside the literal ends the string early, and the rest
    // of the stylesheet is then parsed as UNRELATED SYNTAX rather than as CSS.
    // Neither typecheck nor the build complains: the file is still valid TS,
    // it just exports a stub stylesheet and a pile of junk expression
    // statements.
    //
    // So count the file's top-level statements. A healthy styles.ts declares
    // its CSS exports and nothing else; truncation turns the remainder into
    // dozens of expression statements, one per token.
    const source = readFileSync(fileURLToPath(new URL('src/client/styles.ts', repoRoot)), 'utf8')
    const sf = ts.createSourceFile('styles.ts', source, ts.ScriptTarget.ESNext, true)
    const strays = sf.statements.filter(st => !ts.isVariableStatement(st))
    expect(strays.map(st => ts.SyntaxKind[st.kind])).toEqual([])
    expect(sf.statements.length).toBe(2)
  })

  it('still carries the veil rules the shared busy overlay depends on', () => {
    // Belt and braces for the same defect: if the literal is ever truncated
    // again, these selectors disappear from the extracted CSS.
    expect(QODER_CARD_CSS).toContain('.dsm-qoder-veil{')
    expect(QODER_CARD_CSS).toContain('.dsm-qoder-veil-card{')
    expect(QODER_CARD_CSS).toContain('.dsm-qoder-veil-spinner{')
  })

  it('遮罩用的是宿主令牌，不是本文件的自造值（对齐 workbuddy 4.4.2）', () => {
    // 逐条钉在**规则自己的声明体**上，而不是 `toContain` 全文：这些令牌
    // （尤其 `--dsw-alias-bg-layer-2`）在文件别处大量出现，全文包含断言即使
    // 把遮罩退回自造值也照样通过 —— 那是空转。变异验证：把卡片底色改回
    // `--dsw-alias-bg-primary` 时，只有下面这种按规则取的断言会转红。
    const veil = ruleOf(QODER_CARD_CSS, 'dsm-qoder-veil')
    expect(veil).toContain('background:var(--dsw-alias-bg-mask-1')
    expect(veil).toContain('backdrop-filter:var(--dsw-mask-blur)')
    // 自造的黑幕与「没有主题意识的」写死值不许回来。
    expect(veil).not.toContain('rgba(0,0,0,.38)')

    const card = ruleOf(QODER_CARD_CSS, 'dsm-qoder-veil-card')
    expect(card).toContain('background:var(--dsw-alias-bg-layer-2')
    expect(card).toContain('box-shadow:var(--dsw-elevation-prominent')
    // `--dsw-alias-bg-primary` 在宿主令牌集里**根本不存在**，用它等于一路回退
    // 到近黑板子 —— 这正是用户看到「黑底看不清字」的根因。
    expect(card).not.toContain('--dsw-alias-bg-primary')

    const hint = ruleOf(QODER_CARD_CSS, 'dsm-qoder-veil-hint')
    expect(hint).toContain('color:var(--dsw-alias-label-secondary')
    expect(hint).not.toContain('label-tertiary')
  })

  it('spinner 是宿主同款弧线 + 1.5s 节奏，降级为静态弧线', () => {
    // 旧实现是 18px CSS border 环、`.7s` 匀速转 —— 比宿主自己的状态转圈快近
    // 一倍，放在一起明显不同拍。这条把「形状 + 节奏 + 降级」一起钉住。
    const spinner = ruleOf(QODER_CARD_CSS, 'dsm-qoder-veil-spinner')
    expect(spinner).toContain('animation:dsm-qoder-veil-spin 1.5s linear infinite')
    expect(spinner).not.toContain('border:2px solid')
    // 几何与 dash 呼吸在子元素上（track / arc）。
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-veil-spinner-track')).toContain('opacity:.25')
    expect(ruleOf(QODER_CARD_CSS, 'dsm-qoder-veil-spinner-arc')).toContain('stroke-dasharray:12 150')
    // keyframes 必须两条都在：只有 spin 没有 dash 就成了匀速硬转。
    expect(QODER_CARD_CSS).toContain('@keyframes dsm-qoder-veil-dash{')
    expect(QODER_CARD_CSS).toContain('@keyframes dsm-qoder-veil-spin{')
    // 静态弧线降级（reduced-motion），不能退成「animation:none 但留个环」。
    expect(QODER_CARD_CSS).toContain('stroke-dasharray:18 150;stroke-dashoffset:-3')
  })
})
