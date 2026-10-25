// @vitest-environment jsdom
/**
 * 卡片「活动」区的真实渲染。
 *
 * 结构上要钉住的三件事（都是「渲染成文本检查不出来」的类型）：
 *
 * 1. **查看详情是真链接**：`<a href target="_blank">`，不是一段文字。旧版能读
 *    但本版此前把 `VIEW_DETAILS` 活动行整行跳过，所以「有没有链接」是最容易
 *    悄悄退回老样子的一处。
 * 2. **文案来自上游**：`content.{zh,en}` 给了什么就显示什么，插件不改写；语言
 *    按界面语言挑（宿主优先，浏览器兜底），缺哪边用另一边。
 * 3. **读不到 ≠ 没有**：上游回 500 时显示原因，而不是让「活动」区凭空消失。
 *
 * 判定函数本身（`pickContent` / `rowOf`）在本文件里随渲染一起测；上游形状的
 * 解析在 `tests/upstream.spec.ts` 的 `campaign feed (活动面)`。
 */
import * as React from 'react'
import { act as actFromReact } from 'react'
import { act as actTestUtils } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QoderCard } from '../src/client/QoderCard.tsx'
import { QoderCampaigns } from '../src/client/Campaigns.tsx'
import type { QoderCampaignFeed } from '../src/upstream.ts'

const act: typeof actFromReact = ((React as unknown as { act?: typeof actFromReact }).act
  ?? actTestUtils) as typeof actFromReact

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** 让 `uiLanguage()` 读到指定语言（jsdom 的 navigator.language 是只读 getter）。 */
function setUiLanguage(language: string): void {
  Object.defineProperty(window.navigator, 'language', { value: language, configurable: true })
}

/** 一份把「活动」区文案翻成中文的 t；其余键回显（测的是活动区，不关心别处）。 */
function zhT(): any {
  return (key: string, params?: Record<string, unknown>): string => {
    switch (key) {
      case 'row.campaignsTitle': return '活动'
      case 'row.campaignsEmpty': return '当前没有活动。'
      case 'row.campaignsLoading': return '正在加载活动…'
      case 'row.campaignsError': return `活动信息暂不可用：${String(params?.message ?? '')}`
      case 'row.campaignUntitled': return '未命名活动'
      case 'row.campaignDetails': return '查看详情'
      case 'row.campaignClaimable': return '可领取'
      case 'row.campaignClaimed': return '已领取'
      default: return key
    }
  }
}

/** 2026-10-25 CN 实测形状的一个简化副本。 */
function feed(overrides: Record<string, unknown> = {}): QoderCampaignFeed {
  return {
    campaignUrl: 'https://openapi.qoder.com.cn/growth-page/activity-iframe',
    campaigns: [
      {
        campaignId: 'c1',
        actionType: 'CLAIM_BENEFIT',
        claimStatus: 'CLAIMED',
        amount: 100,
        campaignUrl: 'https://openapi.qoder.com.cn/growth-page/activity-iframe',
        content: {
          zh: {
            title: '每天领 100 Credits',
            description: '每日 10:00（UTC+8）刷新，领取后 30 天有效',
            detailUrl: 'https://docs.qoder.cn/events/100credits',
          },
          en: {
            title: 'Claim 100 Credits Daily',
            description: 'Daily reset: 10:00 (UTC+8). Valid for 30 days after claiming.',
            detailUrl: 'https://docs.qoder.cn/en/events/100credits',
          },
        },
      },
    ],
    ...overrides,
  } as QoderCampaignFeed
}

async function renderCampaigns(
  body: unknown,
  region: 'cn' | 'global',
  translate: any = zhT(),
): Promise<{ container: HTMLDivElement, urls: string[], unmount: () => Promise<void> }> {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    return { ok: true, status: 200, json: async () => body } as Response
  }))
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => { root.render(React.createElement(QoderCampaigns, { region, t: translate })) })
  return {
    container,
    urls,
    async unmount() {
      await act(async () => { root.unmount() })
      container.remove()
    },
  }
}

