import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { describe, expect, it } from 'vitest'

/**
 * Guard the declared DSH host line: the lower bound, the upper bound, and —
 * the part that actually matters — the fact that the upper bound BITES.
 *
 * 参考：dsh-connect-workbuddy（MIT）的同名套件。结论与理由：
 * DSH 至今全部 tag 都是预发布（`-rc.N` / `-alpha.N`），所以上界必须写成
 * `<0.3.0-0`（「0.3.0 线一个都不放」），写 `<0.3.0` 等于不挡任何东西：
 * 它只挡 GA，而 GA 从来不来，反而静默放行整条 0.3.0 预发布线。
 * 上界写错不会让任何构建或测试失败——用户侧表现为插件静默消失
 * （组合包被 `loadProfileDirectory` 跳过，只打到 stderr）。
 *
 * 这些用例读 `package.json` 而不是导入源码：要断言的是「发布出去的清单」，
 * `peerDependencies` 是给 shipped 门禁读的数据。
 */

const repoRoot = new URL('../', import.meta.url)

function manifest(): {
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
} {
  return JSON.parse(readFileSync(fileURLToPath(new URL('package.json', repoRoot)), 'utf8'))
}

/**
 * The declared range, in its **two-branch** form.
 *
 * 为什么需要两条分支：node-semver 只有当范围里*某个*比较符与该版本的
 * `major.minor.patch` 元组完全一致、且自身也带预发布标签时，才会放行预发布版本。
 * `>=0.1.7-rc.1 <0.3.0-0` 看着很宽，但在 `0.2.0` 元组上没有任何带预发布标签的
 * 比较符，于是把整条 `0.2.0-rc.*` 线**静默**排除——而 `0.2.0-rc.2` 恰好是
 * `@deepseek-ai/dsh` 当前 `latest`。用户侧表现为 `ERESOLVE`，还得自己手工绕过。
 * 见 awesome-dsh-plugin contributing.md「peer range without an explicit
 * prerelease branch」一条。
 */
const LOWER_BOUND = '>=0.1.7-rc.1'
const BRANCH_0_2 = '>=0.2.0-rc.1'
const UPPER_BOUND = '<0.3.0-0'
const DECLARED_RANGE = `${LOWER_BOUND} <0.2.0-0 || ${BRANCH_0_2} ${UPPER_BOUND} || >=0.2.1-rc.1 ${UPPER_BOUND}`

/**
 * Pre-releases that have actually been published for DSH packages, split by the
 * declared range's intent — measured with node-semver, not with intuition.
 *
 * 注意 semver 的**元组规则**：预发布版本只有在其 `major.minor.patch` 元组上
 * 存在一个「带预发布标签的比较符」时才会被放行。所以：
 *
 * - `0.2.0-rc.*`（当前 `latest` / `next`）必须有分支放行——这是本文件的回归重点；
 * - `0.2.1-rc.*` **也必须放行**：桌面端 0.2.1-rc.1 已经发布并在用，而
 *   `>=0.2.0-rc.1` 这一支只对 `0.2.0` 元组开口，`0.2.1-rc.1` 会被**静默**判 false
 *   （既有缺陷在 0.2.1 上继续暴露，不是本次升级引入）。所以补了第三条分支；
 * - `0.1.7-alpha.*` 早于下界 `0.1.7-rc.1`（alpha 排序在 rc 之前），**有意**排除。
 *
 * 这些是**已发布**的版本，不是对未来版本号的猜测。
 *
 * ���️ **两套语义并存 —— 这是本文件最重要的背景**（1.1.2 实测更正）：
 *
 * 1. **npm / pnpm 安装**走 node-semver **标准**语义：预发布版本只有在其
 *    `major.minor.patch` 元组上存在「带预发布标签的比较符」时才会放行。
 *    按这套，`0.2.2-rc.1` 会被拒，**确实需要**为每个新补丁号手工追加分支。
 *    这就是 `UNGATED_PRERELEASES` 那份待办表的用途。
 *
 * 2. **宿主的插件兼容门禁**（`dsh-app-boot` 的 `evaluatePluginCompatibility`
 *    → `unmetRequirements` → `satisfies`）用的是
 *    `semver.satisfies(v, range, { includePrerelease: true })`。在这套语义下
 *    `>=0.2.1-rc.1 <0.3.0-0` **一支就覆盖整条 0.2.x 线**，`0.2.2-rc.1`、
 *    `0.2.9-rc.99` 全部放行；`0.3.0-rc.1` 仍被 `<0.3.0-0` 拦住。
 *
 * 1.1.0/1.1.1 曾以��「没有任何静态范围能覆盖任意 0.2.x 预发布」是错误结论：
 * 它对 npm 成立，对宿主门禁**不成立**。两套语义都钉在本文件里（见
 * `host gate` 那组用例），这样任何一边行为变化都会红，而不是靠记忆。
 *
 * 副作用（无害但要知道）：宿主门禁放行 `0.2.1-alpha.*`，而 npm 拒。alpha 早于
 * rc.1，插件支持 0.2.1 线就是从 rc.1 开始的，且桌面端从未发布过 0.2.1-alpha。
 */
