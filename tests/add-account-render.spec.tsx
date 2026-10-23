// @vitest-environment jsdom
/**
 * AddAccount 渲染：PAT 入口的工具栏与对话框分工。
 *
 * 历史：这条路径说明（登录网页 {domain} → 服务集成 → 新建令牌）最初被要求写在
 * **入口那一行**。后来对着实拍截图改口——它只在「准备粘贴」那一刻有用，常驻却
 * 占掉一整行，还与对话框里同话题的「如何创建 PAT?」分居两处，读起来像两件事。
 * 现在搬进对话框，与那支外链合成一块。
 *
 * 本文件钉两件事：打开之前一个字也不显示；打开之后，出处与文档在同一个块里，
 * 且域名逐区域正确。
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

/** 打开对话框：这颗按钮是 bar 上唯一的入口。 */
async function mountOpen(region: QoderWebRegion): Promise<HTMLElement> {
  const el = await mount(region)
  const button = el.querySelector<HTMLButtonElement>('.dsm-qoder-bar-actions button')
  expect(button).not.toBeNull()
  await act(async () => { button!.click() })
  return el
}

describe('AddAccount：PAT 出处说明住在对话框里', () => {
  it('打开之前，入口那一行不显示任何域名——说明只在要粘贴时才有用', async () => {
    const el = await mount('cn')
    // bar 上只剩状态位与按钮；常驻说明的类名没有渲染者了。
    expect(el.querySelector('.dsm-qoder-bar-hint')).toBeNull()
    expect(el.textContent).not.toContain('qoder.com.cn')
    expect(el.querySelector('.dsm-qoder-addpat-origin')).toBeNull()
  })

  it('对话框里给出路径与文档入口，两者在同一个块内', async () => {
    const el = await mountOpen('cn')
    const origin = el.querySelector('.dsm-qoder-addpat-origin')
    expect(origin).not.toBeNull()
    // 路径：逐区域域名由 region 决定。
    expect(origin!.textContent).toContain('qoder.com.cn')
    expect(origin!.textContent).toContain('row.addAccountPatHint')
    // 文档入口在同一块里：同一个问题（去哪拿 token）的文字答案与外链答案。
    const link = origin!.querySelector('a')
    expect(link).not.toBeNull()
    expect(link!.textContent).toBe('row.docsHint')
  })

  it('国际版指向 qoder.com（不是网关用的 qoder.sh）', async () => {
    const el = await mountOpen('global')
    const origin = el.querySelector('.dsm-qoder-addpat-origin')
    expect(origin).not.toBeNull()
    expect(origin!.textContent).toContain('qoder.com')
    // 用户在浏览器里看到的是控制台域名，不是网关域名。
    expect(origin!.textContent).not.toContain('qoder.sh')
  })

  it('对话框内的顺序：输入 → 出处块 → 验证说明 → 按钮', async () => {
    const el = await mountOpen('cn')
    const dialog = el.querySelector('.dsm-qoder-transfer-dialog')!
    const order = Array.from(dialog.children).map(child => child.className)
    const at = (cls: string): number => order.indexOf(cls)
    // 两个输入在前：用户先看到「要填什么」。
    expect(at('dsm-qoder-addpat-input')).toBeLessThan(at('dsm-qoder-addpat-origin'))
    expect(at('dsm-qoder-addpat-name')).toBeLessThan(at('dsm-qoder-addpat-origin'))
    // 出处块在验证说明之前：先回答「token 去哪拿」，再回答「按下去会怎样」。
    expect(at('dsm-qoder-addpat-origin')).toBeLessThan(at('dsm-qoder-addpat-verify'))
    // 验证说明紧贴按钮：它描述的正是那次点击。
    expect(at('dsm-qoder-addpat-verify')).toBeLessThan(at('dsm-qoder-transfer-dialog-actions'))
  })

  it('域名表逐区域都有值（防两处域名漂移）', () => {
    expect(QODER_CONSOLE_DOMAIN.cn).toBe('qoder.com.cn')
    expect(QODER_CONSOLE_DOMAIN.global).toBe('qoder.com')
  })
})
