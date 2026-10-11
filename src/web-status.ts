/**
 * Host 端浏览器路由：状态 / 目录刷新 / 用量 / 探针。
 *
 * 路由形态沿用 dsh-connect-workbuddy 的 `web-status.ts`：`ctx.webServer
 * .register({kind:'exact', path, handler})` + loopback Origin 校验 +
 * json 响应。《浏览器设置镜像》只读；写路径（PAT / 开关 / 勾选）一律走
 * 宿主 settings 服务，不经这些路由。
 *
 * @module dsh-connect-qoder/web-status
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  QODER_PROBE_PATH,
  QODER_MODELS_REFRESH_PATH,
  QODER_STATUS_PATH,
  QODER_USAGE_PATH,
  QODER_REGION_KEYS,
  type QoderStatusRegion,
  type QoderStatusModel,
  type QoderStatusUsage,
} from './status-paths.ts'
import type { QoderRegion } from './upstream.ts'
import type { QoderUsage } from './upstream.ts'
import type { QoderModelInfo } from './catalog.ts'

export interface QoderStatusRouteOptions {
  /** 每区域是否启用（config）与凭据是否配置。 */
  regionEnabled: (region: QoderRegion) => boolean
  hasCredential: (region: QoderRegion) => boolean
  catalogs: Record<QoderRegion, { current(): QoderModelInfo[] }>
  probes: Record<QoderRegion, { probe(modelId: string): Promise<ProbeResult> }>
  /** 最近一次用量（按区域缓存，含时间戳）。 */
  usage: (region: QoderRegion) => { usage: QoderUsage | undefined; atMs: number } | undefined
  /** 触发某区域目录刷新（异步，不等待）。 */
  refreshModels: (region: QoderRegion) => void
  logger: (message: string) => void
}

export interface ProbeResult {
  ok: boolean
  kind: string
  message: string
  latencyMs: number
  inputTokens: number | null
  outputTokens: number | null
}

function regionOfPath(url: string): QoderRegion | undefined {
  const m = /region=(cn|global)/.exec(url)
  if (m?.[1] !== 'cn' && m?.[1] !== 'global') return undefined
  return m[1]
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(text)
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function loopbackOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  return /^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || /^http:\/\/localhost:\d+$/.test(origin)
}

function statusModelOf(m: QoderModelInfo): QoderStatusModel {
  return {
    key: m.key,
    displayName: m.displayName,
    priceFactor: m.priceFactor,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    supportsImages: m.supportsImages,
    supportsThinking: m.supportsThinking,
    isDefault: m.isDefault,
    isFree: m.isFree,
  }
}

/** 组装一区域的浏览器快照。 */
export async function qoderRegionStatus(deps: QoderStatusRouteOptions, region: QoderRegion): Promise<QoderStatusRegion> {
  const models = deps.catalogs[region].current()
  const usageEntry = deps.usage(region)
  return {
    enabled: deps.regionEnabled(region),
    hasCredential: deps.hasCredential(region),
    upstreamReachable: models.length > 0,
    accountName: null,
    accountId: null,
    usageError: null,
    models: models.map(statusModelOf),
    modelCount: models.length,
    usage: usageEntry?.usage ? statusUsageOf(usageEntry.usage) : null,
    usageAtMs: usageEntry?.atMs ?? null,
    checkedInToday: null,
  }
}

function statusUsageOf(usage: QoderUsage): QoderStatusUsage {
  const bucket = (v: QoderUsage['userQuota'] | QoderUsage['addOnQuota']) => v
    ? { total: v.total ?? 0, used: v.used ?? 0, remaining: v.remaining ?? 0, percentage: v.percentage ?? 0 }
    : null
  return {
    userType: usage.userType ?? null,
    expiresAt: usage.expiresAt ?? null,
    upgradeUrl: usage.upgradeUrl ?? null,
    userQuota: bucket(usage.userQuota),
    addOnQuota: bucket(usage.addOnQuota),
    orgResourcePackage: usage.orgResourcePackage
      ? { used: usage.orgResourcePackage.used ?? 0, cap: usage.orgResourcePackage.cap ?? 0, remaining: usage.orgResourcePackage.remaining ?? 0, percentage: usage.orgResourcePackage.percentage ?? 0, available: usage.orgResourcePackage.available ?? false }
      : null,
  }
}

export function regionEnabledOf(config: unknown, region: QoderRegion): boolean {
  const regions = (config as { regions?: Record<string, { enabled?: boolean }> | null } | undefined)?.regions
  return regions?.[region]?.enabled !== false
}

export function regionHasCredential(config: unknown, region: QoderRegion): boolean {
  const regions = (config as { regions?: Record<string, { pat?: unknown }> | null } | undefined)?.regions
  const pat = typeof regions?.[region]?.pat === 'string' ? regions[region]!.pat as string : ''
  return pat.trim() !== ''
}

/**
 * 挂载只读路由。调用方应用 `ctx.inject(['webServer'], ...)` 包裹，使
 * Desktop 启动顺序不会让注册消失。
 */
export function registerQoderStatusRoute(ctx: Context, deps: QoderStatusRouteOptions): void {
  ctx.effect(() => {
    const disposers: Array<() => void> = []

    const mount = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): void => {
      try {
        disposers.push(ctx.webServer.register({
          kind: 'exact' as const,
          path,
          handler: async (req: IncomingMessage, res: ServerResponse) => {
            if (!loopbackOrigin(req)) {
              json(res, 403, { error: 'origin-not-trusted' })
              return
            }
            try {
              await handler(req, res)
            } catch (error: unknown) {
              json(res, 500, { error: safeMessage(error) })
            }
          },
        }))
      } catch (error: unknown) {
        deps.logger(`route ${path} failed to register: ${safeMessage(error)}`)
      }
    }

    mount(QODER_STATUS_PATH, async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      const region = regionOfPath(req.url ?? '')
      if (region === undefined) {
        const all: Record<string, QoderStatusRegion> = {}
        for (const r of QODER_REGION_KEYS) all[r] = await qoderRegionStatus(deps, r)
        return json(res, 200, { regions: all })
      }
      return json(res, 200, await qoderRegionStatus(deps, region))
    })

    mount(QODER_MODELS_REFRESH_PATH, async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      const region = regionOfPath(req.url ?? '')
      if (region === undefined) return json(res, 400, { error: 'unknown region' })
      deps.refreshModels(region)
      return json(res, 202, { accepted: true })
    })

    mount(QODER_USAGE_PATH, async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      const region = regionOfPath(req.url ?? '')
      if (region === undefined) return json(res, 400, { error: 'unknown region' })
      const entry = deps.usage(region)
      if (entry === undefined || entry.usage === undefined) {
        return json(res, 200, { usage: null, atMs: null })
      }
      return json(res, 200, { usage: statusUsageOf(entry.usage), atMs: entry.atMs })
    })

    mount(QODER_PROBE_PATH, async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      const url = new URL(req.url ?? '', 'http://127.0.0.1')
      const model = url.searchParams.get('model') ?? ''
      if (model === '') return json(res, 400, { error: 'model is required' })
      const region = regionOfPath(req.url ?? '')
      const probe = region !== undefined ? deps.probes[region] : undefined
      if (probe === undefined) return json(res, 400, { error: 'unknown region' })
      const result = await probe.probe(model)
      return json(res, 200, result)
    })

    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* already disposed */ }
      }
    }
  })
}