const ADMITTED_PRERELEASES = [
  '0.1.7-rc.1',
  '0.1.7-rc.2',
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  // 桌面端 0.2.1-rc.1：宿主升级到这一版之后才被发现判 false。
  '0.2.1-rc.1',
  // 0.2.1-rc.2 / rc.3 / rc.4 / rc.5：桌面端继续沿同一条 rc 线推进
  // （rc.5 即当前在跑的宿主）。
  // 同一元组 `0.2.1` 上的 rc 由 `>=0.2.1-rc.1` 这一支放行，不必再开分支。
  '0.2.1-rc.2',
  '0.2.1-rc.3',
  '0.2.1-rc.4',
  '0.2.1-rc.5',
]

/** Published, but deliberately outside the declared range. */
const EXCLUDED_PRERELEASES = [
  '0.1.7-alpha.1', // older than the lower bound
  '0.1.7-alpha.2',
  '0.2.1-alpha.1', // only ever shipped on the `alpha` dist-tag, and sorts BEFORE 0.2.1-rc.1
  '0.2.1-alpha.2',
  '0.3.0-rc.1', // above the declared ceiling
]

/**
 * 已发布、但**npm 标准语义下尚未开闸**的补丁号 rc。
 *
 * ⚠️ 这份表只对 **npm install** 有意义。宿主的兼容门禁带
 * `{ includePrerelease: true }`，把 `0.2.x` 整条线都放行——所以这些版本**装得上**，
 * 只是 `pnpm add` / `npm install` 时会被 peer 解析拒绝。
 *
 * 每一条都是「等它真的需要被 npm 装上时，再加一条分支」的待办，而不是被遗忘的
 * 漏洞。用**反向**断言（必须判 false）记录，于是哪天有人把范围放宽到能覆盖它们，
 * 这条会红，逼着更新这张表并说明理由。
 */
const UNGATED_PRERELEASES = ['0.2.2-rc.1', '0.2.3-rc.1', '0.2.9-rc.1']

/** pi-ai is a peer for the SAME reason but a DIFFERENT version line. */
const PI_AI = '@earendil-works/pi-ai'

function piAiRange(section: 'peerDependencies' | 'devDependencies'): string {
  const range = manifest()[section]?.[PI_AI]
  if (range === undefined) throw new Error(`${PI_AI} is not declared in ${section}`)
  return range
}