describe('活动区', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('中文界面渲染上游的 zh 文案、额度与状态词', async () => {
    setUiLanguage('zh-CN')
    const view = await renderCampaigns(feed(), 'cn')
    const root = view.container.querySelector('.dsm-qoder-campaigns')
    expect(root).not.toBeNull()
    expect(root!.querySelector('.dsm-qoder-campaigns-title')!.textContent).toBe('活动')
    expect(root!.querySelector('.dsm-qoder-campaign-row-title')!.textContent).toBe('每天领 100 Credits')
    expect(root!.querySelector('.dsm-qoder-campaign-row-desc')!.textContent).toContain('每日 10:00（UTC+8）刷新')
    expect(root!.querySelector('.dsm-qoder-campaign-row-amount')!.textContent).toBe('+100 Credits')
    expect(root!.querySelector('.dsm-qoder-campaign-row-status')!.textContent).toBe('已领取')
    await view.unmount()
  })

  it('查看详情是带 href 的 <a>（指向 detailUrl，新窗口打开）', async () => {
    setUiLanguage('zh-CN')
    const view = await renderCampaigns(feed(), 'cn')
    const link = view.container.querySelector('a.dsm-qoder-campaign-row-link')
    expect(link).not.toBeNull()
    expect(link!.getAttribute('href')).toBe('https://docs.qoder.cn/events/100credits')
    expect(link!.getAttribute('target')).toBe('_blank')
    expect(link!.textContent).toBe('查看详情')
    await view.unmount()
  })

  it('英文界面用上游的 en 文案', async () => {
    setUiLanguage('en-US')
    const view = await renderCampaigns(feed(), 'cn')
    expect(view.container.querySelector('.dsm-qoder-campaign-row-title')!.textContent).toBe('Claim 100 Credits Daily')
    expect((view.container.querySelector('a.dsm-qoder-campaign-row-link')!).getAttribute('href')).toBe('https://docs.qoder.cn/en/events/100credits')
    await view.unmount()
  })

  it('上游只给了 en 时中文界面也用 en（缺哪边用另一边）', async () => {
    setUiLanguage('zh-CN')
    const one = feed()
    one.campaigns[0]!.content = { en: { title: 'Only EN', description: 'en desc', detailUrl: 'https://example.com/en' } }
    const view = await renderCampaigns(one, 'cn')
    expect(view.container.querySelector('.dsm-qoder-campaign-row-title')!.textContent).toBe('Only EN')
    await view.unmount()
  })

  it('上游没给 detailUrl 也没有 campaignUrl：不渲染链接，也不编一个', async () => {
    setUiLanguage('zh-CN')
    const one = feed()
    // 删除而非赋 undefined：`exactOptionalPropertyTypes` 不许把 undefined 写给 `?:` 字段。
    delete one.campaignUrl
    delete one.campaigns[0]!.campaignUrl
    one.campaigns[0]!.content = { zh: { title: '无链接活动', description: '说明' } }
    const view = await renderCampaigns(one, 'cn')
    expect(view.container.querySelector('a.dsm-qoder-campaign-row-link')).toBeNull()
    expect(view.container.querySelector('.dsm-qoder-campaign-row-title')!.textContent).toBe('无链接活动')
    await view.unmount()
  })

  it('VIEW_DETAILS banner 也渲染（旧版能读的那一类），但不画状态词', async () => {
    setUiLanguage('zh-CN')
    const one = feed()
    one.campaigns = [{
      campaignId: 'c2', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED',
      campaignUrl: 'https://openapi.qoder.com.cn/growth-page/activity-iframe',
      content: { zh: { title: '1024 | 创造力集结', description: '加入集结，和社区一起达成目标，解锁 SOTA 补给包。' } },
    }]
    const view = await renderCampaigns(one, 'cn')
    expect(view.container.querySelector('.dsm-qoder-campaign-row-title')!.textContent).toBe('1024 | 创造力集结')
    expect(view.container.querySelector('.dsm-qoder-campaign-row-desc')!.textContent).toContain('社区一起达成目标')
    expect(view.container.querySelector('.dsm-qoder-campaign-row-status')).toBeNull()
    expect(view.container.querySelector('a.dsm-qoder-campaign-row-link')).not.toBeNull()
    await view.unmount()
  })

  it('上游没下发活动：显示静默的一行「当前没有活动。」', async () => {
    setUiLanguage('zh-CN')
    const view = await renderCampaigns({ campaigns: [] }, 'cn')
    expect(view.container.querySelectorAll('.dsm-qoder-campaign-row')).toHaveLength(0)
    expect(view.container.querySelector('.dsm-qoder-campaigns-empty')!.textContent).toBe('当前没有活动。')
    await view.unmount()
  })

  it('读取失败显示原因（「读不到」不是「没有」）', async () => {
    setUiLanguage('zh-CN')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) } as Response)))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => { root.render(React.createElement(QoderCampaigns, { region: 'cn' as const, t: zhT() })) })
    const alert = container.querySelector('.dsm-qoder-campaigns-error[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert!.textContent).toBe('活动信息暂不可用：HTTP 500')
    await act(async () => { root.unmount() })
    container.remove()
  })

  it('按区域拉取（URL 带 region），区域不同拉的不是同一份', async () => {
    setUiLanguage('zh-CN')
    const cnView = await renderCampaigns(feed(), 'cn')
    expect(cnView.urls.some(u => u.includes('/plugins/dsh-connect-qoder/campaigns?region=cn'))).toBe(true)
    await cnView.unmount()
    const globalView = await renderCampaigns(feed(), 'global')
    expect(globalView.urls.some(u => u.includes('/plugins/dsh-connect-qoder/campaigns?region=global'))).toBe(true)
    await globalView.unmount()
  })

  it('QoderCard 把活动区挂进区域作用域（用量之外的整块）', async () => {
    setUiLanguage('zh-CN')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/usage')) {
        return { ok: true, status: 200, json: async () => ({
          status: 'signed-in', region: 'cn', enabled: true, showCreditsInMainUi: true,
          accounts: [{ id: 'a1', accountName: 'A1', source: 'settings', selected: true }],
          models: [], enabledModelKeys: [], offModelKeys: [], imageModelKeys: [],
        }) } as Response
      }
      if (url.includes('/campaigns')) return { ok: true, status: 200, json: async () => feed() } as Response
      return { ok: false, status: 404, json: async () => ({}) } as Response
    }))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    await act(async () => { root.render(React.createElement(QoderCard, { t: zhT(), view: 'page' })) })
    const section = container.querySelector('.dsm-qoder-campaigns')
    expect(section).not.toBeNull()
    expect(section!.querySelector('.dsm-qoder-campaign-row-title')!.textContent).toBe('每天领 100 Credits')
    // 挂在区域作用域内（.dsm-qoder-usage 之外、分栏 tablist 之前），不是分栏之一。
    const usage = container.querySelector('.dsm-qoder-usage')
    const panels = container.querySelector('.dsm-qoder-panels')
    expect(usage!.contains(section)).toBe(false)
    expect(panels!.contains(section)).toBe(false)
    await act(async () => { root.unmount() })
    container.remove()
  })
})
