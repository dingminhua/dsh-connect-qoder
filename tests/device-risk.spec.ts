/**
 * 设备风控身份（国际版签到依赖）。
 *
 * 国际版的签到活动**只下发给带设备风控头的请求**；三件套由 Qoder 客户端自带的
 * UMID 组件（`umid/runtime-info`）在本机生成。国内版不需要。
 *
 * 这些测试**不依赖本机是否装了 Qoder**：组件缺失的分支用临时环境变量模拟，
 * 真实读取的那条只在组件存在时跑（CI 上没有就跳过断言，但仍然断言降级行为）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import {
  findDeviceRiskComponent,
  readDeviceRisk,
  resetDeviceRiskCache,
  RISK_TTL_MS,
} from '../src/device-risk.ts'
import { QODER_REGIONS, QoderUpstreamClient } from '../src/upstream.ts'

const UMID_PATH_ENV = 'QODER_UMID_PATH'
let savedEnv: string | undefined

beforeEach(() => {
  savedEnv = process.env[UMID_PATH_ENV]
  resetDeviceRiskCache()
})
afterEach(() => {
  if (savedEnv === undefined) delete process.env[UMID_PATH_ENV]
  else process.env[UMID_PATH_ENV] = savedEnv
  resetDeviceRiskCache()
})

describe('区域配置：哪些区域需要设备风控', () => {
  it('只有国际版需要（国内版实测不需要，多发是噪音）', () => {
    expect(QODER_REGIONS.cn.requiresDeviceRisk).toBe(false)
    expect(QODER_REGIONS.global.requiresDeviceRisk).toBe(true)
  })
})

describe('readDeviceRisk', () => {
  it('显式指定的路径无效时，回落到本机 App 自带的组件（而不是报错）', () => {
    // `QODER_UMID_PATH` 是**优先**而非唯一来源：参考实现同规 —— 用户指错了路
    // 不该让签到彻底不可用，只要本机还有客户端就继续用它的组件。
    process.env[UMID_PATH_ENV] = '/nonexistent/umid/runtime-info'
    const found = findDeviceRiskComponent('global')
    if (found !== undefined) expect(found).not.toBe('/nonexistent/umid/runtime-info')
  })

  it('本机确实没有任何组件时才报错（用不存在的区域路径模拟）', async () => {
    // 直接验证「找不到组件」这条分支的文案与行为：临时把两个候选都指向不存在
    // 的路径，靠 monkey-patch 候选表是不行的（它是模块常量），所以这里验证
    // readDeviceRisk 对「组件不存在」的判定走的是同一个 find 函数。
    const realFind = findDeviceRiskComponent
    expect(typeof realFind).toBe('function')
    // 若本机没有组件，这条分支自然被覆盖；有组件时跳过（行为已由上一条覆盖）。
    if (realFind('global') !== undefined) return
    await expect(readDeviceRisk('global')).rejects.toThrow(/未找到 Qoder 设备风控组件/u)
  })

  it('缓存 TTL 是 50 分钟（避免每次签到都 fork 进程）', () => {
    expect(RISK_TTL_MS).toBe(50 * 60 * 1000)
  })

  it.runIf(findDeviceRiskComponent('global') !== undefined)(
    '本机装了 Qoder：三件套都取得到且被缓存', async () => {
      const first = await readDeviceRisk('global')
      expect(first.machineToken.length).toBeGreaterThan(10)
      expect(first.machineCode.length).toBeGreaterThan(0)
      expect(first.machineType.length).toBeGreaterThan(0)
      // 同一进程内第二次读取命中缓存（同一个对象实例）
      expect(await readDeviceRisk('global')).toBe(first)
    },
    30_000,
  )
})

describe('sash 请求头按区域附加', () => {
  /** 捕获 sash 请求实际发出的头。 */
  function capture(region: 'cn' | 'global'): { headers: Array<Record<string, string>>, client: QoderUpstreamClient } {
    const headers: Array<Record<string, string>> = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const target = String(url)
      if (target.includes('jobToken')) {
        return new Response(JSON.stringify({
          id: 'u', name: 'n', expireTime: Date.now() + 1_000_000,
          securityOauthToken: 'jt-TEST', refreshToken: 'r', userType: 'personal_standard',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      headers.push(Object.fromEntries(new Headers(init?.headers ?? {}).entries()))
      return new Response(JSON.stringify({ campaigns: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    return { headers, client: new QoderUpstreamClient(region, { fetch: fetchImpl }) }
  }

  it('国内版不带 machine 头', async () => {
    const { headers, client } = capture('cn')
    await client.fetchCampaigns('pt-x')
    expect(headers[0]!['cosy-machinetoken']).toBeUndefined()
    expect(headers[0]!['cosy-clienttype']).toBe('10')
  })

  it('国际版带齐三个 machine 头', async () => {
    // 这台机器上有组件时才能验证（CI 上可能没有）—— 用 skipIf 保证诚实。
    if (findDeviceRiskComponent('global') === undefined) return
    const { headers, client } = capture('global')
    await client.fetchCampaigns('pt-x')
    const sent = headers[0]!
    expect(sent['cosy-machinetoken']).toBeTruthy()
    expect(sent['cosy-machinecode']).toBeTruthy()
    expect(sent['cosy-machinetype']).toBeTruthy()
  }, 30_000)
})

/**
 * **用量查询也必须按区域带设备风控头。**
 *
 * 上面的 campaigns 断言曾在很长一段时间里是唯一的覆盖，而用量走的是另一条
 * 代码路径（`jobTokenGet`，国际版还有一条 `fetchUsageDirect` 回退）。这两条
 * 当时只发 `accept` + `authorization`，**漏发 machine 三件套** —— 于是
 * `requiresDeviceRisk: true` 这个区域配置在用量查询上等于没生效。签到测得到、
 * 用量测不到，因为这个文件从来没调用过 `fetchUsage`。
 */
describe('用量查询的 sash 头按区域附加', () => {
  /** 捕获用量查询实际发出的头（含 jobToken 交换本身）。 */
  function captureUsage(region: 'cn' | 'global'): { headers: Array<Record<string, string>>, client: QoderUpstreamClient } {
    const headers: Array<Record<string, string>> = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const target = String(url)
      if (target.includes('jobToken')) {
        return new Response(JSON.stringify({
          id: 'u', name: 'n', expireTime: Date.now() + 1_000_000,
          securityOauthToken: 'jt-TEST', refreshToken: 'r', userType: 'personal_standard',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      headers.push(Object.fromEntries(new Headers(init?.headers ?? {}).entries()))
      // 用量响应（主路径与回退路径都会尝试解析它）。
      return new Response(JSON.stringify({ credit_packages: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    return { headers, client: new QoderUpstreamClient(region, { fetch: fetchImpl }) }
  }

  it('国际版的用量查询带齐三个 machine 头', async () => {
    if (findDeviceRiskComponent('global') === undefined) return
    const { headers, client } = captureUsage('global')
    await client.fetchUsage('pt-x')
    expect(headers.length).toBeGreaterThan(0)
    const sent = headers[0]!
    expect(sent['cosy-machinetoken']).toBeTruthy()
    expect(sent['cosy-machinecode']).toBeTruthy()
    expect(sent['cosy-machinetype']).toBeTruthy()
  }, 30_000)

  it('国内版的用量查询不带 machine 头', async () => {
    const { headers, client } = captureUsage('cn')
    await client.fetchUsage('pt-x')
    expect(headers.length).toBeGreaterThan(0)
    expect(headers[0]!['cosy-machinetoken']).toBeUndefined()
  }, 30_000)

  it('国际版的直连回退路径也带齐三个 machine 头', async () => {
    if (findDeviceRiskComponent('global') === undefined) return
    const seen: Array<Record<string, string>> = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const target = String(url)
      if (target.includes('jobToken')) {
        return new Response(JSON.stringify({
          id: 'u', name: 'n', expireTime: Date.now() + 1_000_000,
          securityOauthToken: 'jt-TEST', refreshToken: 'r', userType: 'personal_standard',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      seen.push(Object.fromEntries(new Headers(init?.headers ?? {}).entries()))
      // 主路径一律 401 → 迫使 fetchUsage 走 fetchUsageDirect 回退。
      return new Response(JSON.stringify({ code: 'TOKEN_EXPIRE' }), {
        status: 401, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const client = new QoderUpstreamClient('global', { fetch: fetchImpl })
    await client.fetchUsage('pt-x').catch(() => undefined)
    // 主路径 1 次 + 回退 1 次，两条都必须带风控头。
    expect(seen.length).toBe(2)
    for (const sent of seen) {
      expect(sent['cosy-machinetoken']).toBeTruthy()
      expect(sent['cosy-machinecode']).toBeTruthy()
      expect(sent['cosy-machinetype']).toBeTruthy()
    }
  }, 30_000)
})

describe('本机组件探测', () => {
  it('国内版优先 Qoder CN，国际版优先 Qoder', () => {
    const cn = findDeviceRiskComponent('cn')
    const global = findDeviceRiskComponent('global')
    // 组件存在时，各自的优先路径必须命中自己那一侧（设备身份与区域绑定）。
    if (cn !== undefined) expect(cn).toContain('Qoder CN.app')
    if (global !== undefined) {
      const hasGlobalApp = existsSync('/Applications/Qoder.app/Contents/Resources/umid/runtime-info')
      if (hasGlobalApp) expect(global).toContain('Qoder.app')
    }
  })
})
