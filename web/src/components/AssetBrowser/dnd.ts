/**
 * The asset-browser → canvas drag contract, in its own module because both
 * sides of it need the constant and neither should import the other's
 * component. (It used to hang off AssetRow, which is now one of two callers.)
 */

/** Custom MIME for asset → canvas drag. Avoids colliding with UploadOverlay's
 * file-drop listeners (those check for `Files` and short-circuit on anything
 * else). */
export const DRAG_MIME = 'application/x-pai-archived-node'
