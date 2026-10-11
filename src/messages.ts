/**
 * OpenAI ↔ Qoder 消息转换与聊天请求体构建。
 *
 * Qoder 网关（agent_chat_generation）说 OpenAI 形状的消息：
 * - 入站（发给网关）消息用 `contents` 数组承载文本/图像 parts；
 * - 出站（网关返回）SSE 的 delta 直接是 OpenAI 形状
 *   （choices[].delta.{role,content,reasoning_content,tool_calls}）。
 *
 * 模板取自 fengyinxia/qoder2api baseprompt.json（MINIMAL 变体，已实测
 * 可用；不带系统提示词，messages 完全由调用方替换）。
 *
 * @module dsh-connect-qoder/messages
 */

// ---------------------------------------------------------------------------
// 聊天请求体模板（与 qoder2api baseprompt.json 逐字段一致）
// ---------------------------------------------------------------------------

export interface QoderChatTemplate {
  request_id: string
  request_set_id: string
  chat_record_id: string
  stream: boolean
  chat_task: string
  chat_context: {
    extra: {
      modelConfig: { is_reasoning: boolean; key: string }
      originalContent: { type: string; text: string }
    }
    text: { type: string; text: string }
  }
  session_id: string
  source: number
  version: string
  aliyun_user_type: string
  session_type: string
  agent_id: string
  task_id: string
  model_config: {
    key: string
    is_vl: boolean
    is_reasoning: boolean
    source: string
  }
  messages: unknown[]
  business: {
    id: string
    name: string
    begin_at: number
  }
  [key: string]: unknown
}

/** 构建一份全新的聊天请求体（每个请求必须换 ID）。 */
export function createChatBodyTemplate(): QoderChatTemplate {
  return {
    request_id: '',
    request_set_id: '',
    chat_record_id: '',
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      extra: {
        modelConfig: { is_reasoning: false, key: 'lite' },
        originalContent: { type: 'text', text: '' },
      },
      text: { type: 'text', text: '' },
    },
    session_id: '',
    source: 1,
    version: '3',
    aliyun_user_type: 'personal_standard',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    model_config: {
      key: 'lite',
      is_vl: false,
      is_reasoning: false,
      source: 'system',
    },
    messages: [],
    business: {
      id: '',
      name: 'hi',
      begin_at: 0,
    },
  }
}

// ---------------------------------------------------------------------------
// OpenAI 消息 → Qoder 消息
// ---------------------------------------------------------------------------

export interface QoderIncomingMessage {
  role: string
  content?: string
  contents?: Array<{ type?: string; text?: string; image_url?: { url?: string } }>
  tool_calls?: unknown[]
  name?: string
  tool_call_id?: string
  reasoning_content_signature?: string
  response_meta?: Record<string, unknown>
}

function blankResponseMeta(): Record<string, unknown> {
  return {
    id: '',
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 0 },
    },
  }
}

function structuredMessage(role: string, text: string): QoderIncomingMessage {
  return {
    role,
    content: text,
    response_meta: blankResponseMeta(),
    reasoning_content_signature: '',
  }
}

function userMessage(text: string, images: string[] = []): QoderIncomingMessage {
  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
  for (const url of images) {
    parts.push({ type: 'image_url', image_url: { url } })
  }
  if (text.trim()) {
    parts.push({ type: 'text', text })
  }
  if (parts.length === 0) {
    parts.push({ type: 'text', text: '' })
  }
  return {
    role: 'user',
    content: '',
    contents: parts,
    response_meta: blankResponseMeta(),
    reasoning_content_signature: '',
  }
}

function toolMessage(message: Record<string, unknown>, text: string): QoderIncomingMessage {
  const out = structuredMessage('tool', text)
  if (typeof message.name === 'string') out.name = message.name
  if (typeof message.tool_call_id === 'string') out.tool_call_id = message.tool_call_id
  return out
}

function assistantToolCallMessage(text: string, toolCalls: unknown[]): QoderIncomingMessage {
  const out = structuredMessage('assistant', text)
  out.tool_calls = toolCalls
  return out
}

/** 从 OpenAI 消息提取纯文本（content 字符串、contents parts、named 等）。 */
export function normalizeMessageText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content as Array<Record<string, unknown>>) {
      if (typeof part === 'string') {
        parts.push(part)
      } else if (part && typeof part === 'object') {
        const t = part.text
        if (typeof t === 'string') parts.push(t)
        else if (typeof part.value === 'string') parts.push(part.value)
      }
    }
    return parts.join('')
  }
  return ''
}

/** 提取消息里的图片 URL（user 消息的 image_url parts）。 */
export function extractMessageImages(message: Record<string, unknown>): string[] {
  if (message.role !== 'user') return []
  const content = message.content
  if (!Array.isArray(content)) return []
  const urls: string[] = []
  for (const part of content as Array<Record<string, unknown>>) {
    const iu = part.image_url as Record<string, unknown> | undefined
    if (iu && typeof iu.url === 'string') urls.push(iu.url)
  }
  return urls
}

const TOOL_CALLS_TEXT_RE = /Tool calls:\s*(\[[\s\S]*?\])/

/** 尝试从文本解析 "Tool calls: [...]" 形状的 tool_calls（兜底）。 */
export function parseToolCallsText(text: string | null | undefined): unknown[] | undefined {
  if (!text) return undefined
  const m = TOOL_CALLS_TEXT_RE.exec(text)
  if (!m?.[1]) return undefined
  try {
    const parsed = JSON.parse(m[1])
    if (Array.isArray(parsed) && parsed.every(item => item && typeof item === 'object')) {
      return normalizeToolCalls(parsed)
    }
  } catch {
    return undefined
  }
  return undefined
}

