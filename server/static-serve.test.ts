import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeDatabase } from './db/fake-database'
import { createApp } from './index'

// Production serves the Vite SPA bundle same-origin from Hono (the frontend
// calls same-origin /api, so there is no separate static host). The bundle
// directory arrives as an explicit dep: unset in dev/tests (Vite owns the UI
// there), set to <root>/dist by bootstrap() in production only.

const INDEX = '<!doctype html><html><body><div id="root"></div></body></html>'
const BUNDLE = 'console.log("openlevel bundle")'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'openlevel-static-'))
  writeFileSync(join(dir, 'index.html'), INDEX)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'app.js'), BUNDLE)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function app(staticDir?: string, preview = false) {
  return createApp({ db: new FakeDatabase(), sessionSecret: 'sek', webhookSecret: 'whsek', staticDir, preview })
}

test('without staticDir, unknown paths stay 404 (dev/test default unchanged)', async () => {
  const res = await app().request('/contacts')
  expect(res.status).toBe(404)
})

test('with staticDir, GET / serves index.html', async () => {
  const res = await app(dir).request('/')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toMatch(/text\/html/)
  expect(await res.text()).toBe(INDEX)
})

test('with staticDir, hashed bundle assets serve with a javascript content-type', async () => {
  const res = await app(dir).request('/assets/app.js')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toMatch(/javascript/)
  expect(await res.text()).toBe(BUNDLE)
})

test('with staticDir, client routes fall back to index.html (SPA refresh)', async () => {
  const res = await app(dir).request('/contacts')
  expect(res.status).toBe(200)
  expect(await res.text()).toBe(INDEX)
})

test('with staticDir, unknown API paths stay 404 and never get index.html', async () => {
  const res = await app(dir).request('/api/no-such-route')
  expect(res.status).toBe(404)
  expect(await res.text()).not.toContain('id="root"')
})

test('with staticDir, /health still answers JSON', async () => {
  const res = await app(dir).request('/health')
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true })
})

test('with staticDir, unknown federation paths keep non-static behavior, not index.html', async () => {
  const plain = await app().request('/federation/no-such-capability')
  const res = await app(dir).request('/federation/no-such-capability')
  expect(res.status).toBe(plain.status)
  expect(await res.text()).not.toContain('id="root"')
})

test('R14-11: preview mode injects the exact-wording banner into / and SPA fallbacks, never assets', async () => {
  const root = await app(dir, true).request('/')
  expect(root.status).toBe(200)
  const rootHtml = await root.text()
  expect(rootHtml).toContain('Early Preview')
  expect(rootHtml).toContain('Not approved for real customer data')
  expect(rootHtml).toContain('id="root"')
  const deep = await app(dir, true).request('/contacts')
  expect(await deep.text()).toContain('Early Preview')
  const asset = await app(dir, true).request('/assets/app.js')
  const assetBody = await asset.text()
  expect(assetBody).toBe(BUNDLE)
  expect(assetBody).not.toContain('Early Preview')
})

test('R14-11: non-preview serving is byte-identical (no banner)', async () => {
  expect(await (await app(dir, false).request('/')).text()).toBe(INDEX)
})
