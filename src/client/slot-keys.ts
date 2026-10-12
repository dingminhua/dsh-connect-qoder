/**
 * The plugin manager's configuration-slot keys for this plugin's card.
 *
 * The Plugin-configuration page declares three slots, and the page owner keys
 * them by **package identity** — not by this plugin's own settings namespace:
 *
 * - `plugins.bundle.config` — keyed by the bundle's **package name**; renders on
 *   the bundle's page between its description and its rows.
 * - `plugins.row.config` — keyed by **`<package name>#<row id>`**; gives that row
 *   its Configure control.
 *
 * Getting these wrong is silent and looks like "the plugin is fine but its
 * settings vanished": the plugin still lists as running, with its description
 * and its component rows, but the configuration body renders nothing. That is
 * exactly what happened when the package was renamed to the scoped
 * `@dmh2002/dsh-connect-qoder` while these keys stayed hardcoded to the old
 * unscoped name.
 *
 * So the package name is **injected at build time** (`QODER_PACKAGE_NAME`, see
 * `tsdown.config.ts`) rather than written here twice, and the row id is the
 * Host's Loader entry id — which is what the settings namespace is derived from
 * (`settingsNamespaceOf`), deliberately left unscoped so saved config keeps
 * resolving.
 *
 * @module dsh-connect-qoder/client/slot-keys
 */

import { QODER_PACKAGE_NAME } from '../version.ts'
import { QODER_SETTINGS_NS } from '../status-paths.ts'

/**
 * Build the two configuration-slot keys for a bundle.
 *
 * Pure on purpose: the caller passes identity in, so a test can pin the exact
 * format without importing the card (and its React tree).
 */
export function qoderCardSlotKeys(
  packageName: string,
  rowId: string,
): { bundle: string, row: string } {
  return {
    // `plugins.bundle.config` takes the bare package name.
    bundle: packageName,
    // `plugins.row.config` takes `<package name>#<row id>`.
    row: `${packageName}#${rowId}`,
  }
}

/** The keys this build registers its card under. */
export const QODER_CARD_SLOT_KEYS: { bundle: string, row: string } =
  qoderCardSlotKeys(QODER_PACKAGE_NAME, QODER_SETTINGS_NS)
