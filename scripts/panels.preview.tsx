/**
 * 视觉复核：把**真实的** QoderCard 挂到 jsdom 里（与 `tests/card-panels.spec.tsx`
 * 同一套挂载方式），再把渲染出的 DOM 序列化成静态页交给 Chrome 截图。
 *
 * 为什么不是「手写一段假 DOM」：手写的那份只能证明 CSS 写得出来，证明不了组件
 * 真的产出了这套结构。这里跑的就是组件本身——分栏 tab、诊断表、账号池、模型区
 * 都是它自己画的，截图因此可以逐像素对照真机。
 *
 * 为什么放在 `scripts/` 而不是 `tests/`：它要往外写 PNG、还要拉本机 Chrome，
 * 不属于「每次提交都必须跑」的东西。文件名后缀 `.preview.tsx` 让它落在主
 * `vitest.config.ts` 的 `include`（`tests/**`）之外，跑它得显式指定配置：
 *
 *   npx vitest run --config scripts/vitest.preview.config.ts
 *
 * 断言的是「结构对了」而不是像素：像素会随字体/主题漂移，结构不会。截图留在
 * 系统临时目录，需要时人工看。
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
import { QODER_UPSTREAM_DOMAIN } from '../src/status-paths.ts'
import { qoderLocales, render } from '../src/client/locales.ts'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const outDir = mkdtempSync(join(tmpdir(), 'qoder-panel-preview-'))

/** 真实的中文文案表——截图要看的是用户真正看到的字。 */
const t: any = (key: string, params?: Record<string, unknown>): string => {
  // 窄化到真实的键表：拼错一个键应当当场炸，而不是在截图里悄悄留一行空白。
  const template = (qoderLocales.zh as Record<string, string>)[key]
  if (template === undefined) throw new Error(`missing zh key: ${key}`)
  if (params === undefined) return template
  const vars: Record<string, string> = {}
  for (const [name, value] of Object.entries(params)) vars[name] = String(value)
  return render(template, vars)
}

/** 宿主会下发的 signed-in 文档（字段与 `/usage` 应答同形）。 */
function usageDoc(): Record<string, unknown> {
  return {
    status: 'signed-in',
    accountId: 'acc-id',
    accountName: 'dingminhua',
    region: 'cn',
    enabled: true,
    source: 'vault',
    showCreditsInMainUi: true,
    creditPosition: 'composer',
    selectionExplicit: true,
    accounts: [{ id: 'acc-id', accountName: 'dingminhua', source: 'vault', selected: true }],
    models: [
      {
        key: 'qwen3.8-max', name: 'Qwen3.8-Max', contextWindow: 200_000, nativeContextWindow: 1_000_000,
        maxTokens: 65_536, creditMultiplier: 0.2, contextTiers: [200_000, 400_000, 1_000_000],
        thinkingEfforts: ['low', 'medium', 'xhigh'], defaultThinkingEffort: 'medium',
      },
      {
        key: 'qwen3.7-plus', name: 'Qwen3.7-Plus', contextWindow: 200_000, nativeContextWindow: 400_000,
        maxTokens: 32_768, creditMultiplier: 0.1, contextTiers: [200_000, 400_000],
      },
      {
        key: 'qwen3-free', name: 'Qwen3-Flash', contextWindow: 131_072, nativeContextWindow: 131_072,
        maxTokens: 32_768, creditMultiplier: 0, isFree: true,
      },
    ],
    enabledModelKeys: ['qwen3.8-max', 'qwen3.7-plus'],
    offModelKeys: [],
    imageModelKeys: ['qwen3.8-max'],
    credits: {
      total: 1_240,
      expiringSoon: 100,
      nearestExpiryMs: Date.UTC(2026, 10, 20),
      packages: [{ packageName: 'base', remain: 1_140, size: 2_000, monthly: false }],
    },
    contextBudgets: { 'qwen3.8-max': 400_000 },
    thinkingEfforts: { 'qwen3.8-max': 'xhigh' },
    pool: {
      enabled: true,
      checkinSupported: true,
      targetModelSource: 'free',
      memberAccountIds: ['acc-id', 'acc-2'],
      effectiveMemberAccountIds: ['acc-id', 'acc-2'],
      accounts: [
        {
          accountId: 'acc-id', accountName: 'dingminhua', current: true, member: true,
          checkedInToday: true, source: 'vault', credits: 1_240, expiringSoon: 100,
          nearestExpiryMs: Date.UTC(2026, 10, 20),
          probe: { outcome: 'ok', atMs: Date.now() - 60_000, elapsedMs: 1_500, source: 'test-batch' },
        },
        {
          accountId: 'acc-2', accountName: 'backup-account', current: false, member: true,
          checkedInToday: false, source: 'vault', credits: 0, excludedBy: 'out-of-credit',
          probe: { outcome: 'out-of-credit', atMs: Date.now() - 120_000, source: 'live-request' },
        },
      ],
      catalog: [{ id: 'qwen3-free', name: 'Qwen3-Flash', creditMultiplier: 0 }],
    },
    // 让诊断栏的「最近一次失败」有东西可引：上游原文照抄，不翻译。
    refreshError: 'HTTP 503 from gateway.qoder.com.cn — upstream temporarily unavailable',
  }
}

