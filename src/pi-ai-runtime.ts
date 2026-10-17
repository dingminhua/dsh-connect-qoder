/**
 * Which `@earendil-works/pi-ai` copy THIS plugin actually resolves at runtime.
 *
 * 参考：dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）的同名模块
 * 改动：纯改名移植（workbuddy → qoder，模块 doc 提及），检测机制与决策表原样沿用。
 *
 * WHY THIS EXISTS (issues #24 / #25 / #26, and the 0.2.1-rc.1 regression).
 * The plugin declares pi-ai as a peer (`>=0.85.0 <0.88.0 || >=1.0.0 <2.0.0`),
 * so the module it imports is whatever the host environment provides — and the
 * two generations consume DIFFERENT context shapes:
 *
 * - **modern** (0.87 … 1.x) hands providers a normalized transcript:
 *   `{ messages: [ {role:'system', content, toolsAdded}, … ] }`. The system
 *   prompt and the tool declarations live ONLY on that leading system message;
 *   the top-level `systemPrompt` / `tools` fields are gone, and the api module
 *   never reads them back. In 0.87 this normalization happens inside the api
 *   modules; from 0.87/1.x it happens one layer up, in pi-ai's **Models layer**
 *   (`createModels().stream*` → `normalizeContext`), which sits between the
 *   host and the api module. Either way the api sees a transcript.
 * - **legacy** (0.85) expects `{ systemPrompt, tools, messages }` and has no
 *   branch for a `system` message inside `messages` at all: its token
 *   estimator crashes on one (issue #24), and its wire converter silently
 *   drops it.
 *
 * Which copy resolves is NOT predictable from the host version alone: a
 * nested 0.85.1 on disk shadows the host's 0.87.1 (the plugin author's own
 * symlinked checkout does exactly that), while a clean market install has no
 * local copy at all and resolves the host's (issue #26's reporter). The
 * adapter therefore gates on what THIS plugin resolves.
 *
 * HOW it is detected — deliberately WITHOUT importing pi-ai:
 * `import.meta.resolve` locates the entry file (executing nothing), the
 * package manifest sitting beside it names the version, and the generation is
 * decided from that version (0.87+ **and every 1.x** → modern; see
 * {@link generationOf}, whose failure to handle the 1.x major was the
 * 0.2.1-rc.1 regression). A static import would drag
 * pi-ai into the standalone `doctor` CLI, which must also run from market
 * installs where NO local pi-ai exists and the module is only provided inside
 * the DSH host — a static import there is a load-time crash. Resolution
 * itself does not need the module: within the peer range, the manifest
 * version and the `normalizeContext` feature (present from 0.87 on, not
 * before) agree.
 *
 * When resolution FAILS — the normal state of a market install probed outside
 * the host — there is no local copy, so inside DSH the host supplies pi-ai.
 * Every DSH host that normalizes contexts (0.2.0+ ships 0.87.1; 0.2.1 ships
 * pi-ai 1.x) supplies a self-normalizing pi-ai, so the reported generation
 * defaults to `modern` (pass-through). That default is safe on older hosts
 * too: they never normalize, and a native 0.85-shaped context is an identity
 * under BOTH branches of the adapter gate.
 *
 * `doctor` prints the resolved version and path so mixed-generation setups —
 * the silent kind that produced #24 and #26 — become visible on demand.
 *
 * @module dsh-connect-qoder/pi-ai-runtime
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The resolved pi-ai generation, by context-shape capability. */
export type PiAiGeneration = 'modern' | 'legacy'

/** What {@link piAiRuntimeInfo} reports about the resolved pi-ai copy. */
export interface PiAiRuntimeInfo {
  /** `modern` (0.87+: consumes normalized transcripts natively) or `legacy` (0.85 shape). */
  generation: PiAiGeneration
  /** Version of the resolved copy, when the manifest could be read. */
  version: string | undefined
  /** File the bare `@earendil-works/pi-ai` specifier resolved to. */
  resolvedFrom: string | undefined
  /**
   * Whether pi-ai resolves from the plugin's own path. `false` is the normal
   * state of a market install probed OUTSIDE the DSH host: no local copy
   * exists, and the host supplies the module at plugin runtime. Inside the
   * host this stays `true` whenever a local copy exists, because a nested
   * copy shadows host injection (that shadowing is what issue #24 proved).
   */
  resolvedLocally: boolean
}

let cached: PiAiRuntimeInfo | undefined

/** Resolve (once) which pi-ai copy this plugin runs against. */
export function piAiRuntimeInfo(): PiAiRuntimeInfo {
  cached ??= piAiRuntimeFor(resolveModuleFile())
  return cached
}

