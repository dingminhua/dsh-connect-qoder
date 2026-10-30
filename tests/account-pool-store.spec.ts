/**
 * Qoder 账号池运行时存储：readPoolProbes / writePoolProbes 的落盘与合并语义。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   `tests/account-pool-store.spec.ts` —— 行为沿用：按区域分文件、读写合并
 *   而非替换、损坏/缺文件/版本不符一律读成空、读写绝不抛异常给调用方。
 *   差异仅文件名前缀（`.qoder-pool.<region>.json`）。`vitest.config.ts` 已把
 *   `$DSH_HOME` 指向隔离目录，且 `setup-per-file-home.ts` 再为每个文件单独
 *   换一次 home，因此这些测试绝不碰真实 profile。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  qoderPoolStorePath,
  readPoolProbes,
  writePoolProbes,
} from '../src/account-pool-store.ts'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

let home: string
let previousHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'qoder-pool-'))
  previousHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
})
afterEach(async () => {
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  await rm(home, { force: true, recursive: true })
})

describe('qoderPoolStorePath', () => {
  it('keys the file by region so the two pools never share measurements', () => {
    expect(qoderPoolStorePath('cn')).not.toBe(qoderPoolStorePath('global'))
    expect(qoderPoolStorePath('cn')).toContain('.qoder-pool.cn.json')
    expect(qoderPoolStorePath('global')).toContain('.qoder-pool.global.json')
  })

  it('names the file from the isolated DSH home', () => {
    expect(qoderPoolStorePath('cn')).toContain(join(resolveDshHome(), '.qoder-pool.cn.json'))
  })
})

describe('readPoolProbes', () => {
  it('reads nothing when the file is absent', async () => {
    expect(await readPoolProbes('cn')).toEqual({})
  })

  it('round-trips a written measurement', async () => {
    await writePoolProbes('cn', {
      alpha: { outcome: 'ok', atMs: 1_800_000_000_000 },
      beta: { outcome: 'rate-limited', atMs: 1_800_000_000_000, retryAtMs: 1_800_000_600_000 },
    })
    const probes = await readPoolProbes('cn')
    expect(probes['alpha']).toEqual({ outcome: 'ok', atMs: 1_800_000_000_000 })
    expect(probes['beta']?.retryAtMs).toBe(1_800_000_600_000)
  })

  it('round-trips the failure message, so the card can name the reason', async () => {
    await writePoolProbes('cn', {
      alpha: { outcome: 'unavailable', atMs: 7, message: 'transport error: AbortError' },
    })
    expect((await readPoolProbes('cn'))['alpha']?.message).toBe('transport error: AbortError')
  })

  it('treats a missing message as a complete record, not a corrupt one', async () => {
    // 字段加入前写下的测量必须仍可读；把缺失读成损毁会悄悄抹掉真实观测。
    await writePoolProbes('cn', { alpha: { outcome: 'ok', atMs: 1 } })
    const raw = JSON.parse(await readFile(qoderPoolStorePath('cn'), 'utf8')) as {
      probes: Record<string, Record<string, unknown>>
    }
    expect(raw.probes['alpha']).not.toHaveProperty('message')
    const probes = await readPoolProbes('cn')
    expect(probes['alpha']).toEqual({ outcome: 'ok', atMs: 1 })
  })

  it('keeps the two regions fully separate', async () => {
    await writePoolProbes('cn', { alpha: { outcome: 'ok', atMs: 1 } })
    expect(await readPoolProbes('global')).toEqual({})
  })

  it('merges rather than replacing, so a partial batch keeps earlier results', async () => {
    await writePoolProbes('cn', { alpha: { outcome: 'ok', atMs: 1 } })
    await writePoolProbes('cn', { beta: { outcome: 'out-of-credit', atMs: 2 } })
    const probes = await readPoolProbes('cn')
    expect(Object.keys(probes).sort()).toEqual(['alpha', 'beta'])
  })

  it('overwrites one account without disturbing the others', async () => {
    await writePoolProbes('cn', {
      alpha: { outcome: 'ok', atMs: 1 },
      beta: { outcome: 'ok', atMs: 1 },
    })
    await writePoolProbes('cn', { alpha: { outcome: 'rate-limited', atMs: 9 } })
    const probes = await readPoolProbes('cn')
    expect(probes['alpha']?.atMs).toBe(9)
    expect(probes['beta']?.atMs).toBe(1)
  })

  it('writes nothing for an empty update', async () => {
    await writePoolProbes('cn', {})
    await expect(readFile(qoderPoolStorePath('cn'), 'utf8')).rejects.toThrow()
  })

  it('contains no token material', async () => {
    await writePoolProbes('cn', { alpha: { outcome: 'ok', atMs: 1 } })
    const raw = await readFile(qoderPoolStorePath('cn'), 'utf8')
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]+\./u)
    expect(raw).not.toContain('accessToken')
    expect(raw).not.toContain('pt-')
  })

  it('survives a corrupt file by reporting nothing measured', async () => {
    await writeFile(qoderPoolStorePath('cn'), '{ not json', 'utf8')
    expect(await readPoolProbes('cn')).toEqual({})
  })

  it('ignores a document from an unknown format version', async () => {
    await writeFile(
      qoderPoolStorePath('cn'),
      JSON.stringify({ version: 99, probes: { alpha: { outcome: 'ok', atMs: 1 } } }),
      'utf8',
    )
    expect(await readPoolProbes('cn')).toEqual({})
  })

  it('skips individual malformed rows without discarding the good ones', async () => {
    await writeFile(
      qoderPoolStorePath('cn'),
      JSON.stringify({
        version: 1,
        probes: {
          good: { outcome: 'ok', atMs: 1 },
          bad: { outcome: 'ok' },
          worse: 'nonsense',
          '': { outcome: 'ok', atMs: 3 },
        },
      }),
      'utf8',
    )
    expect(Object.keys(await readPoolProbes('cn'))).toEqual(['good'])
  })

  it('round-trips the writer, so a record can say what produced it', async () => {
    await writePoolProbes('cn', { alpha: { outcome: 'ok', atMs: 1, source: 'test-batch' } })
    expect((await readPoolProbes('cn'))['alpha']).toEqual({ outcome: 'ok', atMs: 1, source: 'test-batch' })
  })

  it('preserves a measurement whose source label is one this build does not know', async () => {
    // 更新的 build 可能写出第三种 source；丢弃整条记录会悄悄丢掉真实测量。测量
    // 保留，只有不认识的 label 被丢掉。
    await writeFile(
      qoderPoolStorePath('cn'),
      JSON.stringify({
        version: 1,
        probes: { alpha: { outcome: 'rate-limited', atMs: 5, source: 'some-future-writer' } },
      }),
      'utf8',
    )
    const probes = await readPoolProbes('cn')
    expect(probes['alpha']?.outcome).toBe('rate-limited')
    expect(probes['alpha']?.atMs).toBe(5)
    expect(probes['alpha']?.source).toBeUndefined()
  })

  it('never throws when the write target is unusable', async () => {
    // 写失败只丢最新几条测量；批量结果本身仍有效，不应被持久化搞成错误。
    process.env['DSH_HOME'] = join(home, 'a-file-not-a-directory')
    await writeFile(process.env['DSH_HOME'], 'x', 'utf8')
    await expect(writePoolProbes('cn', { alpha: { outcome: 'ok', atMs: 1 } })).resolves.toBeUndefined()
  })
})
// ==========================================================================
// issue #26：排队信息要能落盘、也要能被读回来
//
// 上游说「排在第 1027 位」是要显示给人看的，落在磁盘上的那条测量里也得带着它
// —— 否则进程重启后卡片就退回「上游未给出」。
// ==========================================================================
describe('issue #26：排队信息的落盘往返', () => {
  it('写进去再读出来，排队人数与队列分档都还在', async () => {
    await writePoolProbes('global', {
      alpha: {
        outcome: 'queued',
        atMs: 1_800_000_000_000,
        retryAtMs: 1_800_000_030_000,
        modelId: 'dfmodel',
        queue: { queueCount: 1027, queueType: 'p3' },
      },
    })
    const probes = await readPoolProbes('global')
    expect(probes['alpha']?.queue).toEqual({ queueCount: 1027, queueType: 'p3' })
    expect(probes['alpha']?.retryAtMs).toBe(1_800_000_030_000)
    expect(probes['alpha']?.outcome).toBe('queued')
  })

  it('形状不对的排队信息被整个丢掉，不留半个对象', async () => {
    await writePoolProbes('cn', {
      alpha: { outcome: 'queued', atMs: 1_800_000_000_000, queue: { queueCount: 'many' } as never },
    })
    const probes = await readPoolProbes('cn')
    // `queueCount` 不是数字 ⇒ 丢掉这一项；没有任何可留的字段 ⇒ 整个 queue 丢弃。
    expect(probes['alpha']?.queue).toBeUndefined()
  })
})
