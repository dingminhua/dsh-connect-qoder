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
 * Needed at runtime by the browser half in two places, both of which address the
 * bundle by its *installed package name*:
 *
 *  - the model-picker label registration and the plugin-market fallback
 *    (`pluginNavigation.openBundle(<package name>)`);
 *  - diagnostics lines and copy that name the package.
 *
 * The configuration page itself no longer uses it: since 1.18.0 that page is a
 * `settings.section` addressed by `id` (the Loader entry id), not by the
 * package-keyed `plugins.bundle.config` / `plugins.row.config` slots.
 *
 * Injected at build time so it cannot drift from `package.json`; the fallback
 * only applies outside a build (the unit tests inject the real value too — see
 * `vitest.config.ts`).
 */
export const QODER_PACKAGE_NAME: string =
  typeof __DSH_QODER_PACKAGE_NAME__ === 'string' && __DSH_QODER_PACKAGE_NAME__ !== ''
    ? __DSH_QODER_PACKAGE_NAME__
    : 'dsh-connect-qoder'