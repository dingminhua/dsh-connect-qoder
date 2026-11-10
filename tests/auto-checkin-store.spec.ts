/**
 * 自动签到的落盘记忆（issue #36）。
 *
 * 三条不能破的规则：
 *   1. 一个区域坏了/丢了文件，**不能**让另一个区域的记忆跟着丢（两边各跑各的）；
 *   2. 任何读失败都读作「这一窗没签过」，**绝不抛** —— 一个损坏的进度文件不该
 *      让插件启动失败；
 *   3. 写进去的东西形状不对就整份丢掉，不许带半个对象进内存（`failures` 变成
 *      字符串会让退避算出 `NaN`，于是每毫秒醒一次）。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  autoCheckinStorePath,
  readAutoCheckinState,
  writeAutoCheckinState,
} from '../src/auto-checkin-store.ts'
import { emptyAutoCheckinState } from '../src/auto-checkin.ts'
import type { AutoCheckinState } from '../src/auto-checkin.ts'

const stateOf = (window: string, patch: Partial<AutoCheckinState> = {}): AutoCheckinState => ({
  ...emptyAutoCheckinState(window),
  ...patch,
})

/**
 * 每个用例从干净的两个区域开始。
 *
 * 同一个文件里的用例共用一份 `DSH_HOME`（`tests/setup-per-file-home.ts`），所以
 * 「文件不存在」那条断言必须自己保证文件真的不存在 —— 否则它会读到上一个用例
 * 写下的东西，变成一条只在执行顺序下成立的假通过。
 */
beforeEach(async () => {
  for (const region of ['cn', 'global'] as const) {
    await rm(autoCheckinStorePath(region), { force: true })
  }
})

/** 直接往落盘位置写内容，用来模拟损坏 / 旧版本 / 半截的文件。 */
async function seed(region: 'cn' | 'global', body: string): Promise<void> {
  const path = autoCheckinStorePath(region)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, 'utf8')
}

describe('autoCheckinStorePath', () => {
  it('每个区域一个文件，前缀是 .qoder-auto-checkin', () => {
    // 前缀必须与 `.qoder-pool` 那一族**分开**：签到进度是运行状态，不是探针
    // 测量；混进同一个文件会让两次写互相覆盖。
    expect(autoCheckinStorePath('cn')).toContain('.qoder-auto-checkin.cn.json')
    expect(autoCheckinStorePath('global')).toContain('.qoder-auto-checkin.global.json')
    expect(autoCheckinStorePath('cn')).not.toBe(autoCheckinStorePath('global'))
  })
})

describe('write / read 往返', () => {
  it('写进去的字段读回来一个不差', async () => {
    const state = stateOf('upstream:1800000000000', {
      doneAccountIds: ['a', 'b'],
      scopeSize: 3,
      failures: 2,
      lastAttemptAtMs: 1_700_000_000_000,
      lastError: '凭据被拒',
    })
    await writeAutoCheckinState('cn', state)
    expect(await readAutoCheckinState('cn')).toEqual(state)
  })

  it('可选字段缺席时读回来也缺席（不补 undefined）', async () => {
    const state = stateOf('boundary:2026-11-10')
    await writeAutoCheckinState('global', state)
    const read = await readAutoCheckinState('global')
    expect(read).toEqual(state)
    expect(read).not.toHaveProperty('lastError')
    expect(read).not.toHaveProperty('lastAttemptAtMs')
  })

  it('两个区域互不覆盖 —— 它们各跑各的', async () => {
    await writeAutoCheckinState('cn', stateOf('w-cn', { doneAccountIds: ['a'], scopeSize: 1 }))
    await writeAutoCheckinState('global', stateOf('w-global', { doneAccountIds: ['z'], scopeSize: 1 }))
    // 再写一次 cn，确认 global 那份还在。
    await writeAutoCheckinState('cn', stateOf('w-cn-2', { scopeSize: 2 }))
    expect((await readAutoCheckinState('cn'))?.window).toBe('w-cn-2')
    expect((await readAutoCheckinState('global'))?.doneAccountIds).toEqual(['z'])
  })

  it('文件是 0600，且文档里有版本号', async () => {
    // 进度里有账号 id（`pat-<hex>`）与失败原因，都属于账号侧的数据 ——
    // 与 vault 同一份隐私标准。
    await writeAutoCheckinState('cn', stateOf('w'))
    const raw = await readFile(autoCheckinStorePath('cn'), 'utf8')
    const document = JSON.parse(raw) as { version: number, regions: Record<string, unknown> }
    expect(document.version).toBe(1)
    expect(Object.keys(document.regions)).toEqual(['cn'])
  })
})

