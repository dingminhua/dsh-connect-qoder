/**
 * 文案层的语义测试 —— 用**真实的** locale 表，而不是 pool-render 里那个保留 key 的
 * 假翻译器。
 *
 * 为什么要有这个文件（用户实拍：「已签到 · 00:39:22 后刷新」，并指出 39 分钟后是
 * **可以签到**，所以不该显示「已签到」）：`tests/pool-render.spec.tsx` 的 `t` 返回
 * 的是 key 本身，它能钉住「用了哪个 key」，**永远钉不住「这句话读起来通不通」** ——
 * 那句自相矛盾的话就是这么发出去的。这里断言的是用户真正看到的字符串。
 *
 * key 的双语对齐不用测：`zh` 的类型是 `Record<QoderSettingsKey, string>`，缺键与
 * 多键都由 `tsc` 挡住。
 *
 * @module dsh-connect-qoder/tests/locales
 */

import { describe, expect, it } from 'vitest'

import { qoderLocales, render } from '../src/client/locales.ts'

type Lang = 'zh' | 'en'

const cell = (lang: Lang, key: 'row.poolCheckinNext' | 'row.poolCheckinDue' | 'row.poolCheckedIn'): string =>
  qoderLocales[lang][key]

/** 倒计时那一格渲染出来的实际文字（用户实拍里的那个 `00:39:22`）。 */
const ticking = (lang: Lang): string => render(cell(lang, 'row.poolCheckinNext'), { countdown: '00:39:22' })

/**
 * 倒计时格的三条要求。按语言各调一次，报告里能直接看出是哪一侧的文案坏了 ——
 * 不用 `it.each`（它的带格式串重载在这个 vitest 版本下推不出参数类型）。
 */
function checkTickingCopy(lang: Lang): void {
  const text = ticking(lang)
  // 数字本身要在。
  expect(text).toContain('00:39:22')
  // 「已签到」不能出现在这一格里：它说的是**上一窗**，而数字说的是**下一窗**什么
  // 时候开 —— 并排就是用户读出来的那个矛盾。
  expect(text).not.toContain(cell(lang, 'row.poolCheckedIn'))
  // 文案必须点明「再 / again」：它蕴含「这一窗已经签过了」，所以去掉「已签到」
  // 不丢事实。而旧文案的「后刷新 / next in」把数字说成了「这行多久刷新」，
  // 那是另一件事。
  expect(text).toMatch(lang === 'zh' ? /再签/ : /\bagain\b/i)
  expect(text).not.toMatch(lang === 'zh' ? /刷新/ : /refresh/i)
}

describe('签到单元格的文案（用户实拍「已签到 · 00:39:22 后刷新」）', () => {
  it('zh：倒计时那一格说「可再签到」，不并排「已签到」、也不说「刷新」', () => {
    checkTickingCopy('zh')
  })

  it('en：倒计时那一格说「claimable again」，不并排「Checked in」', () => {
    checkTickingCopy('en')
  })

  it.each([
    ['zh', '已签到', '现在可以签到'],
    ['en', 'Checked in', 'Claimable now'],
  ] as const satisfies readonly [Lang, string, string][])('%s：到点那一格不与「已签到」并排', (lang, checkedIn, due) => {
    // 「已签到 · 现在可以签到」比截图那句更矛盾（七个字里自我否定），所以 due
    // 单独成格、不带「已签到」。
    expect(cell(lang, 'row.poolCheckinDue')).toBe(due)
    expect(cell(lang, 'row.poolCheckinDue')).not.toContain(checkedIn)
  })

  it('提示语（title）里不放 Markdown 星号', () => {
    // `title` 属性按纯文本渲染，`**重点**` 会连星号一起显示出来。
    for (const lang of ['zh', 'en'] as const) {
      for (const key of ['row.poolCheckinNextHint', 'row.poolCheckinDueHint'] as const) {
        expect(qoderLocales[lang][key]).not.toContain('**')
      }
    }
  })
})

// ==========================================================================
// out-of-credit 那一档的措辞（本轮第二个错）
//
// 修好误判之后，110 会正确落到 out-of-credit —— 但既有的文案是「积分不足 /
// Not enough credits」，而这个账号**实测还有 500 积分**、`isQuotaExceeded:
// false`：官方 110 是「达到当日用量**次数**限制」，与积分余额无关。照发就是
// 第二句自相矛盾的话（0.4.1 刚为第一句发过补丁）。
// ==========================================================================
describe('out-of-credit 档不说「积分不足」', () => {
  it.each(['zh', 'en'] as const)('%s：行标签与排除芯片用同一口径', lang => {
    const label = qoderLocales[lang]['row.probeOutOfCreditUnknown']
    const chip = qoderLocales[lang]['row.poolExcludedOutOfCredit']
    // 「积分 / credit」这个名词不能出现在这一档：它断言了一件上游没说的事。
    expect(label).not.toMatch(/积分|credit/i)
    expect(chip).not.toMatch(/积分|credit/i)
    // 两处必须是同一说法，否则同一张卡片上两个词指同一件事。
    expect(label).toContain(chip)
  })

  it('带恢复时刻的版本也不带「积分包」这个限定', () => {
    // {at} 可能来自上游的重置句子，而非积分包到期 —— 限定错了就是编造来源。
    for (const lang of ['zh', 'en'] as const) {
      const at = render(qoderLocales[lang]['row.probeOutOfCreditAt'], { at: '10-14 00:00' })
      expect(at).toContain('10-14 00:00')
      expect(at).not.toMatch(/积分|credit/i)
    }
  })

  it('凭据被拒那一档保持原样 —— 只有 105 才是 PAT 的事', () => {
    // 这条不是要弱化它，而是钉住「改分类不该顺手改掉真凭据被拒的措辞」。
    for (const lang of ['zh', 'en'] as const) {
      expect(qoderLocales[lang]['row.probeCredentialRejected']).toMatch(/PAT/)
    }
  })
})

describe('两个模型徽标的悬停文案', () => {
  it('「免费」的悬停说清判据是倍率 0、且不消耗积分（不是「限时」）', () => {
    for (const lang of ['zh', 'en'] as const) {
      const hint = qoderLocales[lang]['row.modelFreeHint']
      // 判据要写出来：卡片上「免费」与「错峰 4 折」并排，后者才是限时的那个，
      // 不写清判据就会被读成「这模型在搞活动」。
      expect(hint).toMatch(lang === 'zh' ? /倍率/ : /multiplier/i)
      expect(hint).toMatch(lang === 'zh' ? /不消耗|不扣/ : /no credits|consume/i)
      expect(hint).not.toMatch(lang === 'zh' ? /限时|活动/ : /limited|promo/i)
    }
  })

  it('灰显徽标的悬停带 {start} 占位，插进去是上游声明的起点', () => {
    for (const lang of ['zh', 'en'] as const) {
      const pending = render(qoderLocales[lang]['row.promoPending'], { start: '22:00' })
      // 起点必须真的被插进去：只剩模板文本等于没说几点生效。
      expect(pending).toContain('22:00')
      expect(pending).not.toContain('{start}')
      // 措辞必须点明「还没生效」——灰胶囊挂的是上游那句「错峰 4 折」，
      // 悬停若不说清状态，读者会以为现在就在打折。
      expect(pending).toMatch(lang === 'zh' ? /未生效|还没/ : /not active|not yet|starts/i)
    }
  })
})
