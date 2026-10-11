import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

const UPPER_BOUND = '<0.3.0-0'
const LOWER_BOUND = '>=0.1.7-rc.1'

function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (value: string): { nums: number[]; pre: (string | number)[] } => {
    const [core, ...rest] = value.split('-')
    const pre = rest.join('-')
    const nums = (core ?? '').split('.').map(part => {
      const n = Number(part)
      if (!Number.isInteger(n) || n < 0) throw new Error(`not a version core: ${JSON.stringify(value)}`)
      return n
    })
    if (nums.length !== 3) throw new Error(`not a full x.y.z version: ${JSON.stringify(value)}`)
    return {
      nums,
      pre: pre === '' ? [] : pre.split('.').map(id => (/^\d+$/.test(id) ? Number(id) : id)),
    }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    const l = left.nums[i] ?? 0
    const r = right.nums[i] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const len = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < len; i += 1) {
    const l = left.pre[i]
    const r = right.pre[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    const lNum = typeof l === 'number'
    const rNum = typeof r === 'number'
    if (lNum && rNum) return l < r ? -1 : 1
    if (lNum) return -1
    if (rNum) return 1
    return l < r ? -1 : 1
  }
  return 0
}

function dshPeers(section: 'peerDependencies' | 'devDependencies'): Array<[string, string]> {
  const deps = manifest()[section] ?? {}
  return Object.entries(deps).filter(
    ([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
  )
}

function satisfiesRange(version: string, range: string): boolean {
  const parts = range.trim().split(/\s+/)
  if (parts.length !== 2) throw new Error(`unsupported range shape: ${JSON.stringify(range)}`)
  const [lower, upper] = parts as [string, string]
  if (!lower.startsWith('>=') || !upper.startsWith('<')) {
    throw new Error(`unsupported range shape: ${JSON.stringify(range)}`)
  }
  return compareVersions(version, lower.slice(2)) >= 0 && compareVersions(version, upper.slice(1)) < 0
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
    expect([...ranges]).toEqual([LOWER_BOUND + ' ' + UPPER_BOUND])
  })

  it('the lower bound admits the current 0.1.7 line', () => {
    expect(satisfiesRange('0.1.7-rc.1', declaredRange())).toBe(true)
    expect(satisfiesRange('0.1.7', declaredRange())).toBe(true)
  })

  it('the upper bound really blocks the next line\'s prereleases', () => {
    expect(satisfiesRange('0.3.0-0', declaredRange())).toBe(false)
    expect(satisfiesRange('0.3.0-rc.1', declaredRange())).toBe(false)
    expect(satisfiesRange('0.3.0', declaredRange())).toBe(false)
    // 0.2.x 线仍放行（当前 DSH 线未到 0.3）。
    expect(satisfiesRange('0.2.0-rc.1', declaredRange())).toBe(true)
  })
})
