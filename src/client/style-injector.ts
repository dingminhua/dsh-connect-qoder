/**
 * Install — or **refresh** — one plugin-owned stylesheet in the document head.
 *
 * ## Why this module exists
 *
 * Two independent mechanisms have to agree about who owns a `<style>` tag, and
 * both of them key that ownership by the **npm package name**:
 *
 *   - the Host's client module system (`@deepseek-ai/dsh-client-modules`)
 *     removes a plugin's styles by `data-plugin` when the entry is rebuilt or
 *     evicted (`removeOwnedStyles`), and the id it uses is the client graph
 *     row id — which IS the package name;
 *   - the Host's own generated client bundles tag their sheets the same way
 *     (`tag.dataset.plugin = <package name>`), so a plugin that wants to be
 *     cleaned up with the rest of its family has to use the same spelling.
 *
 * The Loader entry id (`dsh-connect-qoder`) is a DIFFERENT identifier: it
 * backs the settings namespace and the `/plugins/<id>/…` routes. Tagging
 * styles with it means the Host can never clean them up — it looks for
 * `data-plugin="@dmh2002/dsh-connect-qoder"` and finds nothing.
 *
 * ## Why the sheet is REFRESHED rather than skipped
 *
 * A Host that rebuilds the client bundle tears the entry down and re-imports
 * it, which re-runs this module's top-level code. If the sheet were only
 * appended *when absent*, the **first** version ever injected would stay in
 * the document for the rest of the session, and every later change to the
 * stylesheet would be invisible in the browser while the code around it
 * updated normally.
 *
 * That is not hypothetical — it is exactly what happened to this plugin's
 * composer stylesheet. The "Settings" button shipped with new CSS (a
 * brand-coloured pill), while the browser kept the sheet from the very first
 * page load: a version with no rule for that class at all, so the button
 * rendered with the browser's default button chrome. The symptom reads as
 * "the style was never applied", while the CSS on disk was already correct.
 *
 * Refreshing in place is the pattern the settings card already used, and it
 * is the one that survives a rebuild.
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 同款做法：它在样式表上只「追加」，因为它的包名恰好等于它的 entry id，
 *   两件事碰巧是同一个字符串；本插件加了 npm scope，这层巧合没了，所以这里
 *   把「谁拥有这张表」和「这张表要不要刷新」都写成显式的规则。
 */
import { QODER_PACKAGE_NAME } from '../version.ts'

/**
 * The `data-plugin` value the Host looks for when it removes this plugin's
 * styles.
 *
 * Must be the **package name**, not the Loader entry id: the Host's
 * `removeOwnedStyles` and its own generated bundles both use the package
 * name. A mismatch here is invisible until the plugin is rebuilt, at which
 * point the stale sheets simply stay in the document.
 */
export const PLUGIN_STYLE_OWNER: string = QODER_PACKAGE_NAME

/**
 * Install or refresh one stylesheet owned by this plugin.
 *
 * @param cssId - Stable per-sheet id, written to `data-plugin-css`. It must
 *   not change between releases: it is the lookup key that finds the sheet
 *   already in the document.
 * @param css - The stylesheet text. Replacing an existing sheet's text is
 *   what makes a rebuild visible.
 */
export function installPluginStyle(cssId: string, css: string): void {
  if (typeof document === 'undefined') return
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${cssId}"]`)
  if (existing !== null) {
    // Refresh the text: a rebuild replaces the bundle, and the sheet in the
    // document is from the previous one. Without this the browser keeps the
    // first version forever.
    existing.textContent = css
    // Re-stamp the owner as well: a sheet injected by an older build (or by
    // a build that used the entry id) must end up owned by the package name,
    // or the Host will not clean it up on the next rebuild.
    existing.dataset.plugin = PLUGIN_STYLE_OWNER
    return
  }
  const styleTag = document.createElement('style')
  styleTag.dataset.plugin = PLUGIN_STYLE_OWNER
  styleTag.dataset.pluginCss = cssId
  styleTag.textContent = css
  document.head.appendChild(styleTag)
}