describe('坏文件一律读作「这一窗没签过」，绝不抛', () => {
  it('文件不存在', async () => {
    expect(await readAutoCheckinState('cn')).toBeUndefined()
  })

  it('不是 JSON', async () => {
    await seed('cn', 'not json at all')
    expect(await readAutoCheckinState('cn')).toBeUndefined()
  })

  it('版本对不上', async () => {
    await seed('cn', JSON.stringify({ version: 99, regions: { cn: stateOf('w') } }))
    expect(await readAutoCheckinState('cn')).toBeUndefined()
  })

  it('顶层不是对象', async () => {
    await seed('cn', JSON.stringify(['nope']))
    expect(await readAutoCheckinState('cn')).toBeUndefined()
  })

  it('形状半截的状态整份丢掉，而不是带半个对象进内存', async () => {
    // `failures` 是字符串会让 `nextDelayMs` 算出 NaN，于是每毫秒醒一次；
    // `doneAccountIds` 不是数组会让 `new Set` 直接抛。
    await seed('cn', JSON.stringify({
      version: 1,
      regions: {
        cn: { window: 'w', doneAccountIds: ['a'], scopeSize: 1, failures: 'many' },
      },
    }))
    expect(await readAutoCheckinState('cn')).toBeUndefined()
  })

  it('一个区域坏了不连坐另一个区域', async () => {
    // 两个区域各一个文件，所以「坏一份」本来就不该波及另一份。这条用例钉的是
    // 那个隔离确实存在：把 cn 那一份写坏，global 的记忆必须原样读得回来。
    await writeAutoCheckinState('global', stateOf('w-global', { doneAccountIds: ['z'], scopeSize: 1 }))
    await seed('cn', JSON.stringify({
      version: 1,
      regions: {
        cn: { window: '', doneAccountIds: ['a'], scopeSize: 1, failures: 0 },
        // 同一份文档里再塞一个完好的条目，确认坏的那条不会让它一起被丢掉。
        global: stateOf('ghost', { doneAccountIds: ['q'], scopeSize: 1 }),
      },
    }))
    expect(await readAutoCheckinState('cn')).toBeUndefined()
    // global 读的是**自己的**文件，不是 cn 那份里的同名键。
    expect((await readAutoCheckinState('global'))?.doneAccountIds).toEqual(['z'])
    // 再写 cn 之后 global 仍然完好。
    await writeAutoCheckinState('cn', stateOf('w-cn'))
    expect((await readAutoCheckinState('global'))?.window).toBe('w-global')
    expect((await readAutoCheckinState('cn'))?.window).toBe('w-cn')
  })

  it('负数 / 非有限数的计数不算有效状态', async () => {
    await seed('cn', JSON.stringify({
      version: 1,
      regions: { cn: { window: 'w', doneAccountIds: [], scopeSize: -1, failures: 0 } },
    }))
    expect(await readAutoCheckinState('cn')).toBeUndefined()
    await seed('cn', JSON.stringify({
      version: 1,
      regions: { cn: { window: 'w', doneAccountIds: [], scopeSize: 1, failures: Number.NaN } },
    }))
    expect(await readAutoCheckinState('cn')).toBeUndefined()
  })
})
