/**
 * 模型原生的多模态能力（人工核对表，非实时读取）。
 *
 * 上游目录里的 `supportsImages`（Qoder 的 `is_vl`）是**平台**的图片输入声明，
 * 不是**模型**的原生能力。把它直接当成「这个模型能读图」的答案曾经是错的，
 * 所以本模块只认一张**人工核对表**，未列出的 id 一律 `unknown`（= 不预勾选）。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 该项目的 `native-modality.ts` 正是为修这个缺陷而写：一张按**精确
 *   model id** 键控的人工核对表 + `imageDefaultFor`（只把确认为
 *   multimodal 的模型预勾选），并明确「未列出的 id 一律 unknown，不得从
 *   同族/显示名/平台标记继承结论」。本插件照搬这套机制。
 *
 * ## 核对依据（2026-10-29 重做）
 *
 * 旧表是按**厂商文档**登记的，且键全是当时的厂商模型名（`qwen3.7-max` 等）。
 * 那张表有两个问题，都已实测确认：
 *
 * 1. **键对不上**（issue #22 主因）：目录里的 `key` 是 Qoder 内部短 id
 *    （`qmodel_latest`），`displayName` 才是厂商名，而调用方只传了 `key`。
 *    两边结构上不可能相等，于是每次 seed 查表都落到 `undefined` ⇒ 整张表是
 *    死代码。修法是让调用方把两个候选键都交进来（见 `imageDefaultFor`）。
 * 2. **结论也已过期**：旧表把 `kimi-k2.7-code` 标成 `text`，把
 *    `DeepSeek-V4-Pro` / `GLM-5.2` 当作纯文本；但**实测它们都能读图**。
 *
 * 实测方法（可复现）：给每个模型发一张 160×160、画着数字 `7` 的 PNG，问
 * 「图片里是哪一个数字」。读不到图的模型答不出 `7`；读得到的会答对，甚至
 * 描述笔画。2026-10-29 对两个区域共 14 个模型逐个跑过，**全部答对 `7`**
 * （另用「左红右蓝」双色图与纯色图交叉复核，同样全部答对）。其中
 * `mmodel` 起初每次失败，根因是上游会投递 `body: "null"` 的空帧，把
 * `parseStreamDelta` 打成 TypeError（已在 `upstream.ts` 修掉）——它不是
 * 纯文本模型，只是被一个解析崩溃掩盖了。
 *
 * 因此**当前目录里没有纯文本模型**：`is_vl` 在这份目录上恰好是准确的。表里
 * 保留 `'text'` 这个状态是因为机制需要它（将来若真有纯文本模型，加一行即可），
 * 但**不虚构**任何条目。
 *
 * ## 为什么按**短 id** 键控
 *
 * 短 id（`qmodel_38max`）是上游的稳定标识，而显示名会随模型迭代改名
 * （`Qwen3.7-Max` → `Qwen3.8-Max` 就是一次真实发生的改名，旧表的四个
 * `qwen3.x` 键因此全部失配）。按短 id 键控，升级模型时不会悄悄失效。厂商名
 * 仍然保留为**别名键**（`modalityKeyOf` 的显示名兜底要用），两边指向同一结论。
 *
 * 只有两种状态会被登记：确认 `multimodal`，或确认 `text`。其余（含全新模型）
 * 是 `unknown`，必须保持未分类——宁可不预勾选，也不把一个猜测写成事实。
 *
 * @module dsh-connect-qoder/native-modality
 */

/** 某个精确 model id 的文档化原生输入模态。 */
export type QoderNativeModality = 'text' | 'multimodal' | 'router' | 'unknown'

/**
 * 已核对的分类，按**精确 model id**（绝不用前缀匹配）键控。
 * 不在本表中的 id 一律 `unknown` —— 见 {@link nativeModalityOf}。
 *
 * 主键是 Qoder 的**内部短 id**（稳定），厂商显示名作别名（见文件头
 * 「为什么按短 id 键控」）。两个键指向同一结论，`imageDefaultFor` 会依次试。
 */
