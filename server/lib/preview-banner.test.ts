import { PREVIEW_BANNER_TEXT, injectPreviewBanner } from './preview-banner'

test('R14-11: banner text is the exact prompt43 wording', () => {
  expect(PREVIEW_BANNER_TEXT).toBe(
    'OpenLevel — Early Preview. Not approved for real customer data or production business operations.',
  )
})

test('R14-11: injection places the banner above the SPA root, leaving the app intact', () => {
  const out = injectPreviewBanner('<!doctype html><html><body><div id="root"></div></body></html>')
  expect(out).toContain(PREVIEW_BANNER_TEXT)
  expect(out.indexOf('ol-preview-banner')).toBeLessThan(out.indexOf('id="root"'))
  expect(out).toContain('<div id="root"></div>')
})

test('R14-11: injection falls back to the top of body without a root marker', () => {
  const out = injectPreviewBanner('<html><body><p>hi</p></body></html>')
  expect(out).toContain(PREVIEW_BANNER_TEXT)
  expect(out.indexOf('ol-preview-banner')).toBeLessThan(out.indexOf('<p>hi</p>'))
})
