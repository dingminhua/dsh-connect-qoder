/**
 * 设备风控身份（国际版签到依赖）。
 *
 * 背景：国际版的每日签到活动**只下发给带设备风控头的请求**
 * （`Cosy-MachineToken` / `Cosy-MachineCode` / `Cosy-MachineType`）。国内版不需要。
 * 这三件套由 Qoder 客户端自带的 UMID 组件（`runtime-info`）在本机生成 —— 它不是
 * 随机数，而是与这台机器绑定的标识，所以**不能**由插件伪造或缓存到别的机器。
 *
 * 来源：社区参考实现 L0NE-6/Qoder-Daily（MIT）的做法是先在 Qoder 客户端资源目录里
 * 找 `umid/runtime-info`，找不到才去官方 qodercli 包里提取。本插件只做前者：本机装了
 * Qoder 就有，没装就如实报「取不到」，不去下载任何东西。
 *
 * 组件位置按两层探测：静态候选表（macOS App 内、Windows 默认安装位置）先走，没命中
 * 再向 Windows 卸载登记表问「Qoder 装在哪儿」—— 安装器允许改目录，默认位置不是唯一
 * 位置，详见 {@link resolveDeviceRiskComponent}。
 *
 * 为什么不在插件里缓存：组件本身每次调用都会给出当前有效值（参考实现按 50 分钟
 * 刷新）。这里按 {@link RISK_TTL_MS} 做进程内缓存，避免每次签到都 fork 一个进程。
 *
 * @module dsh-connect-qoder/device-risk
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { QoderRegion } from './upstream.ts'

const run = promisify(execFile)

/** 组件输出的大小上限：超过即视为异常输出，不解析。 */
const MAX_OUTPUT_BYTES = 1024 * 1024

/** 组件调用超时。参考实现用 25s，这里保持一致。 */
const COMPONENT_TIMEOUT_MS = 25_000

/**
 * 组件进程的 spawn 选项。
 *
 * `windowsHide` 与 `host-heartbeat.ts` 的 `PROCESS_PROBE_OPTIONS` 同因（家族
 * 教训，见其注释）：DSH Desktop 宿主是 Electron GUI 进程（无 console），
 * Windows 会给这种父进程的控制台子程序**新建一个可见窗口** —— 每次读设备
 * 身份都会闪一个黑框。POSIX 上该选项被忽略。
 */
export const RISK_PROCESS_OPTIONS = {
  timeout: COMPONENT_TIMEOUT_MS,
  maxBuffer: MAX_OUTPUT_BYTES,
  windowsHide: true,
} as const

/**
 * 进程内缓存的存活时间。
 *
 * 参考实现按 50 分钟刷新一次设备身份（`RISK_TTL`）；这里取同样的量级，既避免每次
 * 签到都 fork 进程，又保证值不会陈旧到被风控判为失效。
 */
export const RISK_TTL_MS = 50 * 60 * 1000

/** 三件套 + 它们该以什么请求头发出。 */
export interface QoderDeviceRisk {
  machineToken: string
  machineCode: string
  machineType: string
}

/**
 * 每个区域的 UMID 组件搜索路径，按优先级排列。
 *
 * 区域与 App 的对应关系沿用参考实现：国际版优先 `Qoder`，国内版优先 `Qoder CN`。
 * 两个 App 都装时，各自优先自己那个 —— 设备身份与区域是绑定的，用错一侧的组件
 * 会被风控拒绝。
 *
 * 这里是 **macOS** 的安装位置；Windows 的安装位置（`%LOCALAPPDATA%\Programs\…`）
 * 由 {@link windowsUmidCandidates} 动态展开后**追加**在 macOS 候选之后 —— Windows
 * 上没有 `/Applications` 目录，不追加的话 find 永远落空，国际版积分/签到就会
 * 因为「取不到设备身份」而读不到。
 *
 * 这张表只认**默认**安装位置；装在别处的由 {@link resolveDeviceRiskComponent}
 * 追加查卸载登记表，见其注释。
 */
const UMID_CANDIDATES: Readonly<Record<QoderRegion, readonly string[]>> = {
  cn: [
    '/Applications/Qoder CN.app/Contents/Resources/umid/runtime-info',
    '/Applications/Qoder.app/Contents/Resources/umid/runtime-info',
  ],
  global: [
    '/Applications/Qoder.app/Contents/Resources/umid/runtime-info',
    '/Applications/Qoder CN.app/Contents/Resources/umid/runtime-info',
  ],
}

/**
 * 某个 Qoder 安装目录下的 UMID 组件路径。
 *
 * 手写拼接而不是复用 `node:path` 的 `join`：注册表里的安装目录是 **Windows** 路径
 * （`D:\…\Qoder`），而本模块的用例跑在 ubuntu 与 windows 两个 CI job 上 —— POSIX 的
 * `join` 会把 `D:\…\Qoder` 当成一个普通文件名，拼出 `D:\…\Qoder/resources/umid/…`
 * 这种半截路径，于是「解析出来的候选」本身就没法跨平台断言。这里按目录里实际出现的
 * 分隔符拼接，把「解析」与「宿主平台」解耦。
 */
