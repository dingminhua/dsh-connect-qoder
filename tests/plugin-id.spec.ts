/**
 * 客户端 bundle 的模块 id 必须等于 `package.json` 的 `name`。
 *
 * 这一条在 2026-10-12 把插件整个搞挂过：包名从 `dsh-connect-qoder` 改成带 scope 的
 * `@dmh2002/dsh-connect-qoder`，而 `tsdown.config.ts` 里的 `PLUGIN_ID` 是**硬编码**的
 * 旧名。于是：
 *
 *   1. shell 的客户端模块花名册按**包名**（`resolveMeta` → `packageName`）给每一行
 *      建键；bundle 里声明的 id 却还是旧名 —— 两者对不上；
 *   2. 模块加载器靠「bundle 声明的 id ↔ 花名册行的 id」配对来记住 revision 并在重建时
 *      invalidate（`graphRows` / `reloadTargets` 都以它建键）。对不上就**永远不失效**；
 *   3. 于是 bundle 第二次执行时抛
 *      `client-modules: duplicate factory registration for "dsh-connect-qoder"`，
 *      整个 entry 激活失败（用户在设置页看到「启用失败 … failed to import」）。
 *
 * 这个 bug 单元测试完全看不见（所有测试都是绿的），只有真机激活才会暴露 —— 所以
 * 这里用一条**构建配置层**的守卫把它钉住：改包名就必须同时改 id，否则测试红。
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import configs, { PLUGIN_ID } from '../tsdown.config.ts'
import { QODER_PACKAGE_NAME } from '../src/version.ts'
import { QODER_SETTINGS_NS } from '../src/status-paths.ts'

/**
 * `lib/` is gitignored and `pnpm run check` runs tests BEFORE the build, so on a
 * clean checkout there is no bundle to inspect. The artifact assertions below are
 * skipped in that case rather than throwing — they exist to catch a *stale*
 * build, which only makes sense once a build exists.
 */
const BUILT_CLIENT = new URL('../lib/client.js', import.meta.url)
const HAS_BUILT_CLIENT = existsSync(BUILT_CLIENT)

function builtClient(): string {
  return readFileSync(BUILT_CLIENT, 'utf8')
}

const PACKAGE = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string }

/** The client bundle config (the one whose entry produces `client.js`). */
function clientConfig(): (typeof configs)[number] {
  const found = configs.find(config => JSON.stringify(config.entry).includes('client'))
  if (found === undefined) throw new Error('tsdown config has no client bundle entry')
  return found
}

describe('client bundle module id', () => {
  it('equals the package name (the shell keys the client roster by package name)', () => {
    expect(PLUGIN_ID).toBe(PACKAGE.name)
  })

  it('is what the client bundle banner actually declares', () => {
    const banner = clientConfig().outputOptions?.banner
    expect(typeof banner).toBe('string')
    expect(String(banner)).toContain(`id: ${JSON.stringify(PLUGIN_ID)}`)
  })

  it('REGRESSION: the unscoped Loader entry id must NOT be used as the module id', () => {
    // `cordis.patch.yml` 的 entry `id` 故意保持不带 scope（它承担设置命名空间与
    // /plugins/<id>/… 路由，改名会孤儿化老配置）。那是**另一个**标识，不能拿来当
    // 客户端模块 id —— 一旦包名带 scope，这俩就不再相等。
    expect(PLUGIN_ID).not.toBe('dsh-connect-qoder')
    expect(PLUGIN_ID.startsWith('@')).toBe(true)
  })

  it.skipIf(!HAS_BUILT_CLIENT)('the built bundle declares the same id (guards against a stale lib/)', () => {
    const built = builtClient()
    // 只读前 200 字符：banner 在文件最前面，避免把 240KB 的 bundle 全量载入。
    expect(built.slice(0, 200)).toContain(`id: ${JSON.stringify(PLUGIN_ID)}`)
  })
})

/**
 * 配置入口的身份：1.18.0 起是**设置页分区**，按 `id` 索引，与包名无关。
 *
 * 这条替代了此前那组「`plugins.bundle.config` / `plugins.row.config` 必须按
 * 包名建键」的用例。那套键确实脆弱——改包名时失配过一次，插件显示「运行中」、
 * 描述与组件行都在，但配置正文什么都不渲染，且没有任何报错——所以 1.18.0 把入口
 * 搬进了设置面板：`settings.section` 的键是 `id`（Loader 的 entry id），而
 * `order` / `label` / `locale` 都是注册项自己的字段。包名不再参与这个寻址。
 *
 * 现在要钉的是另外两件事：
 *
 *  1. **id 必须是那个不带作用域的 entry id**。它同时是设置命名空间
 *     （`settingsNamespaceOf`）与 `/plugins/<id>/…` 路由前缀；换成包名会让老用户
 *     的已保存配置成为孤儿。
 *  2. **导航图标必须用同一个 id**。外壳取图标是
 *     `renderSlot('settings.section.icon', …, { only: row.id })`，id 对不上就
 *     静默回落到默认齿轮，页面上看不出任何错误。
 */
describe('settings section identity', () => {
  it('the section id is the unscoped Loader entry id, not the package name', () => {
    expect(QODER_SETTINGS_NS).toBe('dsh-connect-qoder')
    expect(QODER_SETTINGS_NS).not.toBe(PACKAGE.name)
  })

  it('the build-injected runtime package name equals package.json name', () => {
    // 浏览器半侧运行时读的就是这个常量；它由构建期 define 注入（vitest 里由
    // vitest.config.ts 镜像注入），所以不可能与包名漂移。model label 与插件市场
    // 退路都按它寻址。
    expect(QODER_PACKAGE_NAME).toBe(PACKAGE.name)
  })

  it('the client registers the section and its icon under the SAME id', () => {
    // 源码层守卫：两处 `id:` 必须都是 QODER_SETTINGS_NS。写成两个不同的字面量
    // 时，页面能渲染、图标却静默回落到默认齿轮 —— 2.1.17 那次就是这么丢的。
    const source = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
    expect(source).toContain("name: 'settings.section'")
    expect(source).toContain("name: 'settings.section.icon'")
    const ids = [...source.matchAll(/name: 'settings\.section(?:\.icon)?',\s*\n\s*id: ([^,]+),/g)]
      .map(match => (match[1] ?? '').trim())
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    expect(ids[0]).toBe('QODER_SETTINGS_NS')
  })

  it('does not fall back to a capability probe (a false probe is silent death)', () => {
    // 兄弟项目 2.1.16/2.1.17 的教训：`typeof ctx.slots.specOf === 'function'` 这类
    // 探测恒为 false（那个访问器不在 `ctx.slots` 上），整段注册被跳过，界面上没有
    // 任何痕迹也不报错。`slots.inject()` 本身就是探测 —— 宿主没声明槽位时它只等待。
    const source = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
    // 注释里会提到那条教训（`typeof ctx.slots.specOf === 'function'`），所以断言
    // 的是「没有任何地方真的去调用它」。
    expect(source).not.toMatch(/slots\.specOf\s*\(/)
  })

  it.skipIf(!HAS_BUILT_CLIENT)('the built bundle carries the section registration (guards against a stale lib/)', () => {
    const built = builtClient()
    expect(built).toContain('"settings.section"')
    expect(built).toContain('"settings.section.icon"')
    // 旧的插件页卡片槽位必须已经消失，否则同一份配置又有了第二个编辑入口。
    expect(built).not.toContain('"plugins.bundle.config"')
    expect(built).not.toContain('"plugins.row.config"')
  })
})
