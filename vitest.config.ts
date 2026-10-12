import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 测试绝不能碰真实的 DSH home。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 同款隔离。本插件会在 `$DSH_HOME` 下写宿主心跳、vault 账号文件与账号池
 *   测量文件；污染开发者真实 profile（或被文件沙箱拦下）都会让结果失去意义。
 */
const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-connect-qoder-test-'))

/**
 * 由 home 派生的路径也必须隔离，而不只是 `DSH_HOME`。
 *
 * `HOME` / `USERPROFILE` 覆盖 `os.homedir()`（POSIX vs Windows），
 * `LOCALAPPDATA` / `APPDATA` 覆盖 Windows 分支，`XDG_CONFIG_HOME` 覆盖 Linux
 * 分支。即使在用不到它们的平台上也都设上，让同一份配置服务所有 runner ——
 * 这样「环境里恰好有什么账号」这类环境依赖的假通过，会变成真正的断言。
 */
const isolatedEnv = {
  DSH_HOME: isolatedHome,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  LOCALAPPDATA: join(isolatedHome, 'AppData', 'Local'),
  APPDATA: join(isolatedHome, 'AppData', 'Roaming'),
  XDG_CONFIG_HOME: join(isolatedHome, '.config'),
}

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup-per-file-home.ts'],
    // `.tsx` entries are component tests that mount the real QoderCard under
    // jsdom (see tests/card-render.spec.tsx). They opt into the DOM via a
    // `@vitest-environment jsdom` docblock so every other file stays on the
    // plain node environment — jsdom is a dev-only dependency and must never
    // leak a `window` into tests that assert host-side behaviour.
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'node',
    env: isolatedEnv,
    // Windows runner 冷启动 PowerShell 很慢（host-heartbeat 的
    // `processStartTimeMs` 在 Windows 上会 shell out），给心跳测试留足余量；
    // macOS/Linux 上每个用例仍远快于 1 秒。
    testTimeout: 30_000,
  },
})
