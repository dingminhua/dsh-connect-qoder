// @vitest-environment jsdom
/**
 * AddAccount 渲染：PAT 入口那一行的就地说明。
 *
 * 用户要求：「添加 PAT 后添加文本（登录网页 qoder.com / qoder.com.cn → 服务集成
 * → 新建令牌），国际国内域名不同」——说明要写在入口这一行，且域名逐区域正确。
 */
import * as React from 'react'
import { act as actFromReact } from 'react'
import { act as actTestUtils } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { AddAccount } from '../src/client/AddAccount.tsx'
import { QODER_CONSOLE_DOMAIN } from '../src/status-paths.ts'
import type { QoderWebRegion } from '../src/status-paths.ts'

const act: typeof actFromReact = ((React as unknown as { act?: typeof actFromReact }).act ?? actTestUtils) as typeof actFromReact
declare global { var IS_REACT_ACT_ENVIRONMENT: boolean | undefined }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** 保留参数的 t mock：断言拿得到实际传入的域名。 */
const t = ((key: string, params?: Record<string, unknown>): string =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`) as never

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
  if (root !== undefined) await act(async () => { root!.unmount() })
  container?.remove()
  root = undefined
  container = undefined
})

async function mount(region: QoderWebRegion): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(React.createElement(AddAccount as never, { t, region }))
  })
  return container
}

describe('AddAccount：PAT 入口的就地说明', () => {
  it('国内版指向 qoder.com.cn', async () => {
    const el = await mount('cn')
    const hint = el.querySelector('.dsm-qoder-bar-hint')
    expect(hint).not.toBeNull()
    expect(hint!.textContent).toContain('qoder.com.cn')
  })

  it('国际版指向 qoder.com（不是网关用的 qoder.sh）', async () => {
    const el = await mount('global')
    const hint = el.querySelector('.dsm-qoder-bar-hint')
    expect(hint).not.toBeNull()
    expect(hint!.textContent).toContain('qoder.com')
    // 用户在浏览器里看到的是控制台域名，不是网关域名。
    expect(hint!.textContent).not.toContain('qoder.sh')
  })

  it('说明排在「添加 PAT」标签之后、按钮之前（同一行）', async () => {
    const el = await mount('cn')
    const bar = el.querySelector('.dsm-qoder-bar')!
    const order = Array.from(bar.children).map(child => child.className)
    expect(order.indexOf('dsm-qoder-bar-label')).toBeLessThan(order.indexOf('dsm-qoder-bar-hint'))
    expect(order.indexOf('dsm-qoder-bar-hint')).toBeLessThan(order.indexOf('dsm-qoder-bar-actions'))
  })

  it('域名表逐区域都有值（防两处域名漂移）', () => {
    expect(QODER_CONSOLE_DOMAIN.cn).toBe('qoder.com.cn')
    expect(QODER_CONSOLE_DOMAIN.global).toBe('qoder.com')
  })
})
