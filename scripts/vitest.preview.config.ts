import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/**
 * 只给 `scripts/*.preview.tsx` 用的配置：**不进 `pnpm test`**。
 *
 * 它存在的原因：视觉复核要跑真实的 `QoderCard.tsx`，而那个文件是 TSX，纯 node
 * 跑不了（`ERR_UNKNOWN_FILE_EXTENSION`）。vitest 手里已经有转换器与 jsdom，
 * 借它跑一次即可——但绝不能把这份配置并进主配置，否则每次 `pnpm test` 都会去
 * 截图、去依赖本机 Chrome。
 *
 * 目前装了两件事：
 *   - `panels.preview.tsx`：三栏各自截图，人工复核分栏排版；
 *   - `model-list-layout.preview.tsx`：借 Chrome 量模型栏的真实布局，
 *     钉住「全部模型都排出来、列表不自己滚动」（jsdom 不做布局，量不出滚动条）。
 *
 * 用法：
 *   pnpm run preview:client
 *   npx vitest run --config scripts/vitest.preview.config.ts -t 滚动
 */
const PACKAGE = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string, version: string }

export default defineConfig({
  // 与 `vitest.config.ts` 同一组构建期常量：`version.ts` 与槽位键都读它们。
  define: {
    __DSH_QODER_VERSION__: JSON.stringify(PACKAGE.version),
    __DSH_QODER_PACKAGE_NAME__: JSON.stringify(PACKAGE.name),
  },
  test: {
    include: ['scripts/**/*.preview.tsx'],
    environment: 'jsdom',
    testTimeout: 60_000,
    // 截图脚本自己去碰 Chrome，不需要每个用例的 home 隔离。
    setupFiles: [],
  },
})