/** 宿主卡片的主题令牌回退值（真实页面里由 DSH 提供）。 */
const SHELL_CSS = `
  html,body{margin:0;padding:0;background:#17181c;color:#e6e6e6;
    font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{width:686px;margin:0 auto;padding:16px}
  ul{list-style:none;margin:0;padding:0}
`

const TOKENS = `
.dsm-plugin-card{
  --dsw-alias-bg-layer-2:#25262b;--dsw-alias-bg-layer-3:#202126;
  --dsw-alias-label-primary:#e6e6e6;--dsw-alias-label-secondary:#c6c9d0;--dsw-alias-label-tertiary:#9aa0a8;
  --dsw-alias-brand-primary:#5686fe;
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
  // `/usage` 的桩：两个区域都回同一份 signed-in 文档（截图只截 cn）。
  // 没有它，卡片会停在「加载中」，分栏 tab 根本不会出现——这正是失败时
  // `no tab dsm-qoder-tab-diag` 的来历。
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
    root.render(React.createElement(QoderCard, { t, view: 'page', settingsScope: scope }))
  })
  // 两份文档（fast + full）落地。
  for (let i = 0; i < 6; i += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
})

/** 切到某一栏并把它截成 PNG，返回文件路径与栏内文字。 */
async function capture(id: 'accounts' | 'models' | 'diag'): Promise<{ png: string, text: string }> {
  const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('.dsm-qoder-panels [role="tab"]'))
    .find(button => button.id === `dsm-qoder-tab-${id}`)
  if (tab === undefined) throw new Error(`no tab dsm-qoder-tab-${id}`)
  await act(async () => { tab.click() })
  for (let i = 0; i < 2; i += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }

  const html = container.innerHTML
  const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>${SHELL_CSS}${TOKENS}${QODER_CARD_CSS}</style></head>
<body><div class="wrap"><ul>${html}</ul></div></body></html>`
  const file = join(outDir, `${id}.html`)
  writeFileSync(file, page, 'utf8')
  const png = join(outDir, `${id}.png`)
  if (existsSync(CHROME)) {
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
      '--window-size=718,2600', `--screenshot=${png}`, `file://${file}`,
    ], { stdio: 'ignore' })
  }
  const panel = container.querySelector<HTMLElement>(`#dsm-qoder-panel-${id}`)
  return { png, text: panel?.textContent ?? '' }
}

describe('卡片三栏的真机结构（截图留在系统临时目录）', () => {
  it('账号栏：账号池与积分偏好都在，且默认是这一栏', async () => {
    const { text } = await capture('accounts')
    expect(text).toContain('账号池')
    expect(text).toContain('dingminhua')
    expect(text).not.toContain('row.panelAccounts')  // 文案键漏出 = 真 bug
  })

  it('模型栏：三行模型、倍率与档位都在', async () => {
    const { text } = await capture('models')
    expect(text).toContain('Qwen3.8-Max')
    expect(text).toContain('(0.20x)')
    expect(text).toContain('已启用 2 个')
  })

  it('诊断栏：上游域名取自与真实请求同一处事实，且失败原文照引', async () => {
    const { text } = await capture('diag')
    expect(text).toContain(QODER_UPSTREAM_DOMAIN.cn)
    expect(text).toContain('HTTP 503 from gateway.qoder.com.cn')
    expect(text).toContain('dingminhua')
    expect(text).not.toContain('acc-id')
  })

  it('截图落在临时目录（人工复核用）', () => {
    // 目录名打出来，需要看图时直接打开。
    console.log(`preview dir: ${outDir}`)
    expect(outDir).toContain('qoder-panel-preview-')
  })
})