export function windowsUmidPath(installDir: string): string {
  const trimmed = installDir.replace(/[\\/]+$/u, '')
  const separator = trimmed.includes('\\') ? '\\' : '/'
  return [trimmed, 'resources', 'umid', 'runtime-info.exe'].join(separator)
}

/**
 * Windows 上 Qoder 客户端的 UMID 组件位置（`%LOCALAPPDATA%\Programs\<App>\resources\
 * umid\runtime-info.exe`），区域 → App 的优先级与 macOS 候选一致。
 *
 * `%LOCALAPPDATA%` 可能未定义（无窗口会话 / CI），此时返回空数组 —— 调用方照常
 * 走「macOS 候选 + 环境变量」的既有路径，不报错。
 *
 * 这里展开的是**默认**安装位置。安装器允许改目录，改过之后这条路径整族落空 ——
 * 那种机器由 {@link findInWindowsUninstallRegistry} 兜底：向系统问「Qoder 装在哪」，
 * 而不是假定它装在哪。
 */
function windowsUmidCandidates(region: QoderRegion): string[] {
  const local = process.env.LOCALAPPDATA
  if (!local) return []
  const pathOf = (app: string): string => windowsUmidPath(join(local, 'Programs', app))
  return region === 'cn'
    ? [pathOf('Qoder CN'), pathOf('Qoder')]
    : [pathOf('Qoder'), pathOf('Qoder CN')]
}

/** 允许用户显式指定组件路径（参考实现的 `QODER_UMID_PATH` 同规）。 */
const UMID_PATH_ENV = 'QODER_UMID_PATH'

interface Cached {
  risk: QoderDeviceRisk
  atMs: number
}

const cache: Partial<Record<QoderRegion, Cached>> = {}

/**
 * 找本机可用的 UMID 组件 —— **同步快速路径**（不起任何进程）。
 *
 * 覆盖：显式指定的路径、macOS App 内的组件、Windows 的**默认**安装位置。Windows 上装在
 * 别处的情况不在这里 —— 那要起一个 `reg.exe` 去问卸载登记表，代价与这里不同类，所以
 * 单独放在 {@link resolveDeviceRiskComponent} 里。要「找得到就一定能用」的调用方调那个；
 * 这个函数只回答「不用起进程就能确定的那部分」。
 *
 * @returns 组件绝对路径；快速路径没命中时 undefined（**不代表本机没有**）。
 */
export function findDeviceRiskComponent(region: QoderRegion): string | undefined {
  const custom = process.env[UMID_PATH_ENV]
  if (typeof custom === 'string' && custom !== '' && existsSync(custom)) return custom
  for (const candidate of [...UMID_CANDIDATES[region], ...windowsUmidCandidates(region)]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Windows 卸载登记表的三个根，按查询优先级排列：当前用户 → 本机 64 位 → 本机 32 位。
 *
 * Qoder 的安装器是 per-user 安装（`UninstallString` 结尾带 `/currentuser`），实测登记项落在
 * HKCU —— 所以它排第一，命中即停，省掉后面两次查询。后两个根是给「装给所有用户」的形态
 * 留的，不是摆设。
 */
const WINDOWS_UNINSTALL_ROOTS: readonly string[] = [
  String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`,
  String.raw`HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall`,
  String.raw`HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
]

/**
 * 卸载登记表里 Qoder 系产品的 `DisplayName` → 区域。
 *
 * **顺序即优先级**：`Qoder CN 0.4.9` 同时满足下面两条（`^Qoder\b` 在空格处也算词边界），
 * 所以 CN 必须排在前面 —— 设备身份与区域绑定，把国内版认成国际版会被风控拒绝。
 *
 * 认不出区域的一律**跳过**（而不是猜一侧）：没有 DisplayName、或名字不叫 Qoder 系产品时，
 * 宁可当作「这一条没给出东西」。
 */
const WINDOWS_DISPLAY_NAME_REGIONS: ReadonlyArray<readonly [RegExp, QoderRegion]> = [
  [/^Qoder\s*CN\b/iu, 'cn'],
  [/^Qoder\b/iu, 'global'],
]

/** `reg query` 输出里的一行值：`    DisplayName    REG_SZ    Qoder 0.4.9`。 */
const REG_VALUE_LINE = /^\s+(.+?)\s+REG_SZ\s+(.*)$/u

/**
 * `reg.exe` 查询的 spawn 选项。
 *
 * `windowsHide` 与 {@link RISK_PROCESS_OPTIONS} 同因（见其注释：GUI 宿主 spawn 控制台子程序
 * 会闪黑窗）；超时取得比组件本身短 —— 读注册表是本地操作，25s 是给组件留的余量，不该照抄。
 */
export const REG_QUERY_OPTIONS = {
  timeout: 10_000,
  maxBuffer: MAX_OUTPUT_BYTES,
  windowsHide: true,
} as const

/**
 * 从卸载登记表的值里还原出**安装目录**。
 *
 * 三种实测形态都要认：
 *
 * - `"D:\…\Qoder\Uninstall Qoder.exe" /currentuser` —— 带引号且尾巴上有参数（Qoder 的
 *   `UninstallString` 就是这种）。**必须先看引号**：卸载器名字里自带空格
 *   （`Uninstall Qoder.exe`），按空白切会切在名字中间。
 * - `D:\…\Qoder\uninstallerIcon.ico` —— `DisplayIcon` 那种裸路径。
 * - `D:\…\Qoder.exe /S` —— 没引号但带参数，截到 `.exe` 为止。
 *
 * 只认「盘符 + 分隔符」或 UNC 开头的绝对路径：相对路径与残缺值不该变成候选，否则
 * `existsSync` 会在当前工作目录下瞎撞，把「没找到」伪装成「找到了」。
 */
export function windowsInstallDirOf(value: string): string | undefined {
  const text = value.trim()
  if (text === '') return undefined
  const quoted = /^"(?<path>[^"]+)"/u.exec(text)?.groups?.path
  const executable = /^.+?\.exe\b/iu.exec(text)?.[0]
  const file = (quoted ?? executable ?? text).trim()
  const cut = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'))
  if (cut <= 0) return undefined
  const dir = file.slice(0, cut)
  return /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(dir) ? dir : undefined
}

