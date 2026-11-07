// @vitest-environment jsdom
/**
 * 别家 provider 行上的胶囊：**复现宿主 fallback 的顺序与退化**。
 *
 * 为什么这组测试值得写：这一支是「用户看得见、但错了也不会报错」的典型。
 *
 * 1. **顺序**是硬要求。`placement === 'trigger'`（输入框旁，当前选中）胶囊在**前**，
 *    `menu` / `option` 在**后**。抄反了不会报错，只是同一个模型在两处长成两个样。
 * 2. **不能抛**。本组件一旦抛错，宿主会把它从那一格摘掉（`entriesOfSlot` 跳过已
 *    退役的条目），整片模型标签换成别家或裸名字 —— 一枚没见过的 badge 形状不该
 *    有这个后果。所以这里对每一种「读不懂」都喂一遍。
 * 3. **翻译表缺 `en` 会得到空胶囊**。宿主的 `resolveText` 拿 `text.en` 兜底，
 *    缺了它就是 `undefined`，画出来是一颗没有字的胶囊。
 * 4. **纯名字是下限**。没有可达的胶囊时返回的就是 `model.name`，一个字符都不改。
 *
 * 参考：docs/MODEL-LABEL-SPEC.md §4（宿主 fallback 的逐字形状与两条硬要求）。
 */
import * as React from 'react'
import { act as actFromReact } from 'react'
import { act as actTestUtils } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ForeignModelLabel,
  drawableHostBadge,
  hostBadgePaint,
  resolveHostBadgeText,
} from '../src/client/host-badge.tsx'
import type { Translate } from '../src/client/locales.ts'

const act: typeof actFromReact = ((React as unknown as { act?: typeof actFromReact }).act
  ?? actTestUtils) as typeof actFromReact

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/**
 * 一个把界面语言钉成 zh 的翻译器（语言信号走 `hostLanguage` → `t('promo.locale')`）。
 *
 * 不钉的话 jsdom 的 `navigator.language` 是 en-US，断言就成了「测语言检测」。
 */
const zhT = ((key: string): string | undefined => (key === 'promo.locale' ? 'zh' : key)) as never
const enT = ((key: string): string | undefined => (key === 'promo.locale' ? 'en-US' : key)) as never
const deT = ((key: string): string | undefined => (key === 'promo.locale' ? 'de-DE' : key)) as never

async function render(node: React.ReactElement): Promise<{ container: HTMLDivElement, unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => { root.render(node) })
  return {
    container,
    async unmount() {
      await act(async () => { root.unmount() })
      container.remove()
    },
  }
}

afterEach(() => { document.body.innerHTML = '' })

const BADGE = { text: { en: 'Off-Peak 60% off', zh: '错峰 4 折' }, tone: 'success' as const }

describe('文案取值：按读者语言，空格当没有', () => {
  it('中文界面取 zh，英文界面取 en', () => {
    expect(resolveHostBadgeText(BADGE.text, 'zh')).toBe('错峰 4 折')
    expect(resolveHostBadgeText(BADGE.text, 'en-US')).toBe('Off-Peak 60% off')
  })

  it('语言没命中时退到基语言，再退到 en（宿主契约里的必填兜底）', () => {
    expect(resolveHostBadgeText({ en: 'Fallback', 'pt-br': 'Queda' }, 'pt-br')).toBe('Queda')
    // `pt-br` 的基语言 `pt` 没写 → 退 `en`。
    expect(resolveHostBadgeText({ en: 'Fallback' }, 'pt-BR')).toBe('Fallback')
  })

  it('字面量原样返回', () => {
    expect(resolveHostBadgeText('Free trial', 'zh')).toBe('Free trial')
  })

  it('空串与空白等于没有（宿主自己会画出真空胶囊，这里比它更严）', () => {
    expect(resolveHostBadgeText('', 'zh')).toBeUndefined()
    expect(resolveHostBadgeText('   ', 'zh')).toBeUndefined()
    expect(resolveHostBadgeText({ en: '' }, 'zh')).toBeUndefined()
    // 缺 en 且当前语言没命中：宿主那边同样解析成 undefined。
    expect(resolveHostBadgeText({ zh: '错峰 4 折' }, 'de-DE')).toBeUndefined()
  })

  it('读不懂的形状返回 undefined，不抛', () => {
    for (const value of [undefined, null, 42, [], { en: 42 }, true]) {
      expect(() => resolveHostBadgeText(value, 'zh')).not.toThrow()
      expect(resolveHostBadgeText(value, 'zh')).toBeUndefined()
    }
  })
})

