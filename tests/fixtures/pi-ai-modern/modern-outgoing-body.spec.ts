/**
 * 同样的问题，换到 **pi-ai 1.x** 上问一遍 —— 这是宿主 0.2.1-rc.1 实际装着的那一代。
 *
 * 为什么单独一个文件、单独一份 dependency：
 *   本仓库的依赖树被 `pnpm-workspace.yaml` 的 overrides 钉在 pi-ai **0.85.1**
 *   （那是 0.1.7 宿主线要的）。而 0.2.1-rc.1 宿主装的是 pi-ai **1.x**，两代对
 *   上下文的读法不同。要证明「modern 分支在 1.x 上是对的」，就必须真的有一个
 *   1.x 的 api 可跑 —— 所以 `tests/fixtures/pi-ai-modern/` 是一份独立的 1.x
 *   安装（1.1.0，与 followup 文档同一个版本），只在构建请求体时被用到，不参与
 *   本仓库的解析树。
 *
 * 这一套钉的是 0.2.1-rc.1 回归的**结局**：
 *   - 归一化发生在 pi-ai 的 Models 层（`createModels().stream*` →
 *     `normalizeContext`），位于宿主与 api 模块之间；因此 api 模块拿到的
 *     永远是 `{messages:[{role:'system', content, toolsAdded}]}`。
 *   - 旧 `generationOf` 把 `1.x` 判成 `legacy`，适配器于是把这个 transcript
 *     逆折叠成扁平 envelope 交给 1.x api —— 1.x 只读 `messages`，于是线上请求
 *     **没有系统提示词、没有工具**，且不报错。
 *
 * 这里用**真实的** 1.1.0 `createModels` + 真实 `openAICompletionsApi` 复现这两格，
 * 断言线上 body。`tests/pi-ai-runtime.spec.ts` 的版本表守卫
 * 「1.x 必须判成 modern」，两者合起来才闭环。
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generationOf } from '../../../src/pi-ai-runtime.ts'

const fixtureRequire = createRequire(new URL('./package.json', import.meta.url))

/** 这份 fixture 装的是哪一版 —— 用例名里要能看见，避免"跑的是谁"说不清。 */
const FIXTURE_MANIFEST = new URL('./node_modules/@earendil-works/pi-ai/package.json', import.meta.url)

/**
 * 没装就直接说没装，**不要静默通过**。
 *
 * `node_modules/` 不进版本控制，所以一份干净的 checkout（CI 首次构建）里没有
 * 这份 1.x。此时整套跳过并打印怎么装 —— 而不是假装"现代世代已验证"。
 * 装法：`pnpm run fixture:pi-ai-modern`（见 package.json 的 scripts）。
 */
const FIXTURE_INSTALLED = existsSync(fileURLToPath(FIXTURE_MANIFEST))
const FIXTURE_VERSION: string = FIXTURE_INSTALLED
  ? (JSON.parse(readFileSync(fileURLToPath(FIXTURE_MANIFEST), 'utf8')) as { version: string }).version
  : 'not-installed'

const PROMPT = 'SYS-PROMPT-MARKER'
const TOOL = {
  name: 'pwsh',
  description: 'run a shell command',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
}

/** `toPiModel` 会产出的那种描述符：api 会读 baseUrl/input/cost/compat。 */
const MODEL = {
  id: 'qmodel',
  name: 'Qwen3.7-Plus',
  api: 'openai-completions',
  provider: 'qoder',
  baseUrl: 'http://127.0.0.1:9/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
  compat: { supportsReasoningEffort: false, supportsDeveloperRole: false },
}

/** 宿主交给 provider 的形状（`piContext()` 的产物）。 */
function rawEnvelope(): Record<string, unknown> {
  return {
    systemPrompt: PROMPT,
    tools: [TOOL],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }],
  }
}

/** 适配器 legacy 分支会把上面的 envelope 逆折叠成这个（即 0.2.1-rc.1 的 bug 形状）。 */
function foldedByLegacyBranch(): Record<string, unknown> {
  return {
    messages: [
      { role: 'system', content: PROMPT, toolsAdded: [TOOL], timestamp: 0 },
      { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 },
    ],
  }
}

interface Wire {
  roles: string[]
  system: string | null
  tools: number
}

/**
 * 走**真实** pi-ai 1.x 的完整链路：createModels → normalizeContext → api →
 * 构建 body。`branch` 决定 api 包装层是否执行 legacy 的逆折叠。
 */
