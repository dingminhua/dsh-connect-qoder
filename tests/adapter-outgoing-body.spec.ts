/**
 * **线上请求体**必须带着系统提示词与工具声明。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   `tests/adapter-outgoing-body.spec.ts` —— 「必须跑真实 api、截真实 body」这条
 *   方法论直接沿用。**但断言的矩阵与那篇 followup 文档不同**，原因见下。
 *
 * 为什么需要这一套：`adapter.spec.ts` **mock 了 API**，断言的是「wrapper 收到
 * 的上下文」。这个断言恰好会**认证**缺陷 —— wrapper 收到什么是对的，错在别的
 * 环节。只有真正跑一遍 pi-ai 的 api、截住它构建出的 JSON body，才能看见
 * 「工具和提示词到底有没有出门」。
 *
 * ## 0.2.1-rc.1 回归到底是什么（实测，与 followup 文档的说法不同）
 *
 * 文档的判断是「modern 分支原样透传 → 1.x 丢失 prompt 与工具」。**实测不成立**：
 * 归一化发生在 pi-ai 的 **Models 层**（`createModels().stream*` →
 * `normalizeContext(context)`），它位于宿主 provider 注册处与 api 模块**之间**，
 * 所以 api 模块拿到的**永远是已归一化的 transcript**（用真实 createModels +
 * 真实 openaiCompletionsApi 在 pi-ai 1.1.0 与 1.3.0 上都验证过）。
 *
 * 真实根因是 `generationOf()` **认不出 1.x 主版本**：旧正则 `/^0\.(\d+)\./`
 * 对 `1.3.0` 匹配失败 → 落 `legacy` → 适配器对**已归一化**的 transcript 执行
 * `adaptLegacyPiAiContext`（逆折叠）→ 交给只读 `messages` 的 1.x api。
 * 在真实 0.2.1-rc.1 + pi-ai 1.3.0 栈上实测的线上 body：
 *
 *   legacy 分支（旧行为）→ roles ["user"], system null,      body.tools 0
 *   modern 分支（修复后）→ roles ["system","user"], prompt 原样, body.tools 1
 *
 * 因此本套件钉的是**世代 × 该世代真实会收到的输入**这两格，而不是「四种任意
 * 组合」。任意组合里 `modern × 已归一化 transcript` 在 0.85 的 checkout 上
 * 本来就不合法（0.85 读不懂 transcript，`transformMessages` 会崩），把它写成
 * 期望通过等于要求插件去修一个不存在的形状。
 *
 * ⚠️ 本 checkout 解析到 pi-ai 0.85.x，所以这里跑的是 **legacy 实现**；modern
 * 世代被注入 `piAiGeneration: 'modern'` 驱动。`tests/pi-ai-runtime.spec.ts`
 * 的版本表守卫 `generationOf`（1.x → modern）—— 两者合起来才是完整的护栏：
 * 一个证明「判对世代时线是对的」，一个证明「版本会被判对」。
 */

import { describe, expect, it } from 'vitest'
import { createQoderAdapter, QODER_PROVIDER } from '../src/adapter.ts'
import { QoderCatalog } from '../src/catalog.ts'
import type { QoderModelInfo } from '../src/catalog.ts'

/**
 * The catalog entry the adapter builds its model list from. `toPiModel` (not
 * this spec) turns it into the descriptor the api accepts, so the catalog must
 * be non-empty or `buildModels()` produces nothing and no request is ever made.
 */
const CATALOG_MODEL: QoderModelInfo = {
  key: 'qmodel',
  displayName: 'Qwen3.7-Plus',
  priceFactor: 1,
  contextWindow: 128_000,
  maxOutputTokens: 8192,
  supportsImages: false,
  supportsThinking: false,
  canDisableThinking: false,
  isDefault: true,
  isFree: false,
  isNew: false,
}

/**
 * 一个 openai-completions api 能原样接受的模型描述符。
 * 真实 api 会读 baseUrl/input/cost/compat（只给 `{id, api, provider}` 会在
 * 构建请求时炸掉），所以这里照 `toPiModel` 的产物镜像一份。
 */
const MODEL = {
  id: 'qmodel',
  name: 'Qwen3.7-Plus',
  api: 'openai-completions',
  provider: QODER_PROVIDER,
  baseUrl: 'http://127.0.0.1:1/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
  compat: {},
} as never

/** 每一格都必须出现在线上的工具。 */
const TOOL_SCHEMA = {
  name: 'pwsh',
  description: 'run a shell command',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
}

/** 每一格都必须作为首条 system 消息出现的提示词。 */
const PROMPT = 'You are helpful.'

/**
 * **已归一化**的 transcript —— 这是 pi-ai 的 Models 层在把上下文交给 api 模块
 * 之前产出的形状（`normalizeContext`），也是 0.87+/1.x 消费的形状。
 * `getCurrentSystemMessage` 读的就是 `{role:'system', content, toolsAdded}`。
 */
function normalizedTranscript(): Record<string, unknown> {
  return {
    messages: [
      { role: 'system', content: PROMPT, toolsAdded: [TOOL_SCHEMA], timestamp: 0 },
      { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 },
    ],
  }
}

/**
 * **未归一化**的扁平 envelope：`dsh-llm-pi-ai` 的 `piContext()` 在交给 provider
 * 时构建的形状（`{systemPrompt, tools, messages}`），也是 0.85 直接消费的形状。
 * 只有在「宿主没接 Models 层 / 直接调 api」的路径上，api 才会看到它。
 */
