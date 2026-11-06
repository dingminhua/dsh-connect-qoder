/**
 * composer 积分浮层的溢出实测（issue #34）。
 *
 * 为什么必须两段：
 *   - jsdom 不做布局，量不出 `scrollWidth` 与 `clientWidth`；
 *   - 手写一段假 DOM 交给 Chrome 只能验证 CSS 的拳脚，验证不了组件真的产出了这套
 *     结构、也不知道真实文案有多长（那两条长句来自 locales.ts，不是这里编的）。
 *
 * 所以：这里用**真正的 `ComposerCredits`** 渲染一份账号表，把 DOM 交给 Chrome 做
 * 真实布局，然后读浮层的 `scrollWidth` 与「积分」列的位置。
 *
 * 四种构造，覆盖 issue 里点到的全部长度档：
 *   - 中文长文案（`row.unlockSuffixWindow`，截图里那条，30 字）
 *   - 中文更长一档（`row.poolRetryUnknown` + `row.poolRetryFallback`，1.17.5 新增）
 *   - 英文长文案（国际版比中文更长）
 *   - 超长账号名（账号名那侧只有 ellipsis，它不该反过来把表撑开）
 *
 * 用法：
 *   npx vitest run --config scripts/vitest.preview.config.ts -t 溢出
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ComposerCredits } from '../src/client/ComposerCredits.tsx'
import { QODER_COMPOSER_CSS } from '../src/client/styles.ts'
import { qoderLocales, render } from '../src/client/locales.ts'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** 真翻译器：用 zh / en 两份 locale 拼出真实长度的句子。 */
function translatorFor(locale: 'zh' | 'en'): any {
  return (key: string, params?: Record<string, unknown>): string => {
    const template = (qoderLocales[locale] as Record<string, string>)[key]
    if (template === undefined) throw new Error(`missing ${locale} key: ${key}`)
    if (params === undefined) return template
    const vars: Record<string, string> = {}
    for (const [name, value] of Object.entries(params)) vars[name] = String(value)
    return render(template, vars)
  }
}

const outDir = mkdtempSync(join(tmpdir(), 'qoder-panel-overflow-'))
/** 每次测量写一个**独立**文件；同名覆盖的页面会被 Chrome 的缓存读成上一次的。 */
let pageCounter = 0

/** 一个账号行的构造，只有名字与「第二行是什么」在变。 */
interface RowSpec {
  id: string
  accountName: string
  excludedBy?: 'out-of-credit' | 'rate-limited'
  /** `quota-refresh` = 按签到快照推算解禁时刻；`unknown-cooldown` = 上游没给。 */
  retrySource?: 'quota-refresh' | 'unknown-cooldown'
  retryAtMs?: number
  credits?: number
}

/**
 * 渲染浮层，返回它的 outerHTML —— 交给 Chrome 去做真实布局。
 *
 * 用**生产代码同一个** `t`：长文案的字节数就是用户看到的字节数，不是这里编的。
 */
async function panelHtml(locale: 'zh' | 'en', rows: RowSpec[]): Promise<string> {
  const t = translatorFor(locale)
  const accounts = rows.map(row => ({
    id: row.id,
    accountName: row.accountName,
    selected: row.id === rows[0]!.id,
    current: row.id === rows[0]!.id,
    ...row.excludedBy === undefined ? {} : { excludedBy: row.excludedBy },
    ...row.retrySource === undefined ? {} : { retrySource: row.retrySource },
    ...row.retryAtMs === undefined ? {} : { retryAtMs: row.retryAtMs },
    ...row.credits === undefined ? {} : { credits: row.credits },
  }))
  const usage = {
    status: 'signed-in',
    accountId: accounts[0]!.id,
    accountName: accounts[0]!.accountName,
    region: 'cn',
    enabled: true,
    accounts: accounts.map(a => ({ id: a.id, accountName: a.accountName, selected: a.selected })),
    models: [],
    enabledModelKeys: [],
    offModelKeys: [],
    imageModelKeys: [],
    credits: { total: 12_345, packages: [], expiringSoon: 0 },
    pool: {
      enabled: true,
      memberAccountIds: accounts.map(a => a.id),
      effectiveMemberAccountIds: accounts.map(a => a.id),
      // 池视图也要带上同一批账号：面板的「在用是哪一行」读的就是它。
      accounts: accounts.map((a, index) => ({
        accountId: a.id,
        accountName: a.accountName,
        ...a.credits === undefined ? {} : { credits: a.credits },
        current: index === 0,
        ...a.excludedBy === undefined ? {} : { excludedBy: a.excludedBy },
        ...a.retrySource === undefined ? {} : { retrySource: a.retrySource },
        ...a.retryAtMs === undefined ? {} : { retryAtMs: a.retryAtMs },
      })),
    },
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/account-credits')) {
      return { ok: true, status: 200, json: async () => accounts } as Response
    }
    return { ok: true, status: 200, json: async () => usage } as Response
  }))

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(ComposerCredits, { t, provider: 'qoder', region: 'cn' } as any))
  })
  const trigger = container.querySelector<HTMLButtonElement>('button.dsm-qoder-composer-credits-trigger')!
  await act(async () => { trigger.click() })
  for (let i = 0; i < 3; i += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
  const panel = document.querySelector('.dsm-qoder-composer-panel') as HTMLElement
  expect(panel, '浮层没渲染出来').not.toBeNull()
  const html = panel.outerHTML
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
  return html
}

