/**
 * 真实组件的布局实测：用 jsdom 渲染**真正的 QoderCard**（不是手写结构），
 * 把结果交给 Chrome 做真实布局，然后数清「模型栏到底有没有内滚动」。
 *
 * 为什么必须两段：
 *   - jsdom 不做布局，量不出 `scrollHeight` vs `clientHeight`；
 *   - 手写一段假 DOM 交给 Chrome 只能验证 CSS 的拳脚，验证不了组件真的产出了
 *     这套结构、也没有哪个组件内的行内样式在偷偷加约束。
 *
 * 用法：
 *   npx vitest run --config scripts/vitest.preview.config.ts -t 滚动
 *
 * 断言写在 tests 里（见该文件末尾的 describe）：这里先把件数放大到 25 条，
 * 逐层报告 `clientHeight / scrollHeight / overflowY / max-height`。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import * as React from 'react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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

/** 这一轮到底塞多少个模型：远超真实目录（实测两个区域共 29 条）。 */
const MODEL_COUNT = 25

const t: any = (key: string, params?: Record<string, unknown>): string => {
  const template = (qoderLocales.zh as Record<string, string>)[key]
  if (template === undefined) throw new Error(`missing zh key: ${key}`)
  if (params === undefined) return template
  const vars: Record<string, string> = {}
  for (const [name, value] of Object.entries(params)) vars[name] = String(value)
  return render(template, vars)
}

function usageDoc(): Record<string, unknown> {
  const models = Array.from({ length: MODEL_COUNT }, (_, index) => ({
    key: `model-${index}`,
    name: `Qwen3.${index}-Test`,
    contextWindow: 200_000,
    nativeContextWindow: 1_000_000,
    maxTokens: 65_536,
    creditMultiplier: 0.2,
    contextTiers: [200_000, 400_000, 1_000_000],
    thinkingEfforts: ['low', 'medium', 'xhigh'],
    defaultThinkingEffort: 'medium',
  }))
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
    models,
    enabledModelKeys: models.map(model => model.key),
    offModelKeys: [],
    imageModelKeys: [],
    credits: { total: 92, expiringSoon: 0, packages: [] },
    contextBudgets: {},
    thinkingEfforts: {},
  }
}

const scope = {
  getSnapshot: () => ({ value: {} }),
  set: async () => true,
  subscribe: () => () => {},
}

let container: HTMLDivElement
let root: Root
const outDir = mkdtempSync(join(tmpdir(), 'qoder-real-layout-'))

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
    root.render(React.createElement(QoderCard, { t, view: 'page', settingsScope: scope }))
  })
  for (let i = 0; i < 6; i += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
  // 切到模型栏：要量的就是这一栏。
  const modelsTab = Array.from(container.querySelectorAll<HTMLButtonElement>('.dsm-qoder-panels [role="tab"]'))
    .find(button => button.id === 'dsm-qoder-tab-models')
  if (modelsTab === undefined) throw new Error('no models tab')
  await act(async () => { modelsTab.click() })
  for (let i = 0; i < 2; i += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
})

afterAll(async () => {
  await act(async () => { root.unmount() })
  container.remove()
})

/** Chrome 量回来的一层盒子的滚动几何。 */
interface BoxMetric {
  cls: string
  clientH: number
  scrollH: number
  overflows: boolean
  overflowY: string
  maxHeight: string
  [key: string]: unknown
}

/** 一个自己滚动（overflow auto/scroll）且内容真的超出高度的盒子。 */
interface ScrollerMetric {
  cls: string
  clientH: number
  scrollH: number
  overflowY: string
}

interface LayoutMetrics {
  renderedRows: number
  listOverflows: boolean
  rowsInViewport: number
  /** 卡片内部所有真的在滚动的元素（列表之外的一个都不许有）。 */
  cardScrollers: ScrollerMetric[]
  chain: BoxMetric[]
}

