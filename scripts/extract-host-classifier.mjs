#!/usr/bin/env node
/**
 * 从**装机的宿主** `app.asar` 逐字提取 pi-ai 失败分类器，重写 golden 夹取。
 *
 * ## 为什么这是一个脚本，而不是「照着抄一遍」
 *
 * `tests/fixtures/host-piai-classifier.json` 里的三段源码必须与装机宿主**逐字**
 * 相同 —— 否则 `tests/shim.spec.ts` 断言的就只是我们自己抄的副本，而副本会跟着
 * 我们一起漂移（本仓库为「403 被判 AUTH」这个假警报吃过的正是这一口）。
 *
 * 手抄已经漂移过一次：0.2.2-rc.2 把 `classifyPiAiError` 改成先取报文**开头**的
 * 状态码，并引入 `const LEADING_HTTP_STATUS = …`；手工补 fiducial 时只改了两个
 * 函数、漏了那个常量，于是 `new Function(...)` 在测试里直接
 * `ReferenceError: LEADING_HTTP_STATUS is not defined`。脚本按**签名**定位、按
 * **花括号配平**截取，漏一个依赖就会在自检里立刻暴露，而不是等到使用者报障。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/extract-host-classifier.mjs            # 从默认安装路径提取
 * node scripts/extract-host-classifier.mjs --check    # 只比对，不写文件
 * node scripts/extract-host-classifier.mjs --asar /path/to/app.asar
 * ```
 *
 * 写完请跑 `pnpm exec vitest run tests/shim.spec.ts` —— 里面的自检会把这份夹具
 * 再与装机 asar 比一遍。
 *
 * @module dsh-connect-qoder/scripts/extract-host-classifier
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 写进夹具的相对路径，**不带本机绝对路径**。
 *
 * `tmp` 目录串、`/Users/<name>/…` 这类前缀会被 `tests/privacy.spec.ts` 判死；
 * 而且夹具是随仓库发布的证据，读它的人要看到的是「哪个文件」，不是谁的机器。
 */
const APP_LABEL = 'DeepSeek Harness.app/Contents/Resources/app.asar'

const DEFAULT_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

/**
 * 要提取的三段，按出现顺序排列。
 *
 * `signature` 必须与宿主源码逐字相同（缩进与换行不算，见 {@link collapse}）；
 * `extract` 决定怎么截：函数按花括号配平，常量取到行尾。
 */
const TARGETS = [
  {
    key: 'leadingHttpStatus',
    signature: 'const LEADING_HTTP_STATUS =',
    kind: 'declaration',
  },
  {
    key: 'isQuotaExceededError',
    signature: 'function isQuotaExceededError(detail) {',
    kind: 'function',
  },
  {
    key: 'classifyPiAiError',
    signature: 'function classifyPiAiError(message) {',
    kind: 'function',
  },
]

/** 与 `tests/host-piai.ts` 的自检用同一套归一化，避免「换行不同就算不一致」。 */
function collapse(text) {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * 从 `signature` 起按花括号配平截出一整个函数。
 *
 * 不用「截到下一个 `\n}`」：函数体里本来就有顶格的 `}`（模板串、嵌套块都有），
 * 而且宿主被打包后缩进不统一。配平是唯一稳定的判据。
 */
function functionAt(raw, start) {
  const open = raw.indexOf('{', start)
  if (open < 0) throw new Error('signature 之后没有 `{`：宿主结构变了')
  let depth = 0
  for (let i = open; i < raw.length; i += 1) {
    const char = raw[i]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return raw.slice(start, i + 1)
    }
  }
  throw new Error('花括号没有配平：文件被截断了？')
}

/** 从 `signature` 起截到该行行尾（`;` 之后），用于顶层常量。 */
function declarationAt(raw, start) {
  const semi = raw.indexOf(';', start)
  if (semi < 0) throw new Error('常量声明没有以 `;` 结束：宿主结构变了')
  return raw.slice(start, semi + 1)
}

/**
 * 常量只存**初始化部分**，不存 `const NAME = ` 前缀。
 *
 * 理由很实际：`tests/host-piai.ts` 要用同一个字符串拼出可执行源码，前缀在那边
 * 是跟着 `const ${name} = ` 一起拼的。存整行会让「同一段东西」有两个形状，
 * 而形状不一致正是上面说的漏提漂移 —— 这里只留一个形状。
 */
function initializerOf(declaration) {
  const at = declaration.indexOf('=')
  if (at < 0) throw new Error('常量声明里没有 `=`：宿主结构变了')
  return declaration.slice(at + 1).trim()
}

/**
 * 定位并截取一段，且**要求全文唯一**。
 *
 * 唯一性是必须的：宿主的 asar 里有不止一份 `isQuotaExceededError`
 * （`dsh-llm` 的错误分类器另有一份，外观相近）。按第一个命中即可，但「有几处」
 * 必须记录下来 —— 若哪天 `classifyPiAiError` 出现两份，说明宿主内嵌了两代
 * `dsh-llm-pi-ai`，那时取哪一份就不再是无所谓的决定，脚本要当场停下问人。
 */