/**
 * The decision table for one resolution result, exported so the branch that
 * only ever runs on OTHER machines (a market install with no local pi-ai) is
 * pinned by tests rather than by this comment.
 *
 * `undefined` means nothing local resolved — inside DSH the host supplies the
 * module, and every host that normalizes contexts (0.2.0+, via 0.87.1) ships
 * the modern generation, so that is the default. Older hosts never normalize,
 * and their native 0.85-shaped context is an identity under either gate
 * branch, so the default cannot hurt them.
 */
export function piAiRuntimeFor(resolvedFrom: string | undefined): PiAiRuntimeInfo {
  if (resolvedFrom === undefined) {
    return { generation: 'modern', resolvedFrom: undefined, version: undefined, resolvedLocally: false }
  }
  const version = readVersion(resolvedFrom)
  return { generation: generationOf(version), resolvedFrom, version, resolvedLocally: true }
}

/**
 * The file the main entry resolved to; undefined when resolution itself fails.
 *
 * `import.meta.resolve` (not `require.resolve`): pi-ai's exports map exposes
 * "." under the `import` condition only, so the CJS resolver refuses the bare
 * specifier outright — the ESM resolver is the one this plugin actually
 * imports with, so it is also the one whose answer is meaningful here.
 */
function resolveModuleFile(): string | undefined {
  try {
    return fileURLToPath(import.meta.resolve('@earendil-works/pi-ai'))
  } catch {
    return undefined
  }
}

/**
 * The version of the package owning `moduleFile`. pi-ai's exports map does
 * not expose `./package.json`, so the manifest is found by walking up from
 * the resolved entry — `dist/index.js` sits directly inside the package —
 * and claiming it only when its `name` matches, so a same-named ancestor
 * (a pnpm virtual-store parent, for instance) cannot be misread.
 */
function readVersion(moduleFile: string | undefined): string | undefined {
  if (moduleFile === undefined) return undefined
  let directory = dirname(moduleFile)
  for (let depth = 0; depth < 4; depth++) {
    try {
      const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: unknown, version?: unknown }
      if (parsed.name === '@earendil-works/pi-ai' && typeof parsed.version === 'string') return parsed.version
    } catch {
      // No manifest here (or not JSON): keep walking up.
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
  return undefined
}

/**
 * The generation a manifest version belongs to.
 *
 * The context-shape split is by CAPABILITY, and it moved twice:
 *
 * - `0.87.x` … `0.x` — normalizes contexts in its api modules (`0.87+`).
 * - `1.x` — normalizes in the **Models layer** (`createModels().stream*` →
 *   `normalizeContext`), which sits between the host and the api module. The
 *   provider-facing contract is the same normalized transcript, so 1.x is
 *   `modern` for this plugin's purposes.
 *
 * ⚠️ THE 1.x BRANCH IS THE 0.2.1-rc.1 REGRESSION. This function used to read
 * `/^0\.(\d+)\./` only, so any `1.x.y` failed to match and fell through to
 * `legacy`. The adapter then applied `adaptLegacyPiAiContext` to a transcript
 * that pi-ai had already normalized, and every request went upstream with NO
 * system prompt and NO tool declarations — silently (measured on the real
 * 0.2.1-rc.1 stack: `roles:["user"]`, `system:null`, `tools:0`).
 *
 * The guard that should have caught this did not: the old test recomputed the
 * SAME buggy formula (`minor >= 87`, which is `NaN >= 87 === false` for `1.x`)
 * and asserted `legacy`, so it certified the defect. The replacement asserts a
 * written-down version table instead of re-deriving it.
 *
 * A major version of 2 or more is unknown to this table, and an unreadable
 * version is unknown too. Both conservatively report `legacy`: the legacy
 * branch is the identity on an already-flat 0.85 context and its fold is a
 * no-op on a context that has no system message, so guessing `legacy` degrades
 * to "possibly a redundant fold" rather than "definitely drops the prompt".
 * `doctor` prints the resolved version so a guess is visible, not silent.
 */
export function generationOf(version: string | undefined): PiAiGeneration {
  if (version === undefined) return 'legacy'
  const match = /^(\d+)\.(\d+)\./u.exec(version)
  if (match === null) return 'legacy'
  const major = Number(match[1])
  const minor = Number(match[2])
  // 1.x+ consumes the normalized transcript, same as the 0.87 line.
  if (major >= 1) return 'modern'
  if (major === 0) return minor >= 87 ? 'modern' : 'legacy'
  return 'legacy'
}