/** 把真实组件渲染出的 DOM 交给 Chrome，量出每一层的滚动几何。 */
function measureInChrome(): LayoutMetrics {
  const shell = `<style>
  html,body{margin:0;padding:0;background:#17181c;color:#e6e6e6;
    font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{width:686px;margin:0 auto;padding:16px}
  ul{list-style:none;margin:0;padding:0}
  /* 宿主插件页外壳：height:100% + overflow:auto（照抄 _page 那条约束）。 */
  .shell{height:600px;overflow:auto}
  .dsm-plugin-card{--dsw-alias-bg-layer-2:#25262b;--dsw-alias-bg-layer-3:#202126;
    --dsw-alias-label-primary:#e6e6e6;--dsw-alias-label-secondary:#c6c9d0;--dsw-alias-label-tertiary:#9aa0a8;
    --dsw-alias-brand-primary:#5686fe;--dsw-alias-border-l1:rgba(127,127,127,.24);--dsw-alias-border-l2:#36373b;
    --dsw-alias-state-success-primary:#22a06b;--dsw-alias-state-warn-primary:#f59e0b;
    --dsw-alias-state-error-primary:#ef4444;--dsw-alias-label-caution:#e8b34b}
  ${QODER_CARD_CSS}
</style>`

  const probe = `<script>
  (function () {
    function describe(el) {
      if (!el) return null
      const cs = getComputedStyle(el)
      return {
        cls: el.className && String(el.className).split(' ').filter(Boolean).join('.'),
        clientH: el.clientHeight, scrollH: el.scrollHeight,
        overflows: el.scrollHeight - el.clientHeight > 1,
        overflowY: cs.overflowY, maxHeight: cs.maxHeight,
      }
    }
    var list = document.querySelector('.dsm-qoder-model-list')
    var chain = []
    for (var el = list; el && el !== document.documentElement; el = el.parentElement) chain.push(describe(el))
    var rows = document.querySelectorAll('.dsm-qoder-model')
    // 有多少行真的落在视口里（用于说明「全部呈现」不是靠滚动实现的）。
    var visible = 0
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i].getBoundingClientRect()
      if (r.bottom > 0 && r.top < window.innerHeight) visible += 1
    }

    // **卡片内部**任何会滚动的元素，逐个数出来。
    //
    // 只看列表自己的祖先是不够的：真正烦人的是「模型列表不滚、但外面某一层在滚」
    // ——用户体感一样是滚动条。所以把卡片里所有 overflow 为 auto/scroll 且确实
    // 超出高度的元素全找出来，一个都不许漏。卡片之外（宿主插件页 .shell）那层
    // 滚动是页面滚动，不在这个范围里。
    var card = document.querySelector('.dsm-plugin-card')
    var scrollers = []
    if (card) {
      var all = card.querySelectorAll('*')
      for (var j = 0; j < all.length; j += 1) {
        var node = all[j]
        var cs = getComputedStyle(node)
        var scrolls = cs.overflowY === 'auto' || cs.overflowY === 'scroll'
        if (!scrolls) continue
        if (node.scrollHeight - node.clientHeight <= 1) continue
        scrollers.push({
          cls: node.className && String(node.className).split(' ').filter(Boolean).join('.'),
          clientH: node.clientHeight,
          scrollH: node.scrollHeight,
          overflowY: cs.overflowY,
        })
      }
    }

    var out = document.createElement('pre')
    out.id = 'metrics'
    out.textContent = JSON.stringify({
      renderedRows: rows.length,
      listOverflows: chain[0] ? chain[0].overflows : null,
      rowsInViewport: visible,
      cardScrollers: scrollers,
      chain: chain,
    })
    document.body.appendChild(out)
  })()
</script>`

  const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${shell}</head>
<body><div class="shell"><div class="wrap"><ul>${container.innerHTML}</ul></div></div>${probe}</body></html>`
  const file = join(outDir, 'real-layout.html')
  writeFileSync(file, page, 'utf8')

  // 同一页再截一张「整张卡片」的图：把模拟宿主的 .shell 那 600px 高度约束去掉，
  // 让截图**按内容高度**出图 —— 一眼能看到 25 行是连着排下来的，而不是被切在
  // 某个高度上。这张图证明的是「全部呈现」，不是「视口刚好装得下」。
  const tallPage = page
    .replace('.shell{height:600px;overflow:auto}', '.shell{height:auto;overflow:visible}')
  const tallFile = join(outDir, 'real-layout-tall.html')
  writeFileSync(tallFile, tallPage, 'utf8')
  const png = join(outDir, 'models-25.png')
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--window-size=760,6000', `--screenshot=${png}`, `file://${tallFile}`,
  ], { stdio: 'ignore' })
  console.log(`  截图（内容全高，无外壳限高）：${png}`)

  const dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--window-size=760,900', '--virtual-time-budget=2000',
    '--dump-dom', `file://${file}`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

  const match = dom.match(/<pre id="metrics">([\s\S]*?)<\/pre>/)
  const captured = match?.[1]
  if (captured === undefined) throw new Error('no metrics in dumped DOM')
  const json = captured
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  return JSON.parse(json) as LayoutMetrics
}