function rawEnvelope(): Record<string, unknown> {
  return {
    systemPrompt: PROMPT,
    tools: [TOOL_SCHEMA],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }],
  }
}

interface Captured {
  body: Record<string, unknown> | undefined
  errors: string[]
}

/** 驱动**真实的** api 穿过适配器，截住它构建的 body。 */
async function captureBody(
  generation: 'legacy' | 'modern',
  context: Record<string, unknown>,
): Promise<Captured> {
  const { adapter } = createQoderAdapter({
    shim: { baseUrl: 'http://127.0.0.1:1', secret: 'shim-secret' } as never,
    catalog: new QoderCatalog([CATALOG_MODEL]),
    piAiGeneration: generation,
  })
  const profile = (adapter as unknown as {
    config: {
      profiles: () => ReadonlyMap<string, {
        piProvider: { streamSimple: (m: unknown, c: unknown, o: unknown) => unknown }
      }>
    }
  }).config.profiles().get(QODER_PROVIDER)
  expect(profile).toBeDefined()

  let body: Record<string, unknown> | undefined
  const errors: string[] = []
  const stream = profile?.piProvider.streamSimple(MODEL, context, {
    apiKey: 'k',
    maxTokens: 10,
    fetch: async (_url: unknown, init: { body?: unknown }) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>
      throw new Error('captured before any network')
    },
  }) as AsyncIterable<{ type?: string, error?: { errorMessage?: string } }>
  // 排空：注入的 fetch 抛错，会以 stream error 事件浮现 —— 那时 body 已经截到。
  // 任何**早于** fetch 的错误意味着请求根本没被构建，要让它出现在失败信息里。
  for await (const event of stream) {
    if (event?.type === 'error') errors.push(String(event.error?.errorMessage ?? 'unknown stream error'))
  }
  return { body, errors }
}

/** 必须产生的两个线上事实。 */
function expectPromptAndTools(captured: Captured): void {
  const { body, errors } = captured
  expect(body, `没有构建出请求；stream errors: ${errors.join(' | ') || '(none)'}`).toBeDefined()

  // 工具声明必须出门。就是这条断言抓「上下文这一代读不懂」的缺陷。
  const tools = body?.tools as { function?: { name?: string } }[] | undefined
  expect(tools, 'body.tools 缺失 —— 请求没有声明任何工具').toBeDefined()
  expect(tools?.map(tool => tool.function?.name)).toEqual(['pwsh'])

  // 对话必须以原始系统提示词开头。
  const messages = body?.messages as { role?: string, content?: unknown }[]
  expect(messages).toBeDefined()
  expect(
    messages.filter(message => message.role === 'system' || message.role === 'developer'),
    '期望恰好一条 system 消息',
  ).toHaveLength(1)
  expect(messages[0]?.role).toBe('system')
  expect(messages[0]?.content).toBe(PROMPT)
}

describe('线上请求体带着提示词与工具', () => {
  // **只覆盖 legacy 世代**，因为本 checkout 解析到 pi-ai 0.85.1，而 0.85 的 api
  // 读不懂归一化的 transcript（它的 Message 联合里没有 `system` 变体，
  // `transformMessages` 会直接崩）。这不是缺陷，是世代契约：
  //
  //   legacy(0.85) × 已归一化 transcript → 逆折叠方向（issue #24 同源）
  //   legacy(0.85) × 扁平 envelope       → 0.85 的常规路径
  //
  // **modern(1.x) 那一格在 `tests/fixtures/pi-ai-modern/` 里跑**，那边装了一份
  // 真实的 pi-ai 1.1.0（宿主 0.2.1-rc.1 同代），用真实 createModels + 真实 api
  // 断言线上 body —— 0.2.1-rc.1 的回归就在那里被钉住。
  it.each([
    ['legacy', 'normalized transcript', normalizedTranscript],
    ['legacy', 'raw envelope', rawEnvelope],
  ] as const)(
    '%s 世代收到 %s 时，body.tools 与首条 system 提示词都在',
    async (generation, _shape, context) => {
      expectPromptAndTools(await captureBody(generation, context()))
    },
  )

  it('只有工具、没有提示词的上下文也要把工具送出门', async () => {
    // 折叠/逆折叠都不能要求两个字段**同时**存在才触发：只有工具时，工具同样
    // 必须能出门。
    const captured = await captureBody('legacy', {
      messages: [
        { role: 'system', content: '', toolsAdded: [TOOL_SCHEMA], timestamp: 0 },
        { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 },
      ],
    })
    const tools = captured.body?.tools as { function?: { name?: string } }[] | undefined
    expect(tools?.map(tool => tool.function?.name)).toEqual(['pwsh'])
  })

  it('没有提示词也没有工具时，不留一条空的 system 消息', async () => {
    // Qoder 网关接受 user-first 对话（见 adaptLegacyPiAiContext 的注释），
    // 所以「什么都没有」必须是**原样放行**，而不是凭空补一条空 system。
    const captured = await captureBody('legacy', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }],
    })
    const messages = captured.body?.messages as { role?: string }[]
    expect(messages.filter(message => message.role === 'system')).toHaveLength(0)
    expect(messages[0]?.role).toBe('user')
  })
})
