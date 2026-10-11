/**
 * Package version, injected at build time by `tsdown.config.ts`.
 *
 * 参考：dsh-connect-workbuddy（MIT）——版本由构建期 define 注入，而非
 * 运行时读 package.json（发布包只含 lib/，不含可解析的 package.json 路径）。
 *
 * @module dsh-connect-qoder/version
 */

declare const __DSH_QODER_VERSION__: string

/** The npm package version this build was produced from. */
export const QODER_CONNECT_VERSION: string =
  typeof __DSH_QODER_VERSION__ === 'string' && __DSH_QODER_VERSION__ !== ''
    ? __DSH_QODER_VERSION__
    : '0.0.0-dev'