describe('tone：认不出来按 neutral，不抛也不留白', () => {
  it('四个合法 tone 各有配色', () => {
    for (const tone of ['neutral', 'info', 'success', 'warning'] as const) {
      expect(hostBadgePaint(tone).color).toBeTruthy()
      expect(hostBadgePaint(tone).background).toBeTruthy()
    }
  })

  it('info 用 state-business-primary（不是 brand-primary）、warning 用 state-warn-primary', () => {
    // 这两个最容易抄错；抄错了同一行里两颗胶囊颜色就对不上。
    expect(hostBadgePaint('info').color).toContain('state-business-primary')
    expect(hostBadgePaint('warning').color).toContain('state-warn-primary')
    expect(hostBadgePaint('warning').color).not.toContain('state-warn-secondary')
  })

  it('没见过的 tone 退回 neutral', () => {
    expect(hostBadgePaint('brand-new-tone' as never)).toEqual(hostBadgePaint('neutral'))
  })
})

describe('drawableHostBadge：画不画由文案决定', () => {
  it('文案读得出来就画，tone 原样带上', () => {
    expect(drawableHostBadge(BADGE, 'zh')).toEqual({ badge: BADGE, label: '错峰 4 折' })
  })

  it('文案读不出来就不画（否则会留下一颗空胶囊）', () => {
    expect(drawableHostBadge({ text: { en: '' }, tone: 'info' }, 'zh')).toBeUndefined()
    expect(drawableHostBadge({ tone: 'info' }, 'zh')).toBeUndefined()
  })

  it('没有 tone 时按 neutral —— 不因为缺字段就整枚不画', () => {
    expect(drawableHostBadge({ text: 'Free' }, 'zh')?.badge.tone).toBe('neutral')
  })

  it('null / 非对象 / 数组都不抛', () => {
    for (const value of [null, undefined, 42, 'Free', []]) {
      expect(() => drawableHostBadge(value, 'zh')).not.toThrow()
      expect(drawableHostBadge(value, 'zh')).toBeUndefined()
    }
  })
})

describe('ForeignModelLabel：顺序是硬要求', () => {
  it("placement === 'trigger' 时胶囊在**前**，名字在后", async () => {
    const { container, unmount } = await render(
      React.createElement(ForeignModelLabel, {
        model: { name: 'Qwen3.8-Max', badge: BADGE },
        placement: 'trigger',
        t: zhT,
      }),
    )
    const text = container.textContent ?? ''
    expect(text).toBe('错峰 4 折 Qwen3.8-Max')
    expect(text.indexOf('错峰')).toBeLessThan(text.indexOf('Qwen3.8-Max'))
    await unmount()
  })

  it("placement === 'menu' / 'option' 时名字在**前**，胶囊在后", async () => {
    for (const placement of ['menu', 'option']) {
      const { container, unmount } = await render(
        React.createElement(ForeignModelLabel, {
          model: { name: 'Qwen3.8-Max', badge: BADGE },
          placement,
          t: zhT,
        }),
      )
      const text = container.textContent ?? ''
      expect(text).toBe('Qwen3.8-Max 错峰 4 折')
      expect(text.indexOf('Qwen3.8-Max')).toBeLessThan(text.indexOf('错峰'))
      await unmount()
    }
  })

  it('胶囊带着 tone 的配色与宿主的几何类', async () => {
    const { container, unmount } = await render(
      React.createElement(ForeignModelLabel, { model: { name: 'M', badge: BADGE }, placement: 'menu', t: zhT }),
    )
    const chip = container.querySelector('.dsm-qoder-model-label-host-badge') as HTMLElement | null
    expect(chip).not.toBeNull()
    expect(chip?.style.color).toContain('state-success-primary')
    // 宿主那颗**没有描边**；加了描边同一行里两颗胶囊就不一样了。
    expect(chip?.getAttribute('style') ?? '').not.toContain('border')
    expect(chip?.getAttribute('style') ?? '').not.toContain('max-width')
    await unmount()
  })

  it('语言跟着界走：同一个 badge 在英文界面显示英文', async () => {
    const { container, unmount } = await render(
      React.createElement(ForeignModelLabel, { model: { name: 'M', badge: BADGE }, placement: 'menu', t: enT }),
    )
    expect(container.textContent).toBe('M Off-Peak 60% off')
    await unmount()
  })
})