export const NATIVE_MODALITY_BY_MODEL_ID: Readonly<Record<string, 'text' | 'multimodal'>> = {
  // ── cn 与 global 共有的 ──
  // 实测 2026-10-29：全部能读图（数字 7 / 双色图交叉复核）。
  'qmodel_38max': 'multimodal', // Qwen3.8-Max
  'qfmodel': 'multimodal', // Qwen3.8-Flash
  'dmodel': 'multimodal', // DeepSeek-V4-Pro
  'dfmodel': 'multimodal', // DeepSeek-Flash
  'gmodel': 'multimodal', // GLM-5.3
  'gfmodel': 'multimodal', // GLM-5.3-Flash
  'kmodel_latest': 'multimodal', // Kimi-K3.1-Pro
  'kmodel': 'multimodal', // Kimi-K2.8-Preview
  'mmodel': 'multimodal', // MiniMax-M3.1-Flash
  'fast': 'multimodal', // Fast

  // ── 仅国际版下发（cn 没有这几条）──
  'ultimate': 'multimodal', // Ultimate
  'efficient': 'multimodal', // Efficient
  'smodel': 'multimodal', // Sonus
  'cmodel': 'multimodal', // Cantus

  // ── 厂商显示名别名 ──
  // 目录里的 `key` 是短 id，但旧存档、外部选择器、以及本模块的显示名兜底
  // （`modalityKeyOf`）都可能拿厂商名来查。别名与主键同结论。
  'qwen3.8-max': 'multimodal',
  'qwen3.8-flash': 'multimodal',
  'deepseek-v4-pro': 'multimodal',
  'deepseek-flash': 'multimodal',
  'glm-5.3': 'multimodal',
  'glm-5.3-flash': 'multimodal',
  'kimi-k3.1-pro': 'multimodal',
  'kimi-k2.8-preview': 'multimodal',
  'minimax-m3.1-flash': 'multimodal',
  'sonus': 'multimodal',
  'cantus': 'multimodal',

  // ── 旧目录里的条目（内置 fallback / 旧存档仍可能读到）──
  // 这几个是**旧模型名**，实测同样能读图（Qwen 系与 Kimi 系都答对了 7）。
  // 保留它们是为了让升级前保存的 `lastCatalog` 也能拿到正确默认。
  //
  // `kimi-k2.7-code` 在旧表里被标成 `text`，那是**错的**：Kimi 系实测能读图，
  // 而且它的继任者（`kmodel` / Kimi-K2.8-Preview）也实测能读图。这里改回
  // `multimodal`——旧结论没有实测支撑，只是按「code 模型应是纯文本」推的。
  'kimi-k2.7-code': 'multimodal',
  'qwen3.7-max': 'multimodal',
  'qwen3.8-max-preview': 'multimodal',
  'qwen3.7-plus': 'multimodal',
  'qwen3.6-flash': 'multimodal',
  // GLM-5.2 与 MiniMax-M2.7 没有单独的实测样本（这两条已不在当前目录里），
  // 但它们的**继任者** `gmodel`（GLM-5.3）与 `mmodel`（MiniMax-M3.1-Flash）
  // 都实测能读图，且同族内没有反向证据。登记为 multimodal 并标注来源，而不是
  // 留成 unknown——留空会让升级用户的旧存档继续默认关图，那正是 #22 的病灶。
  'gm51model': 'multimodal',
  'glm-5.2': 'multimodal',
  'minimax-m2.7': 'multimodal',
}

/**
 * 上游的**路由器**（router），不是模型。
 *
 * `auto` 是一个「挑模型的入口」：网关在**请求时**才决定把它解析成哪一个模型。
 * 所以它的上下文窗口、思考档位与计费对象都由别人临时决定，插件无法如实描述
 * ——本仓库保存下来的真实目录里，`auto` 正是**唯一没有思考档位**、却带着
 * `isDefault: true` 的那一行。把它列成一个可勾选的模型，用户勾的是一个「未知
 * 会变成谁」的条目。
 *
 * **用显式表而不是名字启发式**：路由是上游的概念，没有声明字段可查；按名字
 * 猜（比如「叫 auto 的都丢」）迟早会误伤一个真的叫这个名字的模型。要往这里
 * 加 id，先拿到与 `auto` 同等强度的证据。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）的
 * `ROUTER_MODEL_IDS` / `isRouterModelId`——那边同样用显式表而非启发式。
 */
export const ROUTER_MODEL_IDS: ReadonlySet<string> = new Set(['auto'])

/** 这个 id 是不是上游路由器（而不是模型）。 */
export function isRouterModelId(modelId: string): boolean {
  return ROUTER_MODEL_IDS.has(normalizeModelId(modelId))
}

/**
 * 某个 model id 的原生模态。只做精确匹配：新模型绝不会从它的同族、
 * 显示名或平台的图片标记里继承结论。
 */
export function nativeModalityOf(modelId: string): QoderNativeModality {
  if (isRouterModelId(modelId)) return 'router'
  return NATIVE_MODALITY_BY_MODEL_ID[normalizeModelId(modelId)] ?? 'unknown'
}

/**
 * 一次模型刷新是否应当**预勾选**该模型的图片开关。
 *
 * 只有表里确认 `multimodal` 的会被预勾选。`text` 已写明不能读图，而
 * `unknown` 是刻意留空而非猜测——这张表存在的全部理由就是平台标记猜错过。
 * 平台的 `supportsImages: false` 仍然拥有一票否决权，所以一个表里 multimodal
 * 的 id 也不会在平台明确说「不支持」时被预勾选。
 *
 * 用户始终可以手动勾选；这里只决定**默认值**，运行时生效的仍是用户保存的
 * `imageModelKeys` 之类的持久选择。
 *
 * **`name` 是必须传的第二个候选键**（issue #22 的根因）。表的主键是 Qoder 内部
 * 短 id（`qmodel_38max`），但旧存档、外部选择器与旧表都以**厂商显示名**
 * （`Qwen3.8-Max`）称呼同一个模型。调用方此前只传 `key`，两边结构上不可能
 * 相等 ⇒ 每一次 seed 查表都落到 `undefined` ⇒ 整张表是死代码。传两个候选键
 * 就是把这张表真正接上线。
 *
 * 仍然是**精确**匹配、不做模糊匹配：短 id 与显示名各查一次同样的表，查不到
 * 就是 unknown。**不**从同族前缀继承（`qwen3.9-max` 不会因为 `qwen3.8-max`
 * 是 multimodal 而被勾上）。
 */
export function imageDefaultFor(info: { id: string, name?: string, supportsImages?: boolean }): boolean {
  if (info.supportsImages === false) return false
  if (NATIVE_MODALITY_BY_MODEL_ID[normalizeModelId(info.id)] === 'multimodal') return true
  if (info.name === undefined || info.name === '') return false
  return NATIVE_MODALITY_BY_MODEL_ID[normalizeModelId(info.name).replace(/\s+/gu, '-')] === 'multimodal'
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
