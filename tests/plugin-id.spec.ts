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
import { qoderCardSlotKeys, QODER_CARD_SLOT_KEYS } from '../src/client/slot-keys.ts'
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
 * 配置槽位的 key 也是**按包名**建的 —— 同一个身份漂移陷阱的第二处。
 *
 * 插件管理页的槽位约定（DSH 文档原文）：
 *   - `plugins.bundle.config`  → `<package name>`
 *   - `plugins.row.config`     → `<package name>#<row id>`
 *
 * 这两处此前**硬编码**成旧的 unscoped 名，于是改包名之后插件仍然显示「运行中」、
 * 描述与组件行都在，但**配置卡片正文什么都不渲染**（用户看到「功能菜单都没了」）。
 * 因为 key 对不上，槽位注册静默失配，没有任何报错。
 */
describe('configuration slot keys', () => {
  it('keys the bundle and row slots by the package name', () => {
    expect(qoderCardSlotKeys('@acme/dsh-sidebar', 'sidebar')).toEqual({
      bundle: '@acme/dsh-sidebar',
      row: '@acme/dsh-sidebar#sidebar',
    })
  })

  it('uses the real installed package name as the bundle key', () => {
    expect(QODER_CARD_SLOT_KEYS.bundle).toBe(PACKAGE.name)
  })

  it('the build-injected runtime package name equals package.json name', () => {
    // 浏览器半侧运行时读的就是这个常量；它由构建期 define 注入（vitest 里由
    // vitest.config.ts 镜像注入），所以不可能与包名漂移。
    expect(QODER_PACKAGE_NAME).toBe(PACKAGE.name)
  })

  it('uses `<package name>#<entry id>` as the row key', () => {
    // 行 id 是 Host 的 Loader entry id —— 也就是设置命名空间所依据的那个值，
    // 故意保持不带 scope（见 cordis.patch.yml）。
    expect(QODER_CARD_SLOT_KEYS.row).toBe(`${PACKAGE.name}#${QODER_SETTINGS_NS}`)
  })

  it('REGRESSION: the old hardcoded unscoped keys would not match the page', () => {
    // 旧写法（改包名后失配，卡片正文消失）。
    expect(QODER_CARD_SLOT_KEYS.bundle).not.toBe('dsh-connect-qoder')
    expect(QODER_CARD_SLOT_KEYS.row).not.toBe('dsh-connect-qoder#dsh-connect-qoder')
  })

  it.skipIf(!HAS_BUILT_CLIENT)('the built bundle registers under those keys (guards against a stale lib/)', () => {
    const built = builtClient()
    // bundle key 由 define 内联成字面量，可以直接断言。
    expect(built).toContain(`"${QODER_CARD_SLOT_KEYS.bundle}"`)
    // row key 是**运行期模板串**（`<pkg>#<row>`），所以断言「它由注入的包名
    // 与行 id 拼出来」，而不是断言拼接后的字面量 —— 那在 bundle 里并不存在。
    expect(built).toContain('#${rowId}')
    expect(built).toContain('registerCard("plugins.row.config", QODER_CARD_SLOT_KEYS.row)')
  })
})
