// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 设置页（`settings.section`）这一装载形态的结构性回归。
 *
 * 1.18.0 把配置入口从插件市场的详情页卡片搬进了设置面板左侧导航，于是
 * `QoderCard` 多了第三种装载形态 `surface: 'section'`。它必须：
 *
 *  - **不带** `<li class="dsm-plugin-card">` 折叠外壳（设置页不是插件列表里的
 *    一行，套进去会得到既不像列表项也不像页面的东西）；
 *  - 有标题 → 一句话总述 → 三条核心用途（这一页把账号池、签到、模型目录、积分
 *    读数四件事装在一起，落地时用户先看到的是 tab 栏与账号表，得靠这三行知道
 *    哪些开关买到了什么）；
 *  - 正文与侧边栏整页**一模一样**（同一份 `cardBody`，不是第二个真相）。
 *
 * 兄弟项目 dsh-subagent-default-model 2.1.20/2.1.21 做过同一件事，并在那里踩到
 * 「三条价值写成一段连排文字」与「诊断块又把表单往下推」两个坑，这里一并钉住。
 */
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QoderCard } from '../src/client/QoderCard.tsx'
import { QODER_CARD_CSS } from '../src/client/styles.ts'
import { zh } from '../src/client/locales.ts'
import type { QoderSettingsKey } from '../src/client/locales.ts'

/** 中文文案的直通取词器：断言里能直接读出用了哪个键。 */
const t = ((key: QoderSettingsKey) => zh[key]) as any

function usageDoc(region: string): Record<string, unknown> {
  return {
    status: 'signed-in',
    accountId: 'a1',
    accountName: 'A1',
    region,
    enabled: true,
    showCreditsInMainUi: true,
    selectionExplicit: false,
    accounts: [{ id: 'a1', accountName: 'A1', source: 'vault', selected: true }],
    models: [{ id: 'm1', key: 'm1', name: 'M1', creditMultiplier: 0 }],
    enabledModelKeys: ['m1'],
    offModelKeys: [],
    imageModelKeys: [],
    credits: { total: 92, expiringSoon: 0, packages: [] },
    // 账号池是「正文渲染出来了」最结实的证据：它只在设置文档带 pool 时出现。
    pool: {
      enabled: true,
      checkinSupported: true,
      targetModelId: 'm1',
      targetModelSource: 'preferred',
      memberAccountIds: ['a1'],
      effectiveMemberAccountIds: ['a1'],
      accounts: [{ accountId: 'a1', accountName: 'A1', current: true, member: true, source: 'vault', credits: 92 }],
      catalog: [{ id: 'm1', name: 'M1', creditMultiplier: 0 }],
    },
  }
}

async function mountSection(surface: 'section' | 'page' | undefined): Promise<{
  container: HTMLDivElement
  unmount: () => Promise<void>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const props: Record<string, unknown> = { t }
  if (surface !== undefined) props.surface = surface
  await act(async () => { root.render(React.createElement(QoderCard, props as any)) })
  return {
    container,
    async unmount() {
      await act(async () => { root.unmount() })
      container.remove()
    },
  }
}