describe('模型栏：全部模型都渲染出来，列表自己不再滚动', () => {
  it('25 个模型全部在 DOM 里，列表没有内滚动条', () => {
    const metrics = measureInChrome()

    // ① 一条都不少：不是「显示 7 条 + 滚动条」，而是 25 条全在。
    expect(metrics.renderedRows).toBe(MODEL_COUNT)

    // ② 列表自己不滚动。这一条是本次要求的正面表达：
    //    `max-height` + `overflow-y:auto` 会让 20 多条目录只露出七八行、把其余
    //    藏在第二条滚动条后面 —— 而外面那层面板本来就会滚。
    expect(metrics.listOverflows, JSON.stringify(metrics.chain[0])).toBe(false)

    // ③ 从列表到卡片外沿的每一层，都没有给它加高度上限、也不自己滚动。
    //
    //    链在这里**刻意截断在卡片**（`.dsm-plugin-card`）：再往外是我为模拟宿主
    //    插件页加的外壳 `.shell`（`height:600px; overflow:auto`，照抄宿主
    //    `_page` 的约束）。那层滚动是**页面**滚动，是不可避免的物理事实——
    //    25 行本来就超过一屏。把它也算进来，这条断言就变成「页面不许滚」，
    //    与本次要求（列表内不许滚）不是同一件事。
    const inside = metrics.chain.slice(0, metrics.chain.findIndex(node => String(node.cls).includes('dsm-plugin-card')) + 1)
    expect(inside.length, '链里应当找得到 .dsm-plugin-card').toBeGreaterThan(1)
    for (const node of inside) {
      expect(node.maxHeight, `${node.cls} 不应有 max-height`).toBe('none')
      expect(node.overflowY, `${node.cls} 不应自己滚动`).not.toBe('auto')
      expect(node.overflowY, `${node.cls} 不应自己滚动`).not.toBe('scroll')
    }

    // ④ 卡片里**任何**元素都不自己滚动（不只是列表与它的祖先）。
    //    只看祖先会漏掉兄弟节点；而「模型列表不滚、换某个内层在滚」在用户体感上
    //    完全是同一件事：还是要在卡片里滚一条内滚动条。模型栏尤其不该有——它的
    //    全部内容就是这张列表。诊断栏那种两列事实表也没有超出的可能。
    expect(metrics.cardScrollers, `卡片内不该有滚动容器：${JSON.stringify(metrics.cardScrollers)}`)
      .toEqual([])

    // ⑤ 说明白「全部呈现」靠的是页面本身变高，而不是视口刚好够：
    //    25 行远超 600px 的外壳，所以确实需要外层滚动 —— 这是不可避免的物理事实，
    //    这里只是把它记下来（外层滚动 vs 列表内滚动是两件事）。
    const list = metrics.chain[0]
    expect(list).toBeDefined()
    expect(list!.clientH).toBeGreaterThan(600)
    // 而外壳确实在滚 —— 证明上面那条「列表不滚」不是靠「什么都没渲染」通过的。
    expect(metrics.chain.at(-2)?.overflowY).toBe('auto')
  })
})