function dshPeers(section: 'peerDependencies' | 'devDependencies'): Array<[string, string]> {
  const deps = manifest()[section] ?? {}
  return Object.entries(deps).filter(
    ([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
  )
}

/**
 * Answer "does this range admit this version" with the **real** node-semver —
 * the same library npm/pnpm use to resolve peers.
 *
 * 这一点是必须的：本套件原先自带一个只认「两个比较符」的简易实现，它对
 * **预发布版本**的判断与 node-semver 不一致，于是把一条有缺陷的范围判成了绿的。
 * 具体见 `admits every published prerelease on the current line` 那条用例。
 */
function satisfiesRange(version: string, range: string): boolean {
  return semver.satisfies(version, range)
}

function declaredRange(): string {
  const ranges = new Set(dshPeers('peerDependencies').map(([, range]) => range))
  if (ranges.size !== 1) {
    throw new Error(`dsh-* peers disagree on their range: ${JSON.stringify([...ranges])}`)
  }
  const only = [...ranges][0]
  if (only === undefined) throw new Error('no dsh-* peer dependency declared')
  return only
}

describe('declared DSH host line', () => {
  it('declares every dsh package the plugin actually imports', () => {
    // 反向兜底：这套是源码真实 import 的那批（host 侧）。少一条意味着
    // 有人删声明却没删引用，或反之——两者都该当场发现。
    const names = dshPeers('peerDependencies').map(([name]) => name)
    expect(names).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-attachment',
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-llm-pi-ai',
    ]))
  })

  it('declares the dsh client packages the bundle injects', () => {
    const names = dshPeers('devDependencies').map(([name]) => name)
    expect(names).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-settings-plugins',
      '@deepseek-ai/dsh-client-ui-slots',
    ]))
  })

  it('all dsh-* peer ranges are identical', () => {
    const ranges = new Set(dshPeers('peerDependencies').map(([, range]) => range))
    expect([...ranges]).toEqual([DECLARED_RANGE])
    // devDependencies 必须与 peer 同口径，否则仓库自身装依赖时会与发布出去的
    // 声明分叉（两处漂移过一次，故一并钉住）。
    const devRanges = new Set(dshPeers('devDependencies').map(([, range]) => range))
    expect([...devRanges]).toEqual([DECLARED_RANGE])
  })

  it('the lower bound admits the current 0.1.7 line', () => {
    expect(satisfiesRange('0.1.7-rc.1', declaredRange())).toBe(true)
    expect(satisfiesRange('0.1.7-rc.2', declaredRange())).toBe(true)
    expect(satisfiesRange('0.1.7', declaredRange())).toBe(true)
  })

  it('the upper bound really blocks the next line\'s prereleases', () => {
    expect(satisfiesRange('0.3.0-0', declaredRange())).toBe(false)
    expect(satisfiesRange('0.3.0-rc.1', declaredRange())).toBe(false)
    expect(satisfiesRange('0.3.0', declaredRange())).toBe(false)
    // 0.2.x 线仍放行（当前 DSH 线未到 0.3）。
    expect(satisfiesRange('0.2.0', declaredRange())).toBe(true)
  })

  /**
   * 回归：**当前线的预发布版本必须被放行**。
   *
   * 这条用例是为了一个真实踩过的坑：`>=0.1.7-rc.1 <0.3.0-0` 在 node-semver 下
   * **匹配不到任何 `0.2.0-rc.*`**（详见 DECLARED_RANGE 的注释），而
   * `0.2.0-rc.2` 正是 `@deepseek-ai/dsh` 的 `latest`——也就是用户实际装到的版本。
   * 旧版套件自带的简易比较器与 node-semver 判断相反，于是这条 bug 一路是绿的。
   *
   * 只对**已发布过的**版本断言，不猜未来版本号。
   */
  it('admits every published prerelease on the current line (regression)', () => {
    for (const version of ADMITTED_PRERELEASES) {
      expect(
        satisfiesRange(version, declaredRange()),
        `${version} must be admitted by ${declaredRange()}`,
      ).toBe(true)
    }
  })

  it('keeps the deliberately excluded prereleases out', () => {
    for (const version of EXCLUDED_PRERELEASES) {
      expect(
        satisfiesRange(version, declaredRange()),
        `${version} must NOT be admitted by ${declaredRange()}`,
      ).toBe(false)
    }
  })

  it('does not silently admit the line above the declared ceiling', () => {
    expect(satisfiesRange('0.3.0-rc.1', declaredRange())).toBe(false)
    expect(satisfiesRange('1.0.0-rc.1', declaredRange())).toBe(false)
  })

  it('admits the 0.2.1 line the desktop app now ships (0.2.1-rc.1)', () => {
    // 回归：`>=0.2.0-rc.1` 分支只对 `0.2.0` 元组开口，0.2.1-rc.1 会被悄悄排除。
    expect(satisfiesRange('0.2.1-rc.1', declaredRange())).toBe(true)
  })

  it('still admits the GA forms of that line', () => {
    // rc 阶段不必为 rc 扭曲声明：GA 本来就该过。
    expect(satisfiesRange('0.2.1', declaredRange())).toBe(true)
    expect(satisfiesRange('0.2.9', declaredRange())).toBe(true)
  })

  it('host gate: the package.json range covers every 0.2.x rc (includePrerelease)', () => {
    // 1.1.2 更正：宿主门禁不是标准语义。`dsh-app-boot` 的 `unmetRequirements`
    // 调 `semver.satisfies(v, range, { includePrerelease: true })`，在这个语义下
    // `>=0.2.1-rc.1 <0.3.0-0` 一支就覆盖整条 0.2.x 线。这正是 0.2.1-rc.2 宿主
    // 能直接加载 1.1.1 的原因——**不是运气**，是范围本该如此。
    const hostAdmits = (v: string): boolean =>
      semver.satisfies(v, declaredRange(), { includePrerelease: true })

    for (const version of ['0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.1', '0.2.2-rc.1', '0.2.9-rc.99']) {
      expect(hostAdmits(version), `host gate must admit ${version}`).toBe(true)
    }
  })

  it('host gate: the ceiling still bites on 0.3.x and above', () => {
    const hostAdmits = (v: string): boolean =>
      semver.satisfies(v, declaredRange(), { includePrerelease: true })
    // includePrerelease 放宽的是「预发布标签」，不是「主次版本」。
    expect(hostAdmits('0.3.0-rc.1')).toBe(false)
    expect(hostAdmits('1.0.0-rc.1')).toBe(false)
  })

  it('the two semver readings really differ — documented, not assumed', () => {
    // 把「npm 拒 / 宿主放行」这个差异钉成断言。若哪天宿主改用标准语义，
    // 这条会红，提醒我们重新评估 UNGATED_PRERELEASES 是否该升级成硬要求。
    const standard = (v: string): boolean => semver.satisfies(v, declaredRange())
    const host = (v: string): boolean =>
      semver.satisfies(v, declaredRange(), { includePrerelease: true })
    for (const version of UNGATED_PRERELEASES) {
      expect(standard(version), `${version}: npm must reject`).toBe(false)
      expect(host(version), `${version}: host gate must admit`).toBe(true)
    }
  })

  it('keeps the UNGATED prereleases out — each new rc needs a deliberate branch', () => {
    // 这不是"希望它们被拒"，而是把「semver 的预发布悬崖无法静态覆盖任意 0.2.x rc」
    // 这个已知局限变成一条可见的待办：谁放宽了范围，谁就来改这张表并说明理由。
    for (const version of UNGATED_PRERELEASES) {
      expect(
        satisfiesRange(version, declaredRange()),
        `${version} 目前没有分支覆盖（预期如此）；若要开闸请在 package.json 追加 || >=0.2.N-rc.1 <0.3.0-0 并更新 UNGATED_PRERELEASES`,
      ).toBe(false)
    }
  })
})