async function wireThroughRealPiAi(
  branch: 'legacy-fold' | 'modern-passthrough',
  context: Record<string, unknown>,
): Promise<Wire> {
  const pi = await import(new URL('./node_modules/@earendil-works/pi-ai/dist/index.js', import.meta.url).href) as {
    createProvider: (input: unknown) => unknown
    createModels: (auth: unknown) => { clearProviders: () => void, setProvider: (p: unknown) => void, streamSimple: Function }
  }
  const lazy = await import(new URL('./node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js', import.meta.url).href) as {
    openAICompletionsApi: () => Record<string, Function>
  }
  const realApi = lazy.openAICompletionsApi() as {
    stream: Function
    streamSimple: Function
  }

  // `modern-passthrough` = the api is handed whatever the Models layer produced.
  // `legacy-fold` = what the 0.2.1-rc.1 regression actually did: the adapter called
  // `adaptLegacyPiAiContext(context)` on the context it received and handed THAT
  // to the 1.x api. Replay exactly that transform, not a fixed literal.
  const legacyFold = (c: Record<string, unknown>): Record<string, unknown> => {
    if (c === null || typeof c !== 'object') return c
    if (c.systemPrompt) return c
    const messages = Array.isArray(c.messages) ? c.messages as { role?: string, content?: unknown, toolsAdded?: unknown[] }[] : undefined
    if (messages === undefined) return c
    const texts: string[] = []
    const rest: unknown[] = []
    const tools = new Map<string, unknown>()
    let sawSystem = false
    for (const message of messages) {
      if (message.role !== 'system') { rest.push(message); continue }
      sawSystem = true
      if (typeof message.content === 'string' && message.content !== '') texts.push(message.content)
      for (const tool of message.toolsAdded ?? []) tools.set(String((tool as { name?: unknown }).name), tool)
    }
    if (!sawSystem) return c
    const out: Record<string, unknown> = { ...c, messages: rest }
    if (texts.length > 0) out.systemPrompt = texts.join('\n\n')
    if (!Array.isArray(c.tools) && tools.size > 0) out.tools = [...tools.values()]
    return out
  }

  const api = branch === 'modern-passthrough'
    ? realApi
    : {
        ...realApi,
        streamSimple: (m: unknown, c: Record<string, unknown>, o: unknown) => realApi.streamSimple(m, legacyFold(c), o),
        stream: (m: unknown, c: Record<string, unknown>, o: unknown) => realApi.stream(m, legacyFold(c), o),
      }

  const provider = pi.createProvider({
    id: 'qoder',
    name: 'Qoder',
    models: [MODEL],
    api,
    auth: {
      apiKey: {
        name: 'Qoder shim token',
        resolve: async () => ({ auth: { apiKey: 'shim-secret' }, source: 'Qoder shim token' }),
      },
    },
  })

  const models = pi.createModels({})
  models.clearProviders()
  models.setProvider(provider)

  let body: Record<string, unknown> | undefined
  try {
    for await (const _event of models.streamSimple(MODEL, context, {
      apiKey: 'shim-secret',
      maxTokens: 10,
      fetch: async (_url: unknown, init: { body?: unknown }) => {
        body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
        throw new Error('captured before any network')
      },
    }) as AsyncIterable<unknown>) {
      // 排空到结束；fetch 抛出的错误会以事件形式浮现，此时 body 已截到。
    }
  } catch {
    // 已截到 body 或流提前失败，两者都无害。
  }
  expect(body, '没有构建出请求体').toBeDefined()

  const messages = body?.messages as { role?: string, content?: unknown }[] | undefined
  const system = messages?.find(message => message.role === 'system' || message.role === 'developer')
  return {
    roles: (messages ?? []).map(message => String(message.role)),
    system: system === undefined ? null : String(system.content),
    tools: Array.isArray(body?.tools) ? (body.tools as unknown[]).length : 0,
  }
}

describe(`现代世代（pi-ai ${FIXTURE_VERSION}，宿主 0.2.1-rc.1 的同代）`, () => {
  it.skipIf(!FIXTURE_INSTALLED)('fixture 真的是 1.x —— 否则这套用例证不到它该证的东西', () => {
    expect(FIXTURE_VERSION).toMatch(/^1\./u)
    // 且这正是版本表判成 modern 的那一段。
    expect(generationOf(FIXTURE_VERSION)).toBe('modern')
  })

  it.skipIf(!FIXTURE_INSTALLED)('modern 直通：提示词与工具都出门（这就是 0.2.1-rc.1 修好后的形状）', async () => {
    // 宿主交来原始 envelope；pi-ai 的 Models 层先归一化，api 直通执行。
    const wire = await wireThroughRealPiAi('modern-passthrough', rawEnvelope())
    expect(wire.tools, 'body.tools 必须是 1 个').toBe(1)
    expect(wire.system).toBe(PROMPT)
    expect(wire.roles).toEqual(['system', 'user'])
  })

  it.skipIf(!FIXTURE_INSTALLED)('legacy 逆折叠在 1.x 上会静默丢掉提示词与工具（0.2.1-rc.1 的原症状）', async () => {
    // 这一格是**反向**断言：它记录缺陷的形态，而不是期望它。若有人把 modern
    // 改回走 legacy（也就是 generationOf 又认不出 1.x），这条会立刻红，
    // 并且在失败信息里直接说出「prompt 没了、tools 为 0」。
    const wire = await wireThroughRealPiAi('legacy-fold', rawEnvelope())
    expect(
      { system: wire.system, tools: wire.tools },
      '如果这里变成了 {system: PROMPT, tools: 1}，说明 legacy 折叠已不再破坏 1.x —— 请复核本用例的前提',
    ).toEqual({ system: null, tools: 0 })
    expect(wire.roles).toEqual(['user'])
  })

  it.skipIf(!FIXTURE_INSTALLED)('幂等：把已归一化的 transcript 再送一遍，仍只有一条 system 消息', async () => {
    const wire = await wireThroughRealPiAi('modern-passthrough', foldedByLegacyBranch())
    expect(wire.roles.filter(role => role === 'system')).toHaveLength(1)
    expect(wire.system).toBe(PROMPT)
    expect(wire.tools).toBe(1)
  })
})

/** fixture 目录必须在版本控制里可见，否则 CI 上这套会被静默跳过。 */
describe('fixture 可追溯', () => {
  it('记录了自己钉的 pi-ai 版本与用途，并可一键安装', () => {
    const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.['@earendil-works/pi-ai']).toBe('1.1.0')
  })
})
