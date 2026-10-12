/**
 * CLI 子命令分发（`dsh-connect-qoder doctor|status|logout`）。
 *
 * 这一段曾经**从未真正跑起来过**：`main()` 过滤 argv 的末项写成了
 * `REGION_KEYS.includes(arg)`（只保留 cn / global），于是命令词本身被过滤掉，
 * `command` 恒为 undefined，三条子命令全都只会打印 usage 然后退出。
 * 而 `src/bin.ts` 此前**没有任何测试文件**，所以这个 bug 一路存活。
 *
 * 这里只测纯函数 `commandArgOf`（分发规则的唯一实现），不启真进程。
 */

import { describe, expect, it } from 'vitest'
import { commandArgOf } from '../src/bin.ts'

describe('commandArgOf', () => {
  it('takes the command word on its own', () => {
    expect(commandArgOf(['doctor'])).toBe('doctor')
    expect(commandArgOf(['status'])).toBe('status')
    expect(commandArgOf(['logout'])).toBe('logout')
  })

  it('ignores --json anywhere in the argument list', () => {
    expect(commandArgOf(['doctor', '--json'])).toBe('doctor')
    expect(commandArgOf(['--json', 'status'])).toBe('status')
  })

  it('ignores the region flag and its value', () => {
    expect(commandArgOf(['--region', 'cn', 'doctor'])).toBe('doctor')
    expect(commandArgOf(['doctor', '--region', 'global', '--json'])).toBe('doctor')
  })

  it('is undefined when only flags and region values are given', () => {
    expect(commandArgOf([])).toBeUndefined()
    expect(commandArgOf(['--json'])).toBeUndefined()
    expect(commandArgOf(['--region', 'global'])).toBeUndefined()
    // 裸区域名也不是命令词。
    expect(commandArgOf(['cn'])).toBeUndefined()
  })

  it('REGRESSION: a command word must not be filtered out (the old bug)', () => {
    // 旧实现的等价写法只留 cn/global —— 它把 'doctor' 自己过滤掉了。
    const legacyFilter = (argv: readonly string[]): string | undefined =>
      argv.filter(arg => arg !== '--json' && arg !== '--region' && ['cn', 'global'].includes(arg))[0]
    expect(legacyFilter(['doctor'])).toBeUndefined()   // 旧实现：命令词消失
    expect(commandArgOf(['doctor'])).toBe('doctor')    // 新实现：命令词保留
  })
})
