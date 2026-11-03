/**
 * 双语 README 的**同步**守卫。
 *
 * ## 为什么要有这个文件
 *
 * 中文 README 与英文 README 是两份**手写**的文档，没有任何机制保证它们同步。
 * issue #29 的修复就是活生生的例子：中文 README 补了两节新内容
 * （`queueWaitMs` 的作用、两种「排队」的区别），**英文 README 一字未提** ——
 * 于是英文用户读到的仍是「配了 `maxDelayMs: 30000` 就万事大吉」，而那正是
 * issue 第四节指出的错误结论。
 *
 * 这一类缺口不会让任何构建或测试失败：文档不是产物的一部分，只有真去读它的人
 * 才会撞上。所以它需要一条**钉住**双语同步的用例。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 它的 `tests/dsh-line.spec.ts` 里有同款的「两份 README 都要有某句话」
 *   断言（`keeps the supported-range table in both READMEs`）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = new URL('../', import.meta.url)

const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, repoRoot)), 'utf8')

const zh = read('README.md')
const en = read('README.en.md')

describe('双语 README 同步', () => {
  it('排队等待的三个配置键在两份 README 里都出现', () => {
    // 这三个键是「用户要改重试行为」时唯一要碰的东西。缺一个，那份语言的读者
    // 就配不出来 —— 而 issue #29 的现场正是「配了 30000 以为万事大吉」。
    for (const key of ['maxRetries', 'initialDelayMs', 'maxDelayMs', 'queueWaitMs']) {
      expect(zh, `中文 README 缺 ${key}`).toContain(key)
      expect(en, `英文 README 缺 ${key}`).toContain(key)
    }
  })

  it('两种「排队」的判据（serviceAvailable）在两份 README 里都说清', () => {
    // issue #29 第四节的核心：`isQueued: true` 有两种形态，用户对它们的行动
    // 指导完全不同。不写出来的读者会去换 PAT —— 而换 PAT 没用。
    for (const doc of [zh, en]) {
      expect(doc).toContain('serviceAvailable')
      // 两个形态都要写出来，光提字段名不够。
      expect(doc).toMatch(/serviceAvailable\s*[:：|]\s*true/)
      expect(doc).toMatch(/serviceAvailable\s*[:：|]\s*false/)
    }
  })

  it('「queueWaitMs 是 0 时关掉」在两份 README 里都写明', () => {
    // 0 的含义与另外三个键**不同**（那几个是「跟随宿主默认」，这个是「关掉」）。
    // 混为一谈会让用户以为配 0 是「用宿主默认」，于是关不掉这个功能。
    expect(zh).toMatch(/queueWaitMs[\s\S]{0,80}?0\s*=\s*关掉|0 = 关掉/)
    expect(en).toMatch(/queueWaitMs[\s\S]{0,120}?0\s*=\s*off|0 = turn/)
  })

  it('两份 README 的「重试预算」一节都在，且都提到 issue #29', () => {
    // issue 编号是读者报新问题时的引用锚点 —— 它把「这个现象已经被处理过」
    // 这件事写在了文档里。
    expect(zh).toContain('issue #29')
    expect(en).toContain('issue #29')
  })
})