interface PanelMetrics {
  panelW: number
  clientW: number
  scrollW: number
  overflowX: number
  tableW: number
  /** 每一行：「积分」格的右沿是否越过浮层的内边界。 */
  rows: { name: string, markLines: number | null, creditsRight: number, panelClientRight: number }[]
}

/** 把真实组件产出的浮层交给 Chrome，量出横向溢出量与「积分」列的位置。 */
function measure(panelOuterHtml: string): PanelMetrics {
  const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:#17181c;color:#e6e6e6;
    font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{width:600px;padding:24px}
  ${QODER_COMPOSER_CSS}
</style></head>
<body><div class="wrap"><div id="host">${panelOuterHtml}</div></div>
<script>
(function () {
  var panel = document.querySelector('.dsm-qoder-composer-panel')
  var table = panel.querySelector('table')
  var rows = []
  var bodyRows = panel.querySelectorAll('tbody tr')
  for (var i = 0; i < bodyRows.length; i += 1) {
    var tr = bodyRows[i]
    var mark = tr.querySelector('.dsm-qoder-composer-panel-mark')
    var td = tr.querySelector('td.dsm-qoder-composer-panel-num')
    var lines = null
    if (mark) {
      var lh = parseFloat(getComputedStyle(mark).lineHeight)
      lines = Math.round(mark.getBoundingClientRect().height / lh)
    }
    rows.push({
      name: (tr.querySelector('.dsm-qoder-composer-panel-name') || {}).textContent || '',
      markLines: lines,
      creditsRight: td ? Math.round(td.getBoundingClientRect().right) : null,
      panelClientRight: Math.round(panel.getBoundingClientRect().left + panel.clientLeft + panel.clientWidth),
    })
  }
  var out = document.createElement('pre')
  out.id = 'metrics'
  out.textContent = JSON.stringify({
    panelW: panel.offsetWidth,
    clientW: panel.clientWidth,
    scrollW: panel.scrollWidth,
    overflowX: panel.scrollWidth - panel.clientWidth,
    tableW: table ? table.offsetWidth : null,
    rows: rows,
  })
  document.body.appendChild(out)
})()
</script></body></html>`

  const file = join(outDir, `panel-${pageCounter++}.html`)
  writeFileSync(file, page, 'utf8')
  const dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--virtual-time-budget=2000', '--window-size=760,900',
    '--dump-dom', `file://${file}`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const captured = dom.match(/<pre id="metrics">([\s\S]*?)<\/pre>/)?.[1]
  if (captured === undefined) throw new Error('no metrics in dumped DOM')
  const json = captured
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  return JSON.parse(json) as PanelMetrics
}

const HOUR = 60 * 60 * 1000
const now = Date.now()

const CASES: { title: string, locale: 'zh' | 'en', rows: RowSpec[] }[] = [
  {
    title: '中文：`unlockSuffixWindow` 那条（issue 截图里的一句）',
    locale: 'zh',
    rows: [
      { id: 'a1', accountName: 'acct-demo', credits: 12_345 },
      { id: 'a2', accountName: 'work-account-2', excludedBy: 'out-of-credit', retrySource: 'quota-refresh', retryAtMs: now + 7 * HOUR, credits: 0 },
    ],
  },
  {
    title: '中文：`poolRetryUnknown` + `poolRetryFallback`（1.17.5 新增，比上面更长）',
    locale: 'zh',
    rows: [
      { id: 'a1', accountName: 'acct-demo', credits: 12_345 },
      { id: 'a2', accountName: 'third', excludedBy: 'out-of-credit', retrySource: 'unknown-cooldown', credits: 88 },
    ],
  },
  {
    title: '英文：同一条文案在国际版里更长',
    locale: 'en',
    rows: [
      { id: 'a1', accountName: 'acct-demo', credits: 12_345 },
      { id: 'a2', accountName: 'work-account-2', excludedBy: 'out-of-credit', retrySource: 'unknown-cooldown', credits: 0 },
    ],
  },
  {
    title: '超长账号名（账号名只有 ellipsis，它不该反过来撑开表）',
    locale: 'zh',
    rows: [
      { id: 'a1', accountName: 'acct-demo-verylongaccountnamewithoutspaces', credits: 12_345 },
      { id: 'a2', accountName: 'work-account-2', excludedBy: 'out-of-credit', retrySource: 'quota-refresh', retryAtMs: now + 7 * HOUR, credits: 0 },
    ],
  },
]

describe('composer 积分浮层：长文案不把表格撑出浮层（issue #34）', () => {
  for (const testCase of CASES) {
    it(testCase.title, async () => {
      const metrics = measure(await panelHtml(testCase.locale, testCase.rows))

      // ① 浮层自己不横向溢出。这一条就是 issue 报的现象：文字/列画到框外。
      expect(metrics.overflowX, `浮层横向溢出 ${metrics.overflowX}px：${JSON.stringify(metrics)}`).toBe(0)
      // ② 表格不比浮层的内容盒更宽 —— 表格撑开是溢出的直接原因。
      expect(metrics.tableW).toBeLessThanOrEqual(metrics.clientW)

      // ③ 每一行的「积分」格右沿都落在浮层内边界之内（issue 里「积分列跑到框外」）。
      expect(metrics.rows.length).toBeGreaterThan(1)
      for (const row of metrics.rows) {
        expect(row.creditsRight, `${row.name} 的积分格越过了浮层右边界`).toBeLessThanOrEqual(row.panelClientRight)
      }

      console.log(`  ${testCase.title}\n    ${JSON.stringify(metrics)}`)
    })
  }
})
