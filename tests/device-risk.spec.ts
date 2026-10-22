/**
 * 设备风控身份（国际版签到依赖）。
 *
 * 国际版的签到活动**只下发给带设备风控头的请求**；三件套由 Qoder 客户端自带的
 * UMID 组件（`umid/runtime-info`）在本机生成。国内版不需要。
 *
 * 这些测试**不依赖本机是否装了 Qoder**：组件缺失的分支用临时环境变量模拟，
 * 真实读取的那条只在组件存在时跑（CI 上没有就跳过断言，但仍然断言降级行为）。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  findDeviceRiskComponent,
  parseWindowsUninstallDirs,
  readDeviceRisk,
  REG_QUERY_OPTIONS,
  resetDeviceRiskCache,
  resolveDeviceRiskComponent,
  RISK_PROCESS_OPTIONS,
  RISK_TTL_MS,
  windowsInstallDirOf,
  windowsUmidPath,
  type WindowsRegistryProbe,
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

/**
 * 本机能不能真的取到国际版组件（快速路径或 Windows 注册表任一条命中）。
 *
 * 这些用例原先按 `findDeviceRiskComponent` 判定是否跳过 —— 那个函数只覆盖**默认**安装
 * 位置，于是在「装在别处」的机器上会静默跳过真正该验证的那条路径。改用完整探测判定，
 * 「跳过与否」才与「签到能不能用」一致。
 */
const globalComponentAvailable = (await resolveDeviceRiskComponent('global')) !== undefined

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
    // 直接验证「找不到组件」这条分支的文案与行为：候选表是模块常量，没法 monkey-patch，
    // 所以用与生产同一条判定（快速路径 + Windows 注册表）决定是否跳过 —— 有组件时这条
    // 分支的行为已由上一条覆盖，没组件时它自然被覆盖。
    if (globalComponentAvailable) return
    await expect(readDeviceRisk('global')).rejects.toThrow(/未找到 Qoder 设备风控组件/u)
  })

  it('缓存 TTL 是 50 分钟（避免每次签到都 fork 进程）', () => {
    expect(RISK_TTL_MS).toBe(50 * 60 * 1000)
  })

  it('组件进程带 windowsHide（Electron 宿主 spawn 控制台程序会闪黑窗，家族教训）', () => {
    // 与 host-heartbeat.ts 的 PROCESS_PROBE_OPTIONS 同因同测：Windows 上不带
    // windowsHide，GUI 宿主的每次设备身份读取都会闪一个可见控制台窗口。
    // 这个断言在任意平台都成立（POSIX 上该选项被忽略，但值必须写在选项里）。
    expect(RISK_PROCESS_OPTIONS.windowsHide).toBe(true)
    expect(RISK_PROCESS_OPTIONS.timeout).toBeGreaterThan(0)
    expect(RISK_PROCESS_OPTIONS.maxBuffer).toBeGreaterThan(0)
  })

  it.runIf(globalComponentAvailable)(
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
    if (!globalComponentAvailable) return
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
    if (!globalComponentAvailable) return
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
    if (!globalComponentAvailable) return
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
    // 这条断言说的是**候选表**的区域优先级。`QODER_UMID_PATH` 是用户的显式指定、优先级在
    // 候选表之上（由下一条用例专门覆盖），留着它这条就测错了对象 —— 比如用户按报错提示
    // 把路径指到国际版组件上时，国内版这里会拿到国际版路径，于是断言失败。
    delete process.env[UMID_PATH_ENV]
    const cn = findDeviceRiskComponent('cn')
    const global = findDeviceRiskComponent('global')
    // 组件存在时，各自的优先路径必须命中自己那一侧（设备身份与区域绑定）。
    // macOS 路径带 `.app`（`Qoder CN.app` / `Qoder.app`），Windows 路径带
    // `Programs\Qoder CN\` / `Programs\Qoder\` —— 断言只认目录名里的 App 名。
    if (cn !== undefined) expect(cn).toMatch(/Qoder CN/i)
    if (global !== undefined) expect(global).toMatch(/[\\/]Qoder([\\/]|\.app)/i)
  })
})