function locate(raw, target) {
  const positions = []
  let index = raw.indexOf(target.signature)
  while (index >= 0) {
    positions.push(index)
    index = raw.indexOf(target.signature, index + 1)
  }
  if (positions.length === 0) {
    throw new Error(`装机宿主里找不到 ${target.key}（已改名？宿主升级后需要更新签名）`)
  }
  const first = positions[0]
  const body = target.kind === 'function' ? functionAt(raw, first) : initializerOf(declarationAt(raw, first))
  return { body, occurrences: positions.length }
}

/** dsh 版本读不到就不写死：夹具里的 `source.dshVersion` 只作溯源提示。 */
function dshVersion(raw) {
  // 打包后的 asar 里 `@deepseek-ai/dsh` 的 package.json 是纯文本 json 片段。
  const match = /"name"\s*:\s*"@deepseek-ai\/dsh"[\s\S]{0,400}?"version"\s*:\s*"([^"]+)"/u.exec(raw)
  return match?.[1]
}

function main(argv) {
  const check = argv.includes('--check')
  const asarFlag = argv.indexOf('--asar')
  const asarPath = asarFlag >= 0 ? argv[asarFlag + 1] : DEFAULT_ASAR
  if (asarPath === undefined) throw new Error('--asar 后面要跟一个路径')

  const bytes = readFileSync(asarPath)
  // latin1 是**逐字节无损**的：asar 是二进制容器，用 utf8 解码会把非 UTF-8 的
  // 字节替换成 U+FFFD，于是「逐字比对」这条前提本身就不成立了。
  const raw = bytes.toString('latin1')

  const fixturePath = fileURLToPath(new URL('../tests/fixtures/host-piai-classifier.json', import.meta.url))
  const existing = JSON.parse(readFileSync(fixturePath, 'utf8'))

  const extracted = {}
  for (const target of TARGETS) {
    const { body, occurrences } = locate(raw, target)
    extracted[target.key] = body
    const label = target.key === 'leadingHttpStatus' ? 'LEADING_HTTP_STATUS' : target.key
    console.error(`${label}: 命中 ${occurrences} 处，取第一处（${body.length} 字节）`)
    if (target.key === 'classifyPiAiError' && occurrences > 1) {
      throw new Error('classifyPiAiError 出现多份：宿主内嵌了两代 dsh-llm-pi-ai，取哪一份不再是无所谓的决定')
    }
  }

  const next = {
    _comment: existing._comment,
    // 夹具里必须写着「怎么重新提取」。`tests/host-piai.ts` 的文件头原先写
    // 「提取脚本见 source 字段」，而 `source` 里从来没有那个字段 —— 那是本仓库
    // 明令禁止的悬空引用（`RELEASE_EXISTING` 那次就是这么来的）。所以把命令本身
    // 落进夹具：谁读到这份文件，都能在下一次宿主升级时重跑它。
    _refresh: 'node scripts/extract-host-classifier.mjs（--check 只比对不写）',
    source: {
      app: APP_LABEL,
      dshVersion: dshVersion(raw) ?? existing.source.dshVersion,
      asarSha256: createHash('sha256').update(bytes).digest('hex'),
      extractedAt: new Date().toISOString().slice(0, 10),
    },
    quotaCodeConstant: existing.quotaCodeConstant,
    isQuotaExceededError: extracted.isQuotaExceededError,
    classifyPiAiError: extracted.classifyPiAiError,
    leadingHttpStatus: extracted.leadingHttpStatus,
  }

  // `--check`：只回答「夹具与装机宿主是否一致」，CI 与非 macOS 上用它替代手抄。
  if (check) {
    const same = ['isQuotaExceededError', 'classifyPiAiError', 'leadingHttpStatus']
      .every(key => collapse(existing[key] ?? '') === collapse(next[key]))
    if (!same) {
      console.error('夹具与装机宿主不一致 —— 跑一次不带 --check 的提取。')
      process.exitCode = 1
      return
    }
    console.error('夹具与装机宿主一致。')
    return
  }

  writeFileSync(fixturePath, `${JSON.stringify(next, null, 2)}\n`)
  // 只打**仓库相对**路径，不打 `fixturePath`：后者含本机主目录
  // （`/Users/<name>/…`），而这段输出会被贴进 issue / 聊天记录里排查问题。
  // 它不会进仓库（`scripts/` 不在 `files` 清单里），所以这是洁癖不是泄漏 ——
  // 但贴日志是这类脚本最常见的用法，默认安全比事后删干净便宜。
  console.error('已写入 tests/fixtures/host-piai-classifier.json')
}

main(process.argv.slice(2))