/**
 * 把 `reg query … /s /f Qoder /t REG_SZ` 的输出解析成**该区域**的安装目录，按登记顺序。
 *
 * 纯函数：不碰注册表、不碰文件系统。查询那一侧在 CI 上没东西可查（runner 上没装 Qoder），
 * 只有把「解析」与「查询」分开，才能把真实输出固化成用例 —— 而这个 bug 的本质，恰恰是
 * 解析侧漏掉了一种安装位置，不是查询侧拿不到数据。
 */
export function parseWindowsUninstallDirs(output: string, region: QoderRegion): string[] {
  const dirs: string[] = []
  let displayName = ''
  let uninstallString = ''
  let displayIcon = ''

  /** 结算一条登记项：名字认得出区域、且能取出安装目录时才算数。 */
  const settle = (): void => {
    const matched = WINDOWS_DISPLAY_NAME_REGIONS.find(([pattern]) => pattern.test(displayName))
    if (matched?.[1] === region) {
      const dir = windowsInstallDirOf(uninstallString) ?? windowsInstallDirOf(displayIcon)
      if (dir !== undefined && !dirs.includes(dir)) dirs.push(dir)
    }
    displayName = ''
    uninstallString = ''
    displayIcon = ''
  }

  for (const line of output.split(/\r?\n/u)) {
    // 登记项的头行不缩进（`HKEY_…`），值行缩进 —— 见头行即结算上一条。
    if (line.startsWith('HKEY_')) {
      settle()
      continue
    }
    const value = REG_VALUE_LINE.exec(line)
    if (value === null) continue
    const name = value[1]!.trim().toLowerCase()
    if (name === 'displayname') displayName = value[2]!.trim()
    else if (name === 'uninstallstring') uninstallString = value[2]!.trim()
    else if (name === 'displayicon') displayIcon = value[2]!.trim()
  }
  settle()
  return dirs
}

/**
 * `reg.exe` 的绝对路径。
 *
 * 不靠 PATH：宿主是 Electron GUI 进程，PATH 来自用户环境（被裁剪过的环境里 `reg.exe` 找不到）。
 * `%SystemRoot%\System32\reg.exe` 在任何 Windows 上都存在；`%SystemRoot%` 缺失这种极端情况
 * 退回裸名字，由 PATH 兜底。
 */
function windowsRegExe(): string {
  const root = process.env.SystemRoot
  return root === undefined || root === '' ? 'reg.exe' : join(root, 'System32', 'reg.exe')
}

/**
 * 向 Windows 卸载登记表问「Qoder 装在哪儿」，返回该区域**确实存在**的组件路径。
 *
 * 为什么需要它：`%LOCALAPPDATA%\Programs\<App>` 只是默认值，安装器允许改目录 —— 实测一台
 * 机器上 Qoder 装在 `D:\Users\<user>\AppData\Local\Programs\Qoder`，登记表里写得清清楚楚，
 * 而候选表整族落空，于是国际版签到只剩「未找到设备风控组件」一条路。
 *
 * 三个根依次查、命中即停。任何一步失败（`reg.exe` 不在、项读不到、超时、没有匹配项）都
 * **静默跳过**：找不到组件时该由调用方给出那条统一、可操作的报错；在这里抛只会把
 * 「不知道装在哪」和「读不出来」混成同一句话。
 */
async function findInWindowsUninstallRegistry(region: QoderRegion): Promise<string | undefined> {
  for (const root of WINDOWS_UNINSTALL_ROOTS) {
    let stdout: string
    try {
      // `/f Qoder` 按「值名 + 值数据」过滤，所以输出里会混进 HelpLink / URLInfoAbout 这类
      // 只是数据里含 qoder 的条目；区域判定只认 DisplayName，其余自然被丢掉。
      // `/t REG_SZ` 则把 DWORD 那些（NoModify / EstimatedSize）挡在外面。
      const result = await run(windowsRegExe(), ['query', root, '/s', '/f', 'Qoder', '/t', 'REG_SZ'], REG_QUERY_OPTIONS)
      stdout = result.stdout
    } catch {
      // 没有匹配项时 `reg query` 以 1 退出（promisify 当异常抛）—— 与「查询本身失败」在处置上
      // 一致：这一根没给出东西，继续下一根。
      continue
    }
    for (const dir of parseWindowsUninstallDirs(stdout, region)) {
      const candidate = windowsUmidPath(dir)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** 注册表探测的可替换实现（与 `QoderUpstreamClient` 注入 `fetch` 同因：让这条链路可测）。 */
export type WindowsRegistryProbe = (region: QoderRegion) => Promise<string | undefined>

/**
 * 找本机可用的 UMID 组件 —— **完整探测**。
 *
 * 分两层是因为代价不同类：{@link findDeviceRiskComponent} 是几次 `existsSync`（同步、不起进程），
 * 注册表那层要起一个 `reg.exe`。第一层命中就不付第二层的钱；第一层落空、且确实在 Windows 上
 * 时，才去问系统 Qoder 装在哪儿。
 *
 * 非 Windows 不查注册表：macOS 那边安装位置就是固定的 `/Applications`，第一层已经覆盖完了。
 *
 * @returns 组件绝对路径；两层都没有时 undefined（调用方据此如实降级）。
 */
export async function resolveDeviceRiskComponent(
  region: QoderRegion,
  probeRegistry: WindowsRegistryProbe = findInWindowsUninstallRegistry,
): Promise<string | undefined> {
  const found = findDeviceRiskComponent(region)
  if (found !== undefined) return found
  if (process.platform !== 'win32') return undefined
  return probeRegistry(region)
}

/**
 * 读取设备风控身份。
 *
 * 组件把 JSON 打在第一行 stdout。任何一步不符合预期（找不到组件、超时、输出不是
 * JSON、字段缺失或过长）都**抛错**而不是返回半个对象 —— 半个身份发上去只会被风控
 * 当成伪造，反而更难诊断。
 *
 * 结果按 {@link RISK_TTL_MS} 在进程内缓存。
 */
export async function readDeviceRisk(region: QoderRegion, nowMs = Date.now()): Promise<QoderDeviceRisk> {
  const hit = cache[region]
  if (hit !== undefined && nowMs - hit.atMs < RISK_TTL_MS) return hit.risk

  const component = await resolveDeviceRiskComponent(region)
  if (component === undefined) {
    throw new Error(
      `未找到 Qoder 设备风控组件（umid/runtime-info）。国际版签到需要它：`
      + `请安装 Qoder 客户端，或用 ${UMID_PATH_ENV} 指定组件路径`,
    )
  }

  let stdout: string
  try {
    const result = await run(component, [], RISK_PROCESS_OPTIONS)
    stdout = result.stdout
  } catch (error: unknown) {
    throw new Error(`设备风控组件执行失败: ${String((error as Error)?.message ?? error)}`)
  }

  const firstLine = stdout.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
  let parsed: unknown
  try {
    parsed = JSON.parse(firstLine)
  } catch {
    throw new Error(`设备风控组件输出不是 JSON: ${firstLine.slice(0, 120)}`)
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('设备风控组件输出不是对象')
  }

  const record = parsed as Record<string, unknown>
  const pick = (key: string): string => {
    const value = record[key]
    if (typeof value !== 'string' || value.trim() === '' || value.length > 4096) {
      throw new Error(`设备风控组件输出缺少 ${key}`)
    }
    return value.trim()
  }

  const risk: QoderDeviceRisk = {
    machineToken: pick('machineToken'),
    machineCode: pick('machineCode'),
    machineType: pick('machineType'),
  }
  cache[region] = { risk, atMs: nowMs }
  return risk
}

/** 仅供测试：清空缓存。 */
export function resetDeviceRiskCache(): void {
  for (const region of Object.keys(cache) as QoderRegion[]) delete cache[region]
}