/**
 * pi-ai 的 peer 范围：**另一条版本线，单独守**。
 *
 * 0.2.1-rc.1 宿主把 pi-ai 从 0.85 换成了 **1.x**（`dsh-llm-pi-ai` 的 dependencies
 * 是 `^1.1.0`）。旧范围 `>=0.85.0 <0.88.0` 对 1.x **判 false**，而 1.x 恰好改了
 * 上下文契约（见 `pi-ai-runtime.ts` 的 `generationOf`）——声明错与行为错是同一个
 * 版本切换的两面，所以两条都要钉。
 *
 * 与 dsh-* 不同，pi-ai **没有**预发布悬崖：`>=1.0.0` 直接覆盖整条 1.x GA，
 * 无需逐补丁枚举。
 *
 * 这里刻意**不用** `>=1.0.0-0`：那个写法会把 `1.0.0-rc.1` 这类预发布也放进来，
 * 而 1.x 的上下文契约只在已发布的 GA 上实测过（见 `generationOf`）。实测对比：
 *   `>=1.0.0-0 <2.0.0` → 1.0.0-rc.1 **ADMIT**（不要）
 *   `>=1.0.0   <2.0.0` → 1.0.0-rc.1 reject（要这个）
 */
describe('declared pi-ai line', () => {
  it('peer and dev declare the identical range', () => {
    expect(piAiRange('devDependencies')).toBe(piAiRange('peerDependencies'))
  })

  it('admits the whole 0.85 legacy line', () => {
    for (const version of ['0.85.0', '0.85.1', '0.87.1']) {
      expect(satisfiesRange(version, piAiRange('peerDependencies')), version).toBe(true)
    }
  })

  it('admits the 1.x major the 0.2.1 host ships', () => {
    // 回归：旧范围 `<0.88.0` 把整条 1.x 判 false。宿主 0.2.1-rc.1 装的是 1.x。
    for (const version of ['1.0.0', '1.0.2', '1.1.0', '1.3.0', '1.99.0']) {
      expect(satisfiesRange(version, piAiRange('peerDependencies')), version).toBe(true)
    }
  })

  it('still blocks the next major', () => {
    for (const version of ['2.0.0', '2.0.0-rc.1', '2.1.0']) {
      expect(satisfiesRange(version, piAiRange('peerDependencies')), version).toBe(false)
    }
  })

  it('does not promise prerelease 1.x builds whose context contract is unverified', () => {
    // `generationOf` 把 `1.x.y-*` 都读作 1.x（预发布不改主次版本），但这里刻意
    // 只承诺已实测的 GA：1.1.0-beta.1 这类不给装。
    expect(satisfiesRange('1.1.0-beta.1', piAiRange('peerDependencies'))).toBe(false)
    expect(satisfiesRange('1.0.0-rc.1', piAiRange('peerDependencies'))).toBe(false)
  })

  it('keeps the 0.85 lower bound honest (0.84 has the pre-normalize bug)', () => {
    expect(satisfiesRange('0.84.0', piAiRange('peerDependencies'))).toBe(false)
    expect(satisfiesRange('0.88.0', piAiRange('peerDependencies'))).toBe(false)
  })
})
