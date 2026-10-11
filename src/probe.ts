/**
 * 单模型探针：走 shim 发一个最小聊天请求，验证某模型当前可用。
 *
 * 探针是「当前可用性」的测量，不是能力清单：一个模型探针失败（限流/
 * 审核/瞬时错误）不代表它不可勾选，所以探针结果只做展示与缓存，从不
 * 反向写回目录。
 *
 * @module dsh-connect-qoder/probe
 */

import type { QoderShim } from './shim.ts'

export interface ProbeResult {
  ok: boolean
  kind: 'ok' | 'rate-limited' | 'auth' | 'content-policy' | 'quota-exhausted' | 'transient' | 'error'
  message: string
  latencyMs: number
  inputTokens: number | null
  outputTokens: number | null
}

export interface QoderProbeOptions {
  shim: QoderShim
  logger?: (message: string) => void
}

export function createQoderProbe(options: QoderProbeOptions): {
  probe: (modelId: string) => Promise<ProbeResult>
  cached: (modelId: string) => ProbeResult | undefined
} {
  const { shim } = options
  const logger = options.logger ?? (() => {})
  const cache = new Map<string, { result: ProbeResult; atMs: number }>()
  let inflight = new Map<string, Promise<ProbeResult>>()

  function probe(modelId: string): Promise<ProbeResult> {
    const existing = inflight.get(modelId)
    if (existing !== undefined) return existing
    const run = doProbe(modelId).finally(() => {
      inflight.delete(modelId)
    })
    inflight.set(modelId, run)
    return run
  }

  function cached(modelId: string): ProbeResult | undefined {
    const hit = cache.get(modelId)
    return hit?.result
  }

  async function doProbe(modelId: string): Promise<ProbeResult> {
    const started = Date.now()
    try {
      const url = `${shim.baseUrl}/v1/chat/completions`
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${shim.secret}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
          stream: true,
          max_tokens: 16,
        }),
      })
      if (resp.status === 401) {
        return cacheResult(modelId, { ok: false, kind: 'auth', message: '凭据无效', latencyMs: Date.now() - started, inputTokens: null, outputTokens: null })
      }
      if (resp.status === 429) {
        return cacheResult(modelId, { ok: false, kind: 'rate-limited', message: '请求被限流', latencyMs: Date.now() - started, inputTokens: null, outputTokens: null })
      }
      if (!resp.ok || !resp.body) {
        return cacheResult(modelId, { ok: false, kind: 'error', message: `HTTP ${resp.status}`, latencyMs: Date.now() - started, inputTokens: null, outputTokens: null })
      }
      // 解析 SSE 首块即可判定可用；读完整个流对每批探针太贵。
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let sawDelta = false
      let inputTokens: number | null = null
      let outputTokens: number | null = null
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const text = decoder.decode(value, { stream: true })
          for (const line of text.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (payload === '[DONE]') continue
            try {
              const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: Record<string, unknown> }>; error?: { code?: string; message?: string }; usage?: Record<string, unknown> }
              if (chunk.error?.code !== undefined) {
                return cacheResult(modelId, { ok: false, kind: kindOfErrorCode(chunk.error.code), message: chunk.error.message ?? '探针失败', latencyMs: Date.now() - started, inputTokens: null, outputTokens: null })
              }
              const delta = chunk.choices?.[0]?.delta
              if (delta !== undefined && Object.keys(delta).length > 0) sawDelta = true
              if (typeof chunk.usage?.prompt_tokens === 'number') inputTokens = chunk.usage.prompt_tokens
              if (typeof chunk.usage?.completion_tokens === 'number') outputTokens = chunk.usage.completion_tokens
            } catch {
              // 忽略无法解析的帧
            }
          }
          if (sawDelta) break
        }
      } finally {
        reader.releaseLock()
        resp.body?.cancel().catch(() => {})
      }
      if (!sawDelta) {
        return cacheResult(modelId, { ok: false, kind: 'transient', message: '上游无响应', latencyMs: Date.now() - started, inputTokens, outputTokens })
      }
      return cacheResult(modelId, { ok: true, kind: 'ok', message: '可用', latencyMs: Date.now() - started, inputTokens, outputTokens })
    } catch (error: unknown) {
      logger(`probe ${modelId} failed: ${String((error as Error)?.message ?? error)}`)
      return cacheResult(modelId, { ok: false, kind: 'error', message: String((error as Error)?.message ?? '网络错误'), latencyMs: Date.now() - started, inputTokens: null, outputTokens: null })
    }
  }

  function cacheResult(modelId: string, result: ProbeResult): ProbeResult {
    cache.set(modelId, { result, atMs: Date.now() })
    return result
  }

  function kindOfErrorCode(code: string): ProbeResult['kind'] {
    switch (code) {
      case 'rate_limit_exceeded': return 'rate-limited'
      case 'invalid_api_key': return 'auth'
      case 'content_policy_rejected': return 'content-policy'
      case 'quota_exceeded': return 'quota-exhausted'
      case 'upstream_error': return 'transient'
      default: return 'error'
    }
  }

  return { probe, cached }
}