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
 * 为什么不在插件里缓存：组件本身每次调用都会给出当前有效值（参考实现按 50 分钟
 * 刷新）。这里按 {@link RISK_TTL_MS} 做进程内缓存，避免每次签到都 fork 一个进程。
 *
 * @module dsh-connect-qoder/device-risk
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { QoderRegion } from './upstream.ts'

const run = promisify(execFile)

/** 组件输出的大小上限：超过即视为异常输出，不解析。 */
const MAX_OUTPUT_BYTES = 1024 * 1024

/** 组件调用超时。参考实现用 25s，这里保持一致。 */
const COMPONENT_TIMEOUT_MS = 25_000

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

/** 允许用户显式指定组件路径（参考实现的 `QODER_UMID_PATH` 同规）。 */
const UMID_PATH_ENV = 'QODER_UMID_PATH'

interface Cached {
  risk: QoderDeviceRisk
  atMs: number
}

const cache: Partial<Record<QoderRegion, Cached>> = {}

/**
 * 找本机可用的 UMID 组件。
 *
 * @returns 组件绝对路径；本机没有任何一个时 undefined（调用方据此如实降级）。
 */
export function findDeviceRiskComponent(region: QoderRegion): string | undefined {
  const custom = process.env[UMID_PATH_ENV]
  if (typeof custom === 'string' && custom !== '' && existsSync(custom)) return custom
  for (const candidate of UMID_CANDIDATES[region]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
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

  const component = findDeviceRiskComponent(region)
  if (component === undefined) {
    throw new Error(
      `未找到 Qoder 设备风控组件（umid/runtime-info）。国际版签到需要它：`
      + `请安装 Qoder 客户端，或用 ${UMID_PATH_ENV} 指定组件路径`,
    )
  }

  let stdout: string
  try {
    const result = await run(component, [], { timeout: COMPONENT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES })
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