describe('ForeignModelLabel：读不到就退成纯名字，绝不抛', () => {
  const cases: Array<[string, unknown, Translate | undefined]> = [
    ['没有 badge 字段（0.2.2 之前的宿主就是这样）', undefined, zhT],
    ['badge 是 null', null, zhT],
    ['badge 是数字', 42, zhT],
    ['text 是空串', { text: '', tone: 'info' }, zhT],
    // 缺 en、界面语言又是 de：宿主的 resolveText 会得到 undefined —— 一颗空胶囊。
    ['text 缺 en 且界面语言是 de', { text: { zh: '错峰 4 折' }, tone: 'info' }, deT],
  ]

  for (const [what, badge, t] of cases) {
    it(`${what} → 纯目录名`, async () => {
      const { container, unmount } = await render(
        React.createElement(ForeignModelLabel, { model: { name: 'Qwen3.8-Max', badge }, placement: 'menu', t }),
      )
      expect(container.textContent).toBe('Qwen3.8-Max')
      expect(container.querySelector('.dsm-qoder-model-label-host-badge')).toBeNull()
      await unmount()
    })
  }

  it('tone 认不出来仍然画，只是按 neutral 上色（不因为配色不认识就丢掉数据）', async () => {
    const { container, unmount } = await render(
      React.createElement(ForeignModelLabel, {
        model: { name: 'Qwen3.8-Max', badge: { text: 'Free', tone: 'brand-new-tone' } },
        placement: 'menu',
        t: zhT,
      }),
    )
    expect(container.textContent).toBe('Qwen3.8-Max Free')
    const chip = container.querySelector('.dsm-qoder-model-label-host-badge') as HTMLElement | null
    expect(chip?.style.color).toBe(hostBadgePaint('neutral').color)
    await unmount()
  })

  it('读不到胶囊时不留分隔符（否则名字后面挂一个看不见的空白）', async () => {
    const { container, unmount } = await render(
      React.createElement(ForeignModelLabel, { model: { name: 'M', badge: null }, placement: 'menu', t: zhT }),
    )
    expect(container.textContent).toBe('M')
    await unmount()
  })

  it('名字一个字符都不改（名字是稳定标识，胶囊才是易变的那一半）', async () => {
    const name = 'GLM-5.3 · x0.79'
    const { container, unmount } = await render(
      React.createElement(ForeignModelLabel, { model: { name, badge: BADGE }, placement: 'menu', t: zhT }),
    )
    expect(container.textContent).toContain(name)
    await unmount()
  })

  it('t 缺席（单测/老宿主）也不抛，按浏览器语言取', async () => {
    const { container, unmount } = await render(
      React.createElement(ForeignModelLabel, { model: { name: 'M', badge: BADGE }, placement: 'menu' }),
    )
    // jsdom 的 navigator.language 是 en-US。
    expect(container.textContent).toBe('M Off-Peak 60% off')
    await unmount()
  })
})
