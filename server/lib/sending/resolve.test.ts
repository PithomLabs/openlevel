import { afterEach, describe, expect, it } from 'vitest'
import { FakeDatabase } from '../../db/fake-database'
import { resolveEmailSender, resolveSmsSender } from './resolve'

// Secrets resolve by NAME via the env-backed vault layer, same as payments:
// <slug>:brevo:api_key -> ACME_BREVO_API_KEY. client_slug wins over slug.
const ENV_KEYS = ['ACME_BREVO_API_KEY', 'ACME_TWILIO_ACCOUNT_SID', 'ACME_TWILIO_AUTH_TOKEN']

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

function dbWithLocation(settings: Record<string, unknown>, clientSlug: string | null = 'acme') {
  const db = new FakeDatabase()
  db.enqueue([{ id: 'locA', name: 'Acme', slug: 'acme-loc', client_slug: clientSlug, branding: {}, settings }])
  return db
}

describe('resolveEmailSender', () => {
  it('builds a brevo sender when the location chose brevo with a sender email and the key resolves', async () => {
    process.env.ACME_BREVO_API_KEY = 'xkeysib-x'
    const resolved = await resolveEmailSender(
      dbWithLocation({ sending: { emailProvider: 'brevo', fromEmail: 'ops@acme.com', fromName: 'Acme' } }),
      'locA',
    )
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.sender.name).toBe('brevo')
  })

  it('reports an unconfigured brevo key instead of throwing', async () => {
    const resolved = await resolveEmailSender(
      dbWithLocation({ sending: { emailProvider: 'brevo', fromEmail: 'ops@acme.com' } }),
      'locA',
    )
    expect(resolved).toEqual({ ok: false, reason: 'brevo key is not configured' })
  })

  it('requires a sender email even when the key resolves', async () => {
    process.env.ACME_BREVO_API_KEY = 'xkeysib-x'
    const resolved = await resolveEmailSender(dbWithLocation({ sending: { emailProvider: 'brevo' } }), 'locA')
    expect(resolved).toEqual({ ok: false, reason: 'sender email is not configured' })
  })

  it('reports no provider connected for a fresh location', async () => {
    const resolved = await resolveEmailSender(dbWithLocation({}), 'locA')
    expect(resolved).toEqual({ ok: false, reason: 'no email provider connected' })
  })

  it('falls back to the location slug when there is no client_slug', async () => {
    process.env.ACME_LOC_BREVO_API_KEY = 'xkeysib-x'
    try {
      const resolved = await resolveEmailSender(
        dbWithLocation({ sending: { emailProvider: 'brevo', fromEmail: 'ops@acme.com' } }, null),
        'locA',
      )
      expect(resolved.ok).toBe(true)
    } finally {
      delete process.env.ACME_LOC_BREVO_API_KEY
    }
  })

  it('reports a missing location', async () => {
    const db = new FakeDatabase()
    db.enqueue([])
    expect(await resolveEmailSender(db, 'nope')).toEqual({ ok: false, reason: 'location not found' })
  })
})

describe('resolveSmsSender', () => {
  it('builds a twilio sender when the location chose twilio with a from number and both keys resolve', async () => {
    process.env.ACME_TWILIO_ACCOUNT_SID = 'AC_x'
    process.env.ACME_TWILIO_AUTH_TOKEN = 'tok_x'
    const resolved = await resolveSmsSender(
      dbWithLocation({ sending: { smsProvider: 'twilio', smsFrom: '+14805550111' } }),
      'locA',
    )
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.sender.name).toBe('twilio')
  })

  it('reports unconfigured twilio keys instead of throwing', async () => {
    const resolved = await resolveSmsSender(
      dbWithLocation({ sending: { smsProvider: 'twilio', smsFrom: '+14805550111' } }),
      'locA',
    )
    expect(resolved).toEqual({ ok: false, reason: 'twilio keys are not configured' })
  })

  it('requires the from number even when the keys resolve', async () => {
    process.env.ACME_TWILIO_ACCOUNT_SID = 'AC_x'
    process.env.ACME_TWILIO_AUTH_TOKEN = 'tok_x'
    const resolved = await resolveSmsSender(dbWithLocation({ sending: { smsProvider: 'twilio' } }), 'locA')
    expect(resolved).toEqual({ ok: false, reason: 'sms from number is not configured' })
  })

  it('reports no provider connected for a fresh location', async () => {
    const resolved = await resolveSmsSender(dbWithLocation({}), 'locA')
    expect(resolved).toEqual({ ok: false, reason: 'no sms provider connected' })
  })

  it('reports a missing location', async () => {
    const db = new FakeDatabase()
    db.enqueue([])
    expect(await resolveSmsSender(db, 'nope')).toEqual({ ok: false, reason: 'location not found' })
  })
})

describe('staging fence (N5/N15, G4)', () => {
  const STAGING = { APP_ENV: 'staging', STAGING_SINK_ALLOWLIST: 'alice@example.com,+15551230001' }

  it('staging returns the sink sender without touching settings, secrets, or the database', async () => {
    process.env.ACME_BREVO_API_KEY = 'xkeysib-live-key'
    process.env.ACME_TWILIO_ACCOUNT_SID = 'AC-live'
    process.env.ACME_TWILIO_AUTH_TOKEN = 'live-token'
    const emailDb = dbWithLocation({
      sending: { emailProvider: 'brevo', fromEmail: 'ops@acme.com', smsProvider: 'twilio', smsFrom: '+1' },
    })
    const smsDb = dbWithLocation({
      sending: { emailProvider: 'brevo', fromEmail: 'ops@acme.com', smsProvider: 'twilio', smsFrom: '+1' },
    })
    const email = await resolveEmailSender(emailDb, 'locA', STAGING)
    const sms = await resolveSmsSender(smsDb, 'locA', STAGING)
    expect(email.ok && email.sender.name).toBe('sink')
    expect(sms.ok && sms.sender.name).toBe('sink')
    // Zero queries: the fence short-circuits before locations, settings, vault.
    expect(emailDb.calls).toHaveLength(0)
    expect(smsDb.calls).toHaveLength(0)
  })

  it('staging with no allowlist refuses everything (fail-closed)', async () => {
    for (const allowlist of [undefined, '', ' , ']) {
      const env = { APP_ENV: 'staging', STAGING_SINK_ALLOWLIST: allowlist }
      expect(await resolveEmailSender(new FakeDatabase(), 'locA', env)).toEqual({
        ok: false,
        reason: 'staging sink allowlist is not configured (STAGING_SINK_ALLOWLIST)',
      })
      expect(await resolveSmsSender(new FakeDatabase(), 'locA', env)).toEqual({
        ok: false,
        reason: 'staging sink allowlist is not configured (STAGING_SINK_ALLOWLIST)',
      })
    }
  })

  it('R14-03: restricted production preview refuses email + sms without touching settings, secrets, or the database', async () => {
    const env = { APP_ENV: 'production', RESTRICTED_PREVIEW: 'true' }
    const emailDb = new FakeDatabase()
    const smsDb = new FakeDatabase()
    const email = await resolveEmailSender(emailDb, 'locA', env)
    const sms = await resolveSmsSender(smsDb, 'locA', env)
    expect(email.ok).toBe(false)
    expect(sms.ok).toBe(false)
    expect(emailDb.calls).toHaveLength(0)
    expect(smsDb.calls).toHaveLength(0)
  })
})
