import { describe, expect, it } from 'vitest'
import { poolErrorText, poolFailureText } from '../src/client/pool-state.ts'
import { qoderLocales, render } from '../src/client/locales.ts'

/**
 * 池批量请求失败时的**用户可见文案**（PR #7 移植 workbuddy #86 的那一半）。
 *
 * 为什么值得单独一个文件：`poolFailureText` 是「宿主进程在跑旧构建」与「插件
 * 自己拒绝了这个方法」这两种完全不同故障的**唯一分诊点**，而它此前一条测试
 * 都没有。分诊错了不会有任何报错，只会给用户指一条走不通的路 —— #86 的原始
 * 症状就是卡片说「请确认插件是最新版本」，而插件已经是最新的，真正该做的是
 * 重启 DSH。
 *
 * 两层断言（本仓 `tests/locales.spec.ts` 的既有纪律）：
 *  · `keyT` 钉住**选了哪个 key**（判据层）；
 *  · 真实 locale 表钉住**这句话读起来对不对**（文案层）—— key-preserving 的
 *    假翻译器永远说不出「这句话是不是在误导用户」。
 */

/** key-preserving 翻译器：断言里直接读出用了哪个 key。 */
const keyT = ((key: string) => key) as never

/** 真实中文文案渲染（与 `locales.spec.ts` 同源的做法）。 */
const zhText = (key: 'row.poolErrRouteMissing' | 'row.poolErrHttp', params?: Record<string, string>): string =>
  render(qoderLocales.zh[key], params ?? {})

describe('poolErrorText：结构化 reason 优先', () => {
  it('认识的 reason 各归各的 key', () => {
    expect(poolErrorText(keyT, 'no-members')).toBe('row.poolErrNoMembers')
    expect(poolErrorText(keyT, 'no-live-members')).toBe('row.poolErrNoLiveMembers')
    expect(poolErrorText(keyT, 'no-free-model')).toBe('row.poolErrNoFreeModel')
    expect(poolErrorText(keyT, 'target-model-stale')).toBe('row.poolErrStaleModel')
    expect(poolErrorText(keyT, 'checkin-unsupported')).toBe('row.poolErrNoCheckin')
    expect(poolErrorText(keyT, 'account-not-deletable')).toBe('row.poolErrNotDeletable')
    expect(poolErrorText(keyT, 'pool-unavailable')).toBe('row.poolErrUnavailable')
  })

  it('pool-failed 带上游原文；认不出的 reason 交给状态层', () => {
    expect(poolErrorText(keyT, 'pool-failed', 'boom')).toBe('row.poolErrFailed')
    expect(poolErrorText(keyT, 'whatever-else')).toBeUndefined()
    expect(poolErrorText(keyT, undefined)).toBeUndefined()
  })
})

describe('poolFailureText：405 要分清「路由未注册」与「方法不对」（workbuddy #86）', () => {
  it('响应体不可解析的 405 = 宿主在为一个从未注册的路由作答', () => {
    expect(poolFailureText(keyT, { status: 405, bodyUnreadable: true })).toBe('row.poolErrRouteMissing')
    // 文案层：必须指「重启应用」，并且必须**明确否定**「重装/升级插件」这条
    // 错误路径 —— #86 的教训正是旧文案把人引向了后者。
    const text = zhText('row.poolErrRouteMissing')
    expect(text).toContain('重启')
    expect(text).toContain('不要重装或升级')
    expect(text).not.toContain('请确认插件是最新版本')
  })

  it('以 JSON 作答的 405 仍是「方法不对」，不能被抢走', () => {
    // 插件自己的守卫是 `json(res, 405, {error:'method not allowed'})`，所以
    // 一个可解析的 body 意味着路由**存在**、这确实是方法不匹配。把两者混为一谈
    // 等于用一个正确的诊断换掉另一个。
    expect(poolFailureText(keyT, { status: 405, bodyUnreadable: false })).toBe('row.poolErrHttp')
    expect(poolFailureText(keyT, { status: 405 })).toBe('row.poolErrHttp')
  })

  it('只有 405 是「路由缺失」的指纹：别的状态没有 body 也照旧措辞', () => {
    // 客户端在这里只发 POST，未注册的路径只可能回 405。没有 body 的 500/502
    // 是真的服务端故障，必须保留自己的话术。
    expect(poolFailureText(keyT, { status: 500, bodyUnreadable: true })).toBe('row.poolErrHttp')
    expect(poolFailureText(keyT, { status: 502, bodyUnreadable: true })).toBe('row.poolErrHttp')
    expect(poolFailureText(keyT, { status: 404, bodyUnreadable: true })).toBe('row.poolErrHttp')
  })

  it('有结构化原因时仍然优先（未来的宿主可能同时给 reason）', () => {
    expect(poolFailureText(keyT, { status: 405, reason: 'no-members', bodyUnreadable: true }))
      .toBe('row.poolErrNoMembers')
  })

  it('上游自带的 error 原文优先于状态层，但不越结构化原因', () => {
    expect(poolFailureText(keyT, { status: 405, error: 'method not allowed' })).toBe('method not allowed')
    expect(poolFailureText(keyT, { status: 405, error: 'upstream said no', bodyUnreadable: true }))
      .toBe('upstream said no')
    // reason 命中时 error 只当 detail 用，措辞仍是本地化那句。
    expect(poolFailureText(keyT, { status: 405, reason: 'pool-unavailable', error: 'pool off' }))
      .toBe('row.poolErrUnavailable')
  })

  it('状态层带上状态码本身', () => {
    expect(zhText('row.poolErrHttp', { status: '502' })).toContain('502')
  })
})
