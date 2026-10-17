/**
 * `piAiRuntimeInfo()` consistency.
 *
 * The whole #24/#25/#26 fix hinges on one question — which pi-ai copy does
 * THIS plugin resolve — and the answer must be self-consistent: the reported
 * generation has to follow the version of the manifest owning the reported
 * path, the path has to be the one Node actually resolves, and a market-style
 * install (no local pi-ai at all) must report host-provided WITHOUT crashing
 * the standalone CLI — which is why the detection deliberately never imports
 * pi-ai. These tests do NOT pin a version number: this checkout resolves
 * 0.85.1 today, but the peer range admits anything below 0.88, and the point
 * of the gate is to FOLLOW the resolution, not to freeze it.
 */

import { describe, expect, it } from 'vitest'
import { generationOf, piAiRuntimeFor, piAiRuntimeInfo } from '../src/pi-ai-runtime.ts'

describe('piAiRuntimeFor (the branch that only runs on other machines)', () => {
  it('reports host-provided and defaults to the modern gate when nothing resolves', () => {
    // A market install probed outside the host: no local pi-ai at all. Inside
    // DSH the host supplies it, and hosts that normalize (0.2.0+) ship 0.87.1
    // — so the pass-through branch is the correct default, and it is also
    // harmless on older hosts, whose native 0.85 shape is an identity under
    // either branch.
    const info = piAiRuntimeFor(undefined)
    expect(info.generation).toBe('modern')
    expect(info.resolvedLocally).toBe(false)
    expect(info.version).toBeUndefined()
    expect(info.resolvedFrom).toBeUndefined()
  })

  it('decides the generation from the manifest beside the resolved entry', () => {
    const modern = piAiRuntimeFor('/nonexistent/pi-ai/dist/index.js')
    // No readable manifest there: conservatively legacy, and resolvedLocally
    // still true so doctor can show the path it tried.
    expect(modern.resolvedLocally).toBe(true)
    expect(modern.generation).toBe('legacy')
    expect(modern.version).toBeUndefined()
    expect(modern.resolvedFrom).toBe('/nonexistent/pi-ai/dist/index.js')
  })
})

/**
 * The version → generation table, asserted DIRECTLY.
 *
 * 这条是 0.2.1-rc.1 回归的根因守卫。旧表只认 `/^0\.(\d+)\./`，于是 `1.x.y`
 * **一条都匹配不上**、一律落到 `legacy`；适配器随即把 pi-ai 已经归一化好的
 * transcript 逆折叠回 0.85 的扁平形状，交给只读 `messages` 的 1.x api ——
 * 线上请求**没有系统提示词、没有工具声明**，且不报错。
 *
 * 旧版那条用例把同一个错误公式（`minor >= 87`）又抄了一遍，`1.3.0` 算出
 * `NaN >= 87 === false` 于是断言 `legacy` —— 它**认证**了这个缺陷而不是发现它。
 * 所以这里改写成对**已知语义**的显式表，不再从版本号现推公式。
 */
describe('generationOf — the version table', () => {
  it('classifies the 0.85 line as legacy (flat {systemPrompt, tools, messages})', () => {
    expect(generationOf('0.85.0')).toBe('legacy')
    expect(generationOf('0.85.1')).toBe('legacy')
    expect(generationOf('0.86.9')).toBe('legacy')
  })

  it('classifies 0.87+ as modern', () => {
    expect(generationOf('0.87.0')).toBe('modern')
    expect(generationOf('0.87.1')).toBe('modern')
  })

  it('classifies EVERY 1.x as modern — the 0.2.1-rc.1 regression', () => {
    // 1.x 在 **Models 层**（createModels().stream* → normalizeContext）归一化，
    // 位于宿主与 api 模块之间，api 拿到的仍是归一化 transcript。对插件而言
    // 能力相同，因此是 modern。旧实现在这里全部返回 legacy。
    for (const version of ['1.0.0', '1.0.2', '1.1.0', '1.3.0', '1.10.4']) {
      expect(generationOf(version), `${version} must be modern`).toBe('modern')
    }
  })

  it('treats an unreadable or missing version as legacy (visible, not silent)', () => {
    expect(generationOf(undefined)).toBe('legacy')
    expect(generationOf('')).toBe('legacy')
    expect(generationOf('not-a-version')).toBe('legacy')
  })

  it('never lets a prerelease/two-part string slip through as modern by accident', () => {
    // 两段式 `1.1` 不是合法 semver 清单版本；保守 legacy 比误判 modern 安全。
    expect(generationOf('1.1')).toBe('legacy')
    // 预发布不影响主次版本判定：`1.1.0-beta.1` 仍是 1.x。
    expect(generationOf('1.1.0-beta.1')).toBe('modern')
    // 0.87 的预发布同样是 modern。
    expect(generationOf('0.87.1-rc.1')).toBe('modern')
  })
})

describe('piAiRuntimeInfo', () => {
  it('reports the generation of the resolved manifest version', () => {
    const info = piAiRuntimeInfo()
    if (info.resolvedLocally && info.version !== undefined) {
      // 与 generationOf 同源，且**不再从版本号现推公式**（那正是上一版
      // 把 `1.x → legacy` 写进断言的方式）。
      expect(info.generation).toBe(generationOf(info.version))
    }
  })

  it('reports the file Node resolves for the bare specifier', () => {
    const info = piAiRuntimeInfo()
    expect(info.resolvedLocally).toBe(true)
    expect(info.resolvedFrom).toContain('pi-ai')
    expect(info.resolvedFrom).toMatch(/\.js$/u)
  })

  it('reads the version from the manifest owning the resolved file', () => {
    const info = piAiRuntimeInfo()
    if (!info.resolvedLocally) return
    // Within the peer range every release spells its version 0.<minor>.<patch>;
    // anything else means the wrong manifest was read (for instance a
    // virtual-store parent's package.json).
    expect(info.version).toMatch(/^0\.(8[5-7])\.\d+/u)
  })

  it('is stable across calls (resolved once, then cached)', () => {
    expect(piAiRuntimeInfo()).toBe(piAiRuntimeInfo())
  })
})