function normalizeToolCalls(raw: unknown[]): unknown[] {
  return raw.map((tc) => {
    if (tc && typeof tc === 'object' && !('function' in tc)) {
      const r = tc as Record<string, unknown>
      if (r.id && r.name && r.input) {
        return { id: r.id, type: 'function', function: { name: r.name, arguments: JSON.stringify(r.input) } }
      }
    }
    return tc
  })
}

/** 检测 assistant 消息之后是否有已解析的 tool 响应（决定结构化 tool_calls 传输）。 */
function hasResolvedToolResponse(messages: Array<Record<string, unknown>>, assistantIndex: number): boolean {
  const message = messages[assistantIndex]
  if (message === undefined || message.role !== 'assistant') return false
  const tc = message.tool_calls
  if (!(Array.isArray(tc) && tc.length > 0) && !parseToolCallsText(normalizeMessageText(message))) return false
  for (let i = assistantIndex + 1; i < messages.length; i += 1) {
    const next = messages[i]
    if (next?.role === 'tool') return true
    if (next !== undefined && (next.role === 'assistant' || next.role === 'user' || next.role === 'system')) return false
  }
  return false
}

function renderToolCalls(toolCalls: unknown[]): string {
  return `Tool calls:\n${JSON.stringify(toolCalls)}`
}

function renderToolResult(message: Record<string, unknown>, text: string): string {
  const name = typeof message.name === 'string' ? message.name : ''
  const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
  let out = 'Tool result'
  if (name) out += ` (${name})`
  if (toolCallId) out += ` [${toolCallId}]`
  if (text.trim()) out += `:\n${text}`
  return out
}

/**
 * 把一条 OpenAI 消息转换为 Qoder 消息形状；返回 null 表示该条无法表示（跳过）。
 */
export function convertIncomingMessage(
  message: Record<string, unknown>,
  toolsEnabled: boolean,
  allowStructuredToolCalls: boolean,
): QoderIncomingMessage | null {
  const role = typeof message.role === 'string' ? message.role : 'user'
  const text = normalizeMessageText(message)

  let structuredToolCalls: unknown[] | undefined
  if (toolsEnabled && allowStructuredToolCalls) {
    const tc = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      ? message.tool_calls
      : parseToolCallsText(text)
    if (tc) structuredToolCalls = tc
  }

  if (role === 'assistant' && structuredToolCalls) {
    return assistantToolCallMessage(text, structuredToolCalls)
  }

  // tool 结果：原文为 tool 角色时按 name/tool_call_id 传；否则渲染成文本。
  if (role === 'tool') {
    if (toolsEnabled) return toolMessage(message, text)
    return structuredMessage('user', renderToolResult(message, text))
  }

  // 非 tool 场景下，assistant 携带的 tool_calls 渲染进文本（不结构化）。
  let finalText = text
  if (role === 'assistant' && !toolsEnabled && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    finalText = [text, renderToolCalls(message.tool_calls)].filter(Boolean).join('\n\n')
  }

  const images = role === 'user' ? extractMessageImages(message) : []

  if (!finalText.trim() && images.length === 0) return null

  if (role === 'user') {
    // 图片作为真实 parts 传输时，去掉文本里的 "[image] <url>" 兜底占位。
    const cleaned = images.length > 0
      ? finalText.split('\n\n').filter(s => !s.trim().startsWith('[image] ')).join('\n\n')
      : finalText
    return userMessage(cleaned, images)
  }

  return structuredMessage(role, finalText)
}

/**
 * 构建发往 Qoder 网关的 messages 数组。OpenAI 形状入参 → Qoder 形状。
 */
export function buildQoderMessages(
  incoming: Array<Record<string, unknown>>,
  prompt: string,
  toolsEnabled: boolean,
): QoderIncomingMessage[] {
  const rebuilt: QoderIncomingMessage[] = []
  if (incoming.length > 0) {
    for (let i = 0; i < incoming.length; i += 1) {
      const allowStructured = toolsEnabled && hasResolvedToolResponse(incoming, i)
      const converted = convertIncomingMessage(incoming[i]!, toolsEnabled, allowStructured)
      if (converted !== null) rebuilt.push(converted)
    }
  }
  if (rebuilt.length === 0 && prompt.trim()) {
    rebuilt.push(userMessage(prompt))
  }
  return rebuilt
}

/** 取最后一条 user 消息的纯文本（供 chat_context / business.name 使用）。 */
export function extractLatestUserPrompt(messages: Array<Record<string, unknown>>): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m?.role === 'user') {
      const text = normalizeMessageText(m)
      if (text.trim()) return text
    }
  }
  return ''
}

/** 任意 JSON 深拷贝（模板必须逐请求独立）。 */
export function deepClone<T>(value: T): T {
  return structuredClone(value)
}

/** 模型名 → 是否需要图像输入（is_vl）。两个入口都改：model_config 与 chat_context.extra.modelConfig。 */
export function applyModelKey(body: QoderChatTemplate, key: string, userType: string, isVl: boolean): void {
  body.model_config.key = key
  body.model_config.is_vl = isVl
  body.chat_context.extra.modelConfig.key = key
  body.aliyun_user_type = userType
}