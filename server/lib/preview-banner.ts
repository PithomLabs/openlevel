/**
 * Restricted-preview banner (R14-11). The exact-wording label ships INSIDE
 * the served SPA document (no JavaScript needed): bootstrap injects it into
 * index.html at serve time when and only when the validated config is
 * preview mode. The smoke preview-banner probe scrapes for this text.
 */

/** Exact prompt43 wording — the smoke probe and this constant must agree. */
export const PREVIEW_BANNER_TEXT =
  'OpenLevel — Early Preview. Not approved for real customer data or production business operations.'

const BANNER_HTML =
  '<div id="ol-preview-banner" role="note" ' +
  'style="background:#7c2d12;color:#fff;font:600 14px/1.4 ui-sans-serif,system-ui,sans-serif;' +
  'text-align:center;padding:10px 16px;position:relative;z-index:9999">' +
  PREVIEW_BANNER_TEXT +
  '</div>'

/**
 * Insert the banner above the SPA root (React owns #root, so the banner
 * survives client rendering). Falls back to the top of <body> when the
 * root marker is absent. Pure string transform — no DOM needed.
 */
export function injectPreviewBanner(html: string): string {
  if (html.includes('<div id="root">')) {
    return html.replace('<div id="root">', `${BANNER_HTML}<div id="root">`)
  }
  return html.replace(/<body[^>]*>/, (open) => `${open}${BANNER_HTML}`)
}