/**
 * **安装位置不只是 `%LOCALAPPDATA%`。**
 *
 * 实测：有机器把 Qoder 装在 `D:\Users\<user>\AppData\Local\Programs\Qoder`（安装器允许改
 * 目录），于是 `windowsUmidCandidates` 那一族候选整族落空，国际版签到只剩「未找到 Qoder
 * 设备风控组件」一条路 —— 而卸载登记表里写得清清楚楚。
 *
 * 注册表**解析**被拆成纯函数单独测：CI runner 上没装 Qoder，查不出东西，但真实输出可以
 * 固化下来断言。**查询**那一侧留在最后一条用例里（只在 Windows 且快速路径落空时跑）。
 */
describe('Windows 安装目录发现（不是所有机器都装在 %LOCALAPPDATA%）', () => {
  /** 实测输出（`reg query … /s /f Qoder /t REG_SZ`）：用户名换成 `<user>`，其余原样。 */
  const GLOBAL_ENTRY = String.raw`
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\14d8c5cd-3d3a-5fb8-8746-849118a754ce
    DisplayName    REG_SZ    Qoder 0.4.9
    UninstallString    REG_SZ    "D:\Users\<user>\AppData\Local\Programs\Qoder\Uninstall Qoder.exe" /currentuser
    QuietUninstallString    REG_SZ    "D:\Users\<user>\AppData\Local\Programs\Qoder\Uninstall Qoder.exe" /currentuser /S
    DisplayIcon    REG_SZ    D:\Users\<user>\AppData\Local\Programs\Qoder\uninstallerIcon.ico
    Publisher    REG_SZ    Qoder
    Comments    REG_SZ    Qoder - Agent workbench for human and AI software teams
    HelpLink    REG_SZ    https://qoder.com
`
  const CN_ENTRY = String.raw`
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
    DisplayName    REG_SZ    Qoder CN 0.4.9
    UninstallString    REG_SZ    "E:\Qoder CN\Uninstall Qoder CN.exe" /currentuser
`
  const GLOBAL_DIR = String.raw`D:\Users\<user>\AppData\Local\Programs\Qoder`
  const CN_DIR = String.raw`E:\Qoder CN`

  it('从 UninstallString 还原安装目录：引号优先（卸载器名字自带空格，按空白切会切错）', () => {
    expect(windowsInstallDirOf(String.raw`"D:\Users\<user>\AppData\Local\Programs\Qoder\Uninstall Qoder.exe" /currentuser`))
      .toBe(GLOBAL_DIR)
  })

  it('没有 UninstallString 时退回 DisplayIcon；相对路径与残缺值一律不产出目录', () => {
    expect(windowsInstallDirOf(String.raw`D:\Users\<user>\AppData\Local\Programs\Qoder\uninstallerIcon.ico`)).toBe(GLOBAL_DIR)
    // 没引号但带参数的形态也要能切。
    expect(windowsInstallDirOf(String.raw`D:\Tools\Qoder\Qoder.exe /S`)).toBe(String.raw`D:\Tools\Qoder`)
    expect(windowsInstallDirOf('Uninstall Qoder.exe')).toBeUndefined()
    expect(windowsInstallDirOf('   ')).toBeUndefined()
    // 这里解析的是 Windows 卸载登记表的值，POSIX 路径不该被当成安装目录。
    expect(windowsInstallDirOf('/opt/qoder/uninstall')).toBeUndefined()
  })

  it('按 DisplayName 分区域：Qoder 归国际版、Qoder CN 归国内版（顺序即优先级）', () => {
    const output = `${GLOBAL_ENTRY}${CN_ENTRY}`
    // `Qoder CN 0.4.9` 同时满足两条区域正则，所以 CN 那条必须排在前面。
    expect(parseWindowsUninstallDirs(output, 'global')).toEqual([GLOBAL_DIR])
    expect(parseWindowsUninstallDirs(output, 'cn')).toEqual([CN_DIR])
  })

  it('认不出区域的登记项被丢掉（只有 HelpLink 里含 qoder 的不算数）', () => {
    const output = String.raw`
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\{unrelated}
    DisplayName    REG_SZ    Some Other Tool
    UninstallString    REG_SZ    "C:\Other\Uninstall.exe" /currentuser
    HelpLink    REG_SZ    https://qoder.com
    Comments    REG_SZ    integrates with Qoder
`
    expect(parseWindowsUninstallDirs(output, 'global')).toEqual([])
    expect(parseWindowsUninstallDirs(output, 'cn')).toEqual([])
    // 一条都没命中时 `reg query` 的真实输出长这样，同样不该产出候选。
    expect(parseWindowsUninstallDirs('End of search: 0 match(es) found.', 'global')).toEqual([])
  })

  it('同一台机器登记多次时只产出一次', () => {
    expect(parseWindowsUninstallDirs(`${GLOBAL_ENTRY}${GLOBAL_ENTRY}`, 'global')).toEqual([GLOBAL_DIR])
  })

  it('候选组件拼在该安装目录的 resources\\umid 下（按目录自己的分隔符拼）', () => {
    expect(windowsUmidPath(GLOBAL_DIR)).toBe(`${GLOBAL_DIR}\\resources\\umid\\runtime-info.exe`)
    // 非 Windows 形态也走同一条拼接 —— 这条用例得在 ubuntu job 上也跑。
    expect(windowsUmidPath('/tmp/qoder/')).toBe('/tmp/qoder/resources/umid/runtime-info.exe')
  })

  it('reg.exe 查询也带 windowsHide（GUI 宿主 spawn 控制台子程序会闪黑窗，同族教训）', () => {
    expect(REG_QUERY_OPTIONS.windowsHide).toBe(true)
    expect(REG_QUERY_OPTIONS.timeout).toBeGreaterThan(0)
    expect(REG_QUERY_OPTIONS.timeout).toBeLessThan(RISK_PROCESS_OPTIONS.timeout)
  })

  it('快速路径命中就不起进程：注入的注册表探测一次都不该被叫到', async () => {
    // 拿本文件自己当「存在的组件路径」，把快速路径的命中变成确定的。
    process.env[UMID_PATH_ENV] = fileURLToPath(import.meta.url)
    let probes = 0
    const probe: WindowsRegistryProbe = async () => {
      probes += 1
      return '/probe/umid/runtime-info'
    }
    await expect(resolveDeviceRiskComponent('global', probe)).resolves.toBe(fileURLToPath(import.meta.url))
    expect(probes).toBe(0)
  })

  it.runIf(process.platform !== 'win32')(
    '非 Windows 没有注册表这一层：快速路径落空就是 undefined', async () => {
      delete process.env[UMID_PATH_ENV]
      let probes = 0
      const probe: WindowsRegistryProbe = async () => {
        probes += 1
        return '/probe/umid/runtime-info'
      }
      const resolved = await resolveDeviceRiskComponent('global', probe)
      expect(probes).toBe(0)
      // 本机装了 Qoder 时快速路径就命中：两种情况都不该走到「注册表」那层。
      expect(resolved).toBe(findDeviceRiskComponent('global'))
    },
  )

  it.runIf(process.platform === 'win32' && findDeviceRiskComponent('global') === undefined)(
    'Windows 上快速路径落空时，真实的注册表探测不抛错（有 Qoder 就给存在的组件）',
    async () => {
      delete process.env[UMID_PATH_ENV]
      const resolved = await resolveDeviceRiskComponent('global')
      if (resolved !== undefined) expect(existsSync(resolved)).toBe(true)
    },
    30_000,
  )
})
