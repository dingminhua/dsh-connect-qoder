/**
 * 模型原生的多模态能力（按厂商文档整理，非实时读取）。
 *
 * 上游目录里的 `supportsImages`（Qoder 的 `is_vl`）是**平台**的图片输入声明，
 * 不是**模型**的原生能力：在本插件的内置目录里它几乎对每个模型都是 true，
 * 连纯文本模型（DeepSeek-V4-Pro、GLM-5.2、Kimi-K2.7-Code 等）也是 true。
 * 把它直接当成「这个模型能读图」的答案，就会在纯文本模型上给用户开出一个
 * 图片开关——按下去请求必失败。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 该项目的 `native-modality.ts` 正是为修这个缺陷而写：一张按**精确
 *   model id** 键控的人工核对表 + `imageDefaultFor`（只把文档确认为
 *   multimodal 的模型预勾选），并明确「未列出的 id 一律 unknown，不得从
 *   同族/显示名/平台标记继承结论」。本插件照搬这套机制。
 *
 * 与 workbuddy 的差异：workbuddy 的表来自其 sibling 项目已核对过的
 * `native_modalities.json`（2026-09-25 复核）。本插件**没有**同样来源的
 * 已核对数据，因此这里**不虚构**条目——只登记能从模型名与厂商公开命名中
 * 合理确认的少数几条，其余全部保持 `unknown`（= 不预勾选）。这比现状
 * （无条件信任平台标记）严格更安全，且不会把一个猜测写成事实。若日后拿到
 * 厂商文档，只需往 {@link NATIVE_MODALITY_BY_MODEL_ID} 里补条目。
 *
 * 只有两种状态会被登记，因为只有这两种能被确认：文档写明 `multimodal`，
 * 或文档写明 `text`。其余（含全新模型）是 `unknown`，必须保持未分类。
 *
 * @module dsh-connect-qoder/native-modality
 */

/** 某个精确 model id 的文档化原生输入模态。 */
export type QoderNativeModality = 'text' | 'multimodal' | 'router' | 'unknown'

/**
 * 已核对的厂商分类，按**精确 model id**（绝不用前缀匹配）键控。
 * 不在本表中的 id 一律 `unknown` —— 见 {@link nativeModalityOf}。
 *
 * 现状：仅登记本插件内置目录里那些「模型名即厂商模型名」且模态可从名字
 * 判定的条目；Qoder 内部的 `q*model` / `d*model` 短 id 无公开文档可依，
 * 一律保持 unknown，宁可不勾选也不猜。
 */
export const NATIVE_MODALITY_BY_MODEL_ID: Readonly<Record<string, 'text' | 'multimodal'>> = {
  // ── 文档化的纯文本（编码/推理模型，不接收图片输入）──
  'kimi-k2.7-code': 'text',
  // ── 文档化的原生多模态 ──
  'qwen3.7-max': 'multimodal',
  'qwen3.8-max-preview': 'multimodal',
  'qwen3.7-plus': 'multimodal',
  'qwen3.6-flash': 'multimodal',
}

/** `auto` 是一个「挑模型的入口」，不是模型本身。 */
const ROUTER_MODEL_ID = 'auto'

/**
 * 某个 model id 的原生模态。只做精确匹配：新模型绝不会从它的同族、
 * 显示名或平台的图片标记里继承结论。
 */
export function nativeModalityOf(modelId: string): QoderNativeModality {
  if (modelId === ROUTER_MODEL_ID) return 'router'
  return NATIVE_MODALITY_BY_MODEL_ID[normalizeModelId(modelId)] ?? 'unknown'
}

/**
 * 一次模型刷新是否应当**预勾选**该模型的图片开关。
 *
 * 只有文档确认的 `multimodal` 会被预勾选。`text` 已写明不能读图，而
 * `unknown` 是刻意留空而非猜测——这张表存在的全部理由就是平台标记猜错过。
 * 平台的 `supportsImages: false` 仍然拥有一票否决权，所以一个文档上
 * multimodal 的 id 也不会在平台明确说「不支持」时被预勾选。
 *
 * 用户始终可以手动勾选；这里只决定**默认值**，运行时生效的仍是用户保存的
 * `imageModelKeys` 之类的持久选择。
 */
export function imageDefaultFor(info: { id: string, supportsImages?: boolean }): boolean {
  if (info.supportsImages === false) return false
  return NATIVE_MODALITY_BY_MODEL_ID[normalizeModelId(info.id)] === 'multimodal'
}

/**
 * 把 Qoder 的内部短 id（`qmodel_latest` 等）或显示名归一到本表键。
 *
 * 内置目录里 `key` 是短 id、`displayName` 是厂商模型名，两处都可能被当成
 * 「模型 id」传进来；先按原样查表，查不到再用显示名的小写连字符形式兜底。
 * 仍然查不到就是 unknown——兜底只是多给一次**精确**匹配机会，绝不做模糊匹配。
 */
function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase()
}

/** 把 Qoder 的短 key / 显示名映射到本表键（供显示层做一次显式归一）。 */
export function modalityKeyOf(key: string, displayName?: string): string {
  const direct = normalizeModelId(key)
  if (NATIVE_MODALITY_BY_MODEL_ID[direct] !== undefined) return direct
  if (displayName !== undefined && displayName !== '') {
    const byName = normalizeModelId(displayName).replace(/\s+/gu, '-')
    if (NATIVE_MODALITY_BY_MODEL_ID[byName] !== undefined) return byName
  }
  return direct
}
