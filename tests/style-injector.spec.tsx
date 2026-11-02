// @vitest-environment jsdom
/**
 * 插件自己往文档里注入的样式表：**谁拥有它**、**它会不会被刷新**。
 *
 * ## 为什么这两件事要单独钉
 *
 * 宿主（`@deepseek-ai/dsh-client-modules`）按 **npm 包名** 认领插件的样式：
 * 客户端图谱的一行 id 就是包名（`resolveMeta` → `packageName`），
 * `removeOwnedStyles(id)` 删的就是 `style[data-plugin=<包名>]`。宿主自己生成的
 * 客户端 bundle 也这么打标（`tag.dataset.plugin = <包名>`）。
 *
 * 本插件曾经写的是 **Loader entry id**（`dsh-connect-qoder`），而它的包名是
 * `@dmh2002/dsh-connect-qoder` —— 两者对不上，宿主永远清不掉它的样式表。
 * （同族的 `dsh-connect-workbuddy` 没这个毛病，纯粹因为它的包名恰好等于它的
 * entry id，两件事碰巧是同一个字符串。）
 *
 * 第二件事更隐蔽：**样式表只「缺失时才追加」**。宿主重建 bundle 会重新 import
 * 本模块，于是这段顶层代码再跑一遍 —— 而浏览器里那张表**已经存在**，于是新样式
 * 永远进不去。症状是「代码更新了、样式没更新」：设置按钮按新 CSS 应该是品牌色
 * 药丸，浏览器却还在用第一版（那版里根本没有这颗按钮的规则），于是它渲染成
 * 一颗浏览器默认的按钮。用户看到的正是「样式没学对」。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 同款注入形状，但那份「只追加」在它的包名/entry id 巧合下看不出问题。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installPluginStyle, PLUGIN_STYLE_OWNER } from '../src/client/style-injector.ts'
import { QODER_PACKAGE_NAME } from '../src/version.ts'

/** The Host's own removal rule, copied from the harness: it keys by package name. */
function removeOwnedStyles(id: string): void {
  for (const el of Array.from(document.querySelectorAll('style[data-plugin]'))) {
    if (el.getAttribute('data-plugin') === id) el.remove()
  }
}

beforeEach(() => {
  document.head.innerHTML = ''
})

afterEach(() => {
  document.head.innerHTML = ''
})

describe('样式表的所有权', () => {
  it('data-plugin 用的是 npm 包名，宿主才认得出来（清样式时能删掉）', () => {
    // 宿主按包名删样式表。写 entry id 的话，宿主永远找不到自己的东西。
    expect(PLUGIN_STYLE_OWNER).toBe(QODER_PACKAGE_NAME)
    expect(PLUGIN_STYLE_OWNER).toBe('@dmh2002/dsh-connect-qoder')
    // Loader entry id 是**另一个**标识符（配置命名空间与 /plugins 路由用它）。
    expect(PLUGIN_STYLE_OWNER).not.toBe('dsh-connect-qoder')
  })

  it('注入后宿主按包名就能把它清掉', () => {
    installPluginStyle('dsh-connect-qoder/client.css', '.a{color:red}')
    const sheet = document.querySelector('style[data-plugin-css="dsh-connect-qoder/client.css"]')
    expect(sheet).not.toBeNull()
    expect(sheet!.getAttribute('data-plugin')).toBe(QODER_PACKAGE_NAME)
    // 宿主的动作：按包名删。
    removeOwnedStyles(QODER_PACKAGE_NAME)
    expect(document.querySelector('style[data-plugin-css="dsh-connect-qoder/client.css"]')).toBeNull()
  })

  it('注入两张表时，两张都归宿主管', () => {
    installPluginStyle('dsh-connect-qoder/client.css', '.a{color:red}')
    installPluginStyle('dsh-connect-qoder/composer-credits.css', '.b{color:blue}')
    expect(document.querySelectorAll(`style[data-plugin="${QODER_PACKAGE_NAME}"]`)).toHaveLength(2)
    removeOwnedStyles(QODER_PACKAGE_NAME)
    expect(document.querySelectorAll('style[data-plugin]')).toHaveLength(0)
  })
})

describe('样式表会被就地刷新（而不是只追加一次）', () => {
  it('同一张表再次注入时更新内容，而不是留下第一版', () => {
    installPluginStyle('dsh-connect-qoder/composer-credits.css', '.pill{background:red}')
    installPluginStyle('dsh-connect-qoder/composer-credits.css', '.pill{background:blue}')
    const sheets = document.querySelectorAll<HTMLStyleElement>('style[data-plugin-css="dsh-connect-qoder/composer-credits.css"]')
    // 只有一张表（不能追加出第二张）。
    expect(sheets).toHaveLength(1)
    // 内容是**新版**。
    expect(sheets[0]!.textContent).toContain('blue')
    expect(sheets[0]!.textContent).not.toContain('red')
  })

  it('一张被旧版本注入的表（entry id 打标）也会被认领回包名并刷新', () => {
    // 模拟「页面在旧版本下已经加载过」：表存在，但打标用的是 entry id。
    const stale = document.createElement('style')
    stale.dataset.plugin = 'dsh-connect-qoder'
    stale.dataset.pluginCss = 'dsh-connect-qoder/composer-credits.css'
    stale.textContent = '.pill{background:red}'
    document.head.appendChild(stale)

    installPluginStyle('dsh-connect-qoder/composer-credits.css', '.pill{background:blue}')

    expect(document.querySelectorAll('style[data-plugin-css="dsh-connect-qoder/composer-credits.css"]')).toHaveLength(1)
    const sheet = document.querySelector<HTMLStyleElement>('style[data-plugin-css="dsh-connect-qoder/composer-credits.css"]')!
    expect(sheet.textContent).toContain('blue')
    // 打标被纠正成包名：宿主下一次重建时才能删掉它。
    expect(sheet.getAttribute('data-plugin')).toBe(QODER_PACKAGE_NAME)
  })
})
