/**
 * Package version, injected at build time by `tsdown.config.ts`.
 *
 * 参考：dsh-connect-workbuddy（MIT）——版本由构建期 define 注入，而非
 * 运行时读 package.json（发布包只含 lib/，不含可解析的 package.json 路径）。
 *
 * @module dsh-connect-qoder/version
 */

declare const __DSH_QODER_VERSION__: string
declare const __DSH_QODER_PACKAGE_NAME__: string

/** The npm package version this build was produced from. */
export const QODER_CONNECT_VERSION: string =
  typeof __DSH_QODER_VERSION__ === 'string' && __DSH_QODER_VERSION__ !== ''
    ? __DSH_QODER_VERSION__
    : '0.0.0-dev'

/**
 * The npm package **name** this build was produced from.
 *
 * Needed at runtime by the browser half: the plugin manager keys its
 * configuration slots by package name — `plugins.bundle.config` uses the bare
 * package name, `plugins.row.config` uses `<package name>#<row id>`. Those keys
 * must match the *installed package*, not a hardcoded legacy alias, or the card
 * renders nothing on the bundle's page (it shows the description and rows but no
 * configuration body).
 *
 * Injected at build time so it cannot drift from `package.json`; the fallback
 * only applies outside a build (the unit tests inject the real value too — see
 * `vitest.config.ts`).
 */
export const QODER_PACKAGE_NAME: string =
  typeof __DSH_QODER_PACKAGE_NAME__ === 'string' && __DSH_QODER_PACKAGE_NAME__ !== ''
    ? __DSH_QODER_PACKAGE_NAME__
    : 'dsh-connect-qoder'