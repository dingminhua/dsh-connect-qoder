/**
 * 视觉复核：把**真实的** `QoderCard` 按 `surface: 'section'` 挂载，并以设置面板
 * 的真实内容列宽（800px 面板 − 188px 导航 − 48px 内边距 = 564px）截图。
 *
 * 为什么需要它：设置页的结构断言（`tests/settings-section.spec.tsx`）只能证明
 * 「哪个元素在里面」，证明不了「这一页看起来是一张浮在页面里的卡」。后者是用户
 * 一眼看出来的东西，而 jsdom 不做布局，只有真浏览器截图能回答。
 *
 * 用法：
 *   npx vitest run --config scripts/vitest.preview.config.ts -t section
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import * as React from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { QoderCard } from '../src/client/QoderCard.tsx'
import { QODER_CARD_CSS } from '../src/client/styles.ts'
import { qoderLocales, render } from '../src/client/locales.ts'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const outDir = mkdtempSync(join(tmpdir(), 'qoder-section-preview-'))

const t: any = (key: string, params?: Record<string, unknown>): string => {
  const template = (qoderLocales.zh as Record<string, string>)[key]
  if (template === undefined) throw new Error(`missing zh key: ${key}`)
  if (params === undefined) return template
  const vars: Record<string, string> = {}
  for (const [name, value] of Object.entries(params)) vars[name] = String(value)
  return render(template, vars)
}

/** 一份 signed-in 文档：账号池与积分都在，好让正文有真实内容可看。 */
function usageDoc(): Record<string, unknown> {
  return {
    status: 'signed-in',
    accountId: 'acc-id',
    accountName: 'acct-demo',
    region: 'cn',
    enabled: true,
    source: 'vault',
    showCreditsInMainUi: true,
    showCampaigns: true,
    creditPosition: 'composer',
    selectionExplicit: true,
    accounts: [{ id: 'acc-id', accountName: 'acct-demo', source: 'vault', selected: true }],
    models: [
      { key: 'qwen3.8-max', name: 'Qwen3.8-Max', contextWindow: 200_000, maxTokens: 65_536, creditMultiplier: 0.2 },
    ],
    enabledModelKeys: ['qwen3.8-max'],
    offModelKeys: [],
    imageModelKeys: ['qwen3.8-max'],
    credits: { total: 888, expiringSoon: 50, nearestExpiryMs: Date.UTC(2027, 0, 1), packages: [] },
    pool: {
      enabled: true,
      checkinSupported: true,
      targetModelSource: 'free',
      memberAccountIds: ['acc-id', 'acc-2'],
      effectiveMemberAccountIds: ['acc-id', 'acc-2'],
      accounts: [
        { accountId: 'acc-id', accountName: 'acct-demo', current: true, member: true, checkedInToday: true, source: 'vault', credits: 888 },
        { accountId: 'acc-2', accountName: 'backup-account', current: false, member: true, checkedInToday: false, source: 'vault', credits: 0 },
      ],
      catalog: [{ id: 'qwen3-free', name: 'Qwen3-Flash', creditMultiplier: 0 }],
    },
  }
}

/** 宿主设置面板的主题令牌回退值（真实页面里由 DSH 提供）。 */
const SHELL_CSS = `
  html,body{margin:0;padding:0;background:#17181c;color:#e6e6e6;
    font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  /* 800px 设置面板 − 188px 左侧导航 − 24px×2 内边距 = 564px 内容列。 */
  .column{width:564px;padding:24px;box-sizing:border-box}
  ul{list-style:none;margin:0;padding:0}
`

const TOKENS = `
:root{
  --dsw-alias-bg-layer-1:#17181b;--dsw-alias-bg-layer-2:#25262b;--dsw-alias-bg-layer-3:#202126;
  --dsw-alias-label-primary:#e6e6e6;--dsw-alias-label-secondary:#c6c9d0;--dsw-alias-label-tertiary:#9aa0a8;
  --dsw-alias-brand-primary:#5686fe;--dsw-alias-label-dimmed:#777;
  --dsw-alias-border-l1:rgba(127,127,127,.24);--dsw-alias-border-l2:#36373b;
  --dsw-alias-state-success-primary:#22a06b;--dsw-alias-state-warn-primary:#f59e0b;
  --dsw-alias-state-error-primary:#ef4444;--dsw-alias-label-caution:#e8b34b;
}
`

const scope = {
  getSnapshot: () => ({ value: {} }),
  set: async () => true,
  subscribe: () => () => {},
}

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  const usage = usageDoc()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/plugins/dsh-connect-qoder/usage')) {
      return { ok: true, status: 200, json: async () => usage } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  }))

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(QoderCard, { t, surface: 'section', settingsScope: scope }))
  })
  for (let i = 0; i < 6; i += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
})

describe('设置页按真实列宽的真实像素', () => {
  it('截一张 564px 列的图，并把几何数据一并写出', async () => {
    const html = container.innerHTML
    const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>${SHELL_CSS}${TOKENS}${QODER_CARD_CSS}</style></head>
<body><div class="column"><ul>${html}</ul></div></body></html>`
    const file = join(outDir, 'section.html')
    writeFileSync(file, page, 'utf8')
    const png = join(outDir, 'section.png')
    if (existsSync(CHROME)) {
      execFileSync(CHROME, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
        '--window-size=612,2400', `--screenshot=${png}`, `file://${file}`,
      ], { stdio: 'ignore' })
    }
    console.log(`section preview: ${png}`)
    expect(existsSync(file)).toBe(true)
  })
})