describe('QoderCard 的设置页形态（surface: section）', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/plugins/dsh-connect-qoder/usage')) {
        const region = new URL(url, 'http://localhost').searchParams.get('region') ?? 'cn'
        return { ok: true, status: 200, json: async () => usageDoc(region) } as Response
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('不是插件列表的一行：没有折叠外壳，也没有返回按钮', async () => {
    const { container, unmount } = await mountSection('section')
    try {
      expect(container.querySelector('.dsm-qoder-section')).not.toBeNull()
      // 折叠外壳属于「插件列表里的一行」，设置页不是列表项。
      expect(container.querySelector('li.dsm-plugin-card')).toBeNull()
      expect(container.querySelector('button.dsm-plugin-card-header')).toBeNull()
      // 设置面板自己有导航与关闭，不需要「返回会话」。
      expect(container.querySelector('.dsm-qoder-page-back')).toBeNull()
    } finally {
      await unmount()
    }
  })

  it('页头是标题 + 那句供应商说明；总述与三条用途都不再渲染', async () => {
    // 用户实拍：红框圈住「总述 + 三条用途」，蓝框圈住 tab 栏下面那句
    // 「每个 tab 是一个独立供应商（qoder / qoder-global）…」，要求**用蓝框那句
    // 替代红框那段，蓝框那处不要了**。
    //
    // 理由（写在这里，免得以后有人把它们加回去）：两段话讲的是同一件事 —— 两个
    // 供应商各自独立、都在生效。放在一起等于同一句话说两遍，而设置页要往下滚才
    // 看得到真正可操作的东西。
    const { container, unmount } = await mountSection('section')
    try {
      expect(container.querySelector('.dsm-qoder-section-heading')?.textContent)
        .toBe(zh['section.title'])
      // 页头现在是那句供应商说明。
      expect(container.querySelector('.dsm-qoder-section-intro')?.textContent)
        .toBe(zh['row.tabHint'])
      // 三条用途整块消失（不是藏起来、不是换个类名）。
      expect(container.querySelector('.dsm-qoder-section-values')).toBeNull()

      // 而蓝框那一处**不再出现**：正文里的 hint 行必须没有这句。
      const body = container.querySelector('.dsm-qoder-usage-hint')
      expect(body, 'tab 栏下面还留着那句说明').toBeNull()
      expect(container.textContent?.split(zh['row.tabHint']).length, '那句说明出现了不止一次')
        .toBe(2)  // 出现一次 → split 得 2 段
    } finally {
      await unmount()
    }
  })

  it('正文与侧边栏整页是同一份（账号池在，tab 栏在）', async () => {
    const { container: section, unmount: unmountSection } = await mountSection('section')
    try {
      expect(section.querySelector('.dsm-qoder-pool')).not.toBeNull()
      expect(section.querySelector('.dsm-qoder-tabs')).not.toBeNull()
      expect(section.querySelector('.dsm-qoder-section-body .dsm-plugin-card-body')).not.toBeNull()
    } finally {
      await unmountSection()
    }
  })

  /**
   * 设置页里不能有**第二层盒子**。
   *
   * 用户实拍 workbuddy 的设置页做对照：那边内容直接铺在面板那一列里，而这一页
   * 在列里又套了一张带 1px 边框 + 底色 + 12px 圆角 + 20px 内边距的卡片盒 ——
   * 于是「页面」看起来是一张浮在页面里的卡，左边还多出一圈 20px 的真空。
   *
   * jsdom 不做布局，所以这里断言的是**样式声明**（与 `pool-architecture.spec.tsx`
   * 里那些容器查询断言同一种做法）：设置页作用域下的 `.dsm-plugin-card-body`
   * 必须把盒子拆掉。侧边栏整页那一形态**保留**盒子（那里确实没有外壳），所以两件事
   * 各断言各的，不合并。
   */
  it('设置页把正文那层卡片的边框与底色拆掉（内容直接铺在面板列里）', () => {
    const flat = /\.dsm-qoder-section-body \.dsm-plugin-card-body\{([^}]*)\}/.exec(QODER_CARD_CSS)?.[1] ?? ''
    expect(flat, '设置页作用域下没有 .dsm-plugin-card-body 的规则').not.toBe('')
    expect(flat, '还留着边框').toMatch(/border:0\b/)
    expect(flat, '还留着圆角').toMatch(/border-radius:0\b/)
    expect(flat, '还留着内边距（会在列里缩进一圈）').toMatch(/(?:^|;)padding:0(?:;|$)/)
    expect(flat, '还留着卡片底色').toMatch(/background:(?:none|transparent)/)
    // 横向内边距也必须归零：设置面板自己已经有 24px，这里再加就是双重缩进。
    expect(flat, '还有横向内边距').toMatch(/(?:^|;)padding:0(?:;|$)/)
    // 侧边栏整页那一形态**保留**盒子：那里没有设置面板的外壳，去掉就成了一片裸内容。
    expect(QODER_CARD_CSS).toMatch(/\.dsm-qoder-page-body \.dsm-plugin-card-body\{[^}]*border:1px solid/)
  })

  it('正文默认展开：三条用途下面直接就是账号表，不需要再点一次展开', async () => {
    const { container, unmount } = await mountSection('section')
    try {
      // 落在第一个分栏（账号），而不是一片空白。
      const accounts = container.querySelector<HTMLElement>('#dsm-qoder-panel-accounts')
      expect(accounts).not.toBeNull()
      expect(accounts!.hidden).toBe(false)
    } finally {
      await unmount()
    }
  })
})
