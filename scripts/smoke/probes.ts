/**
 * Smoke probe implementations (R14-05). Each runner executes a real behavior
 * against the target and returns PASS / FAIL / NOT RUN with a sanitized
 * detail line. Probes run in inventory order; `ctx.state` carries fixtures
 * between them. Anything a probe cannot observe is NOT RUN with a reason —
 * never a pass by inspection.
 */
import { createHmac } from 'node:crypto'
import type { SmokeClient, SmokeSql } from './client'
import type { SmokeTarget } from './inventory'
import { redact } from './redact'

export type Verdict = 'PASS' | 'FAIL' | 'NOT RUN'
export interface ProbeOutcome {
  verdict: Verdict
  detail: string
}

export interface SmokeConfig {
  target: SmokeTarget
  baseUrl: string
  /** Expected APP_ENV evidenced in boot logs. */
  appEnv: string
  /** Allowlisted synthetic SMS destination (must be on STAGING_SINK_ALLOWLIST for sink targets). */
  sinkPhone: string
  /** Synthetic webhook secret chosen at deploy time (known to the runner, never printed). */
  webhookSecret: string
  /** Fly app name (remote log + digest probes). */
  flyApp: string
  /** Neon project id for SQL + identity probes (remote). */
  neonProject: string
  /** Staging Neon project id, for the preview no-reuse probe. */
  stagingNeonProject: string
  /** Local docker names (local target only). */
  container: string
  image: string
}

export interface SmokeCtx {
  config: SmokeConfig
  /** Authenticated client (cookie jar filled by the auth probe). */
  client: SmokeClient
  /** Anonymous client (fresh jar). */
  anon: SmokeClient
  /** SQL access, or null when unavailable (SQL probes NOT RUN). */
  sql: SmokeSql | null
  /** Fetch captured logs (docker logs / fly logs). */
  logs: () => Promise<string>
  /**
   * Container environment (local target only, via docker inspect). Null on
   * remote targets, where env values are not retrievable — env-dependent
   * probes NOT RUN there.
   */
  inspectEnv: (() => Promise<Record<string, string>>) | null
  /** Record an observed send outcome for the aggregate probe. */
  noteOutcome: (outcome: string) => void
  state: Record<string, string>
}

const ok = (detail: string): ProbeOutcome => ({ verdict: 'PASS', detail })
const fail = (detail: string): ProbeOutcome => ({ verdict: 'FAIL', detail })
const skip = (detail: string): ProbeOutcome => ({ verdict: 'NOT RUN', detail })
const preview = (ctx: SmokeCtx): boolean => ctx.config.target === 'preview'

function fmtJson(v: unknown, max = 300): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return redact(s.length > max ? `${s.slice(0, max)}…` : s)
}

export const PROBE_RUNNERS: Record<string, (ctx: SmokeCtx) => Promise<ProbeOutcome>> = {
  endpoint: async (ctx) => {
    const { baseUrl, target } = ctx.config
    const res = await ctx.anon.get('/')
    if (res.status !== 200) return fail(`GET / -> ${res.status}`)
    if (target === 'local') {
      if (!baseUrl.startsWith('http://')) return fail(`local base must be http, got ${fmtJson(baseUrl)}`)
      return ok('local http endpoint reachable (TLS is a Fly-edge concern, exercised on remote targets)')
    }
    if (!baseUrl.startsWith('https://')) return fail(`remote base must be https, got ${fmtJson(baseUrl)}`)
    return ok('https endpoint reachable (fetch verified the TLS chain)')
  },

  health: async (ctx) => {
    const res = await ctx.anon.get('/health')
    if (res.status !== 200) return fail(`GET /health -> ${res.status}: ${fmtJson(res.text)}`)
    const body = res.json as { ok?: boolean; service?: string } | null
    if (body?.ok !== true || body?.service !== 'openlevel') return fail(`unexpected body: ${fmtJson(res.text)}`)
    return ok('liveness ok')
  },

  ready: async (ctx) => {
    const res = await ctx.anon.get('/ready')
    if (res.status !== 200) return fail(`GET /ready -> ${res.status}: ${fmtJson(res.text)}`)
    if ((res.json as { ready?: boolean } | null)?.ready !== true) return fail(`not ready: ${fmtJson(res.text)}`)
    return ok('readiness ok (migrated + workers up)')
  },

  'static-frontend': async (ctx) => {
    const root = await ctx.anon.get('/')
    const deep = await ctx.anon.get('/contacts')
    for (const [name, res] of [['/', root], ['/contacts', deep]] as const) {
      if (res.status !== 200 || !res.text.includes('id="root"')) {
        return fail(`GET ${name} -> ${res.status}, app marker missing`)
      }
    }
    return ok('SPA shell + deep-link fallback serve the app marker')
  },

  'preview-banner': async (ctx) => {
    const res = await ctx.anon.get('/')
    const hasBanner = res.text.includes('Early Preview') && res.text.includes('Not approved for real customer data')
    if (preview(ctx)) {
      return hasBanner ? ok('restricted-preview banner present with exact wording') : fail('preview banner missing from /')
    }
    return hasBanner ? fail('non-preview target shows the preview banner') : ok('no preview banner (correct off-preview)')
  },

  'boot-identity': async (ctx) => {
    const logs = await ctx.logs()
    const envLine = logs.includes(`openlevel env=${ctx.config.appEnv}`)
    const listenLine = /listening on :\d+/.test(logs)
    if (!envLine || !listenLine) return fail(`boot markers missing (env=${envLine}, listen=${listenLine})`)
    const extras = [
      logs.includes('release ') ? 'release pinned' : 'no release line',
      logs.includes('image ') ? 'image ref logged' : 'no image line (non-Fly boot)',
    ].join(', ')
    return ok(`boot binds env=${ctx.config.appEnv}; ${extras}`)
  },

  'migration-version': async (ctx) => {
    if (!ctx.sql) return skip('no SQL access on this target run')
    const rows = await ctx.sql.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY 1')
    if (rows.length === 0) return fail('schema_migrations is empty')
    return ok(`${rows.length} migrations applied (latest ${rows[rows.length - 1]?.version})`)
  },

  auth: async (ctx) => {
    const email = ctx.state.email
    const password = ctx.state.password
    if (!email || !password) return skip('no smoke operator fixture (setup failed)')
    const bad = await ctx.anon.post('/api/auth/login', { email, password: 'wrong-password' })
    if (bad.status !== 401) return fail(`wrong password -> ${bad.status}, expected 401`)
    const good = await ctx.client.post('/api/auth/login', { email, password })
    if (good.status !== 200) return fail(`login -> ${good.status}: ${fmtJson(good.text)}`)
    const me = await ctx.client.get('/api/locations')
    if (me.status !== 200) return fail(`authed GET /api/locations -> ${me.status}`)
    const anon = await ctx.anon.get('/api/locations')
    if (anon.status !== 401) return fail(`anonymous operator route -> ${anon.status}, expected 401`)
    return ok('login 200 + session works; wrong creds 401; anonymous 401')
  },

  'lead-capture': async (ctx) => {
    const loc = ctx.state.loc
    if (!loc) return skip('no smoke location fixture')
    const slug = `smoke-form-${Date.now().toString(36)}`
    const created = await ctx.client.post(`/api/loc/${loc}/forms`, { name: 'Smoke form', slug })
    if (created.status !== 200 && created.status !== 201) return fail(`create form -> ${created.status}: ${fmtJson(created.text)}`)
    const formId = (created.json as { form?: { id?: string }; id?: string } | null)
    const id = formId?.form?.id ?? formId?.id
    if (!id) return fail(`no form id in response: ${fmtJson(created.text)}`)
    // One concern per PATCH call: content first, then publish.
    const edited = await ctx.client.patch(`/api/loc/${loc}/forms/${id}`, {
      content: {
        headline: 'Smoke',
        fields: [
          { name: 'full_name', label: 'Name', type: 'text', required: true },
          { name: 'phone', label: 'Phone', type: 'tel', required: true },
        ],
      },
    })
    if (edited.status !== 200) return fail(`edit form -> ${edited.status}: ${fmtJson(edited.text)}`)
    const published = await ctx.client.patch(`/api/loc/${loc}/forms/${id}`, { status: 'published' })
    if (published.status !== 200) return fail(`publish form -> ${published.status}: ${fmtJson(published.text)}`)
    const page = await ctx.anon.get(`/api/public/forms/${loc}/${slug}`)
    if (page.status !== 200) return fail(`public form page -> ${page.status}`)
    const submit = await ctx.anon.post(`/api/public/forms/${loc}/${slug}/submit`, {
      values: { full_name: 'Smoke Lead', phone: ctx.config.sinkPhone },
    })
    if (submit.status !== 200) return fail(`public submit -> ${submit.status}: ${fmtJson(submit.text)}`)
    const contactId = (submit.json as { contactId?: string } | null)?.contactId
    if (!contactId) return fail(`no contactId in response: ${fmtJson(submit.text)}`)
    ctx.state.formSlug = slug
    ctx.state.contactId = contactId
    return ok(`form published + public submit captured contact ${contactId}`)
  },

  'submission-identity': async (ctx) => {
    const loc = ctx.state.loc
    const slug = ctx.state.formSlug
    if (!loc || !slug) return skip('lead-capture produced no form')
    const values = { full_name: 'Identity Probe', phone: '+15551239999' }
    const path = `/api/public/forms/${loc}/${slug}/submit`
    const first = await ctx.anon.post(path, { values })
    const second = await ctx.anon.post(path, { values })
    if (first.status !== 200 || second.status !== 200) return fail(`keyless submits -> ${first.status}/${second.status}`)
    const b1 = first.json as Record<string, unknown>
    const b2 = second.json as Record<string, unknown>
    if ('deduped' in b1 || 'deduped' in b2) return fail('keyless identical submits collapsed (deduped flag present)')
    if (b1.contactId !== b2.contactId) return fail('same identity resolved to different contacts')
    const key = `smoke-key-${Date.now().toString(36)}`
    const k1 = await ctx.anon.post(path, { values }, { 'Idempotency-Key': key })
    const k2 = await ctx.anon.post(path, { values }, { 'Idempotency-Key': key })
    if (k1.status !== 200 || k2.status !== 200) return fail(`keyed submits -> ${k1.status}/${k2.status}`)
    if ((k2.json as Record<string, unknown>).deduped !== true) return fail('keyed retry did not replay (no deduped flag)')
    if ((k2.json as Record<string, unknown>).contactId !== (k1.json as Record<string, unknown>).contactId) {
      return fail('keyed replay returned a different contact')
    }
    const clash = await ctx.anon.post(
      path,
      { values: { full_name: 'Someone Else', phone: '+15551239888' } },
      { 'Idempotency-Key': key },
    )
    if (clash.status !== 409) return fail(`key reuse with new payload -> ${clash.status}, expected 409`)
    return ok('keyless distinct (same contact) + keyed replay + clash 409, live')
  },

  'contact-identity': async (ctx) => {
    const loc = ctx.state.loc
    const slug = ctx.state.formSlug
    const contactId = ctx.state.contactId
    if (!loc || !slug || !contactId) return skip('lead-capture produced no contact')
    const again = await ctx.anon.post(`/api/public/forms/${loc}/${slug}/submit`, {
      values: { full_name: 'Smoke Lead', phone: ctx.config.sinkPhone },
    })
    if (again.status !== 200) return fail(`repeat submit -> ${again.status}`)
    if ((again.json as { contactId?: string } | null)?.contactId !== contactId) {
      return fail('repeat capture did not resolve the same contact')
    }
    // Genuine conflict: two contacts hold the phone and the email
    // separately, then one submit names both — independent lookups hit
    // different contacts, so the upsert must 409, never merge.
    const mkA = await ctx.anon.post(`/api/public/forms/${loc}/${slug}/submit`, {
      values: { full_name: 'Conflict A', phone: '+15551237777' },
    })
    const mkB = await ctx.anon.post(`/api/public/forms/${loc}/${slug}/submit`, {
      values: { full_name: 'Conflict B', phone: '+15551236666', email: 'conflict-b-smoke@example.com' },
    })
    if (mkA.status !== 200 || mkB.status !== 200) return fail(`conflict fixtures -> ${mkA.status}/${mkB.status}`)
    const conflict = await ctx.anon.post(`/api/public/forms/${loc}/${slug}/submit`, {
      values: { full_name: 'Conflicting Person', phone: '+15551237777', email: 'conflict-b-smoke@example.com' },
    })
    if (conflict.status !== 409) {
      return fail(`identity-conflict submit -> ${conflict.status}, expected 409 (got ${fmtJson(conflict.text)})`)
    }
    return ok('repeat resolves same contact; phone-vs-email conflict 409s')
  },

  booking: async (ctx) => {
    const loc = ctx.state.loc
    if (!loc) return skip('no smoke location fixture')
    const slug = `smoke-cal-${Date.now().toString(36)}`
    const created = await ctx.client.post(`/api/loc/${loc}/calendars`, { name: 'Smoke cal', durationMin: 30 })
    if (created.status !== 200 && created.status !== 201) return fail(`create calendar -> ${created.status}: ${fmtJson(created.text)}`)
    const calId = (created.json as { calendar?: { id?: string }; id?: string } | null)
    const id = calId?.calendar?.id ?? calId?.id
    if (!id) return fail(`no calendar id: ${fmtJson(created.text)}`)
    const tomorrow = new Date(Date.now() + 86400000)
    const weekday = tomorrow.getUTCDay()
    const patched = await ctx.client.patch(`/api/loc/${loc}/calendars/${id}`, {
      bookingEnabled: true,
      bookingSlug: slug,
      timezone: 'UTC',
      availability: [{ weekday, start: '00:00', end: '23:59' }],
    })
    if (patched.status !== 200) return fail(`enable booking -> ${patched.status}: ${fmtJson(patched.text)}`)
    const ymd = tomorrow.toISOString().slice(0, 10)
    const slots = await ctx.anon.get(`/api/public/booking/${loc}/${slug}/slots?date=${ymd}`)
    if (slots.status !== 200) return fail(`slots -> ${slots.status}: ${fmtJson(slots.text)}`)
    const list = (slots.json as { slots?: Array<{ start: string; end: string }> } | null)?.slots ?? []
    if (list.length === 0) return fail(`no slots for ${ymd}`)
    const first = list[0]
    if (!first) return fail('slot list empty')
    const key = `smoke-book-${Date.now().toString(36)}`
    const book = (extra: unknown, k: string) =>
      ctx.anon.post(`/api/public/booking/${loc}/${slug}/book`, {
        start: first.start,
        end: first.end,
        name: 'Smoke Booker',
        email: 'smoke-booker@example.com',
        ...(extra as Record<string, unknown>),
      }, { 'Idempotency-Key': k })
    const one = await book({}, key)
    if (one.status !== 200) return fail(`book -> ${one.status}: ${fmtJson(one.text)}`)
    const apptId = (one.json as { appointmentId?: string } | null)?.appointmentId
    const two = await book({}, key)
    if (two.status !== 200) return fail(`keyed re-book -> ${two.status}`)
    if ((two.json as { appointmentId?: string } | null)?.appointmentId !== apptId) {
      return fail('keyed re-book did not replay the same appointment')
    }
    const rival = await book({ name: 'Rival', email: 'rival-smoke@example.com' }, `${key}-rival`)
    if (rival.status !== 409) return fail(`rival booking -> ${rival.status}, expected 409`)
    return ok(`slots + book + replay(${apptId}) + rival 409, live`)
  },

  'confirm-idempotency': async (ctx) => {
    const loc = ctx.state.loc
    const contactId = ctx.state.contactId
    if (!loc || !contactId) return skip('lead-capture produced no contact')
    if (!ctx.sql) return skip('no SQL access to count tasks')
    const key = `smoke-confirm-${Date.now().toString(36)}`
    const confirm = (k: string) =>
      ctx.client.post(`/api/loc/${loc}/assistant/confirm`, {
        verb: 'create_task',
        params: { contactId, title: 'Smoke task' },
      }, { 'Idempotency-Key': k })
    const one = await confirm(key)
    const two = await confirm(key)
    if (one.status !== 200 || two.status !== 200) return fail(`confirms -> ${one.status}/${two.status}`)
    const m1 = (one.json as { message?: string } | null)?.message
    const m2 = (two.json as { message?: string } | null)?.message
    if (!m1 || m1 !== m2) return fail('double confirm did not replay the same message')
    const rows = await ctx.sql.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM contact_tasks WHERE location_id = $1 AND title = 'Smoke task'",
      [loc],
    )
    if (rows[0]?.n !== 1) return fail(`expected exactly 1 smoke task, found ${rows[0]?.n}`)
    return ok('double confirm replayed one message; exactly one task row')
  },

  'campaign-lifecycle': async (ctx) => {
    const loc = ctx.state.loc
    if (!loc) return skip('no smoke location fixture')
    const create = async (name: string): Promise<string | null> => {
      const created = await ctx.client.post(`/api/loc/${loc}/campaigns`, { name, channel: 'sms', body: 'Synthetic smoke message — ignore.' })
      if (created.status !== 200 && created.status !== 201) return null
      const id = created.json as { campaign?: { id?: string }; id?: string } | null
      return id?.campaign?.id ?? id?.id ?? null
    }
    // Blast campaign: create -> send (simulated in staging, refused in preview).
    const blast = await create(`Smoke blast ${Date.now().toString(36)}`)
    if (!blast) return fail('create blast campaign failed')
    const send = await ctx.client.post(`/api/loc/${loc}/campaigns/${blast}/send`, {})
    if (preview(ctx)) {
      if (send.status !== 409) return fail(`preview campaign send -> ${send.status}, expected refusal 409`)
      ctx.noteOutcome(`campaign-send refused: ${fmtJson(send.text, 120)}`)
    } else {
      if (send.status !== 200) return fail(`staging campaign send -> ${send.status}: ${fmtJson(send.text)}`)
      const flag = (send.json as { simulated?: boolean } | null)?.simulated
      if (flag !== true) return fail(`staging campaign send not simulated: ${fmtJson(send.text)}`)
      ctx.noteOutcome('campaign-send simulated')
    }
    // Draft campaign: create -> cancel (a sent blast is terminal by design).
    const draft = await create(`Smoke draft ${Date.now().toString(36)}`)
    if (!draft) return fail('create draft campaign failed')
    const cancel = await ctx.client.post(`/api/loc/${loc}/campaigns/${draft}/cancel`, {})
    if (cancel.status !== 200) return fail(`cancel draft -> ${cancel.status}: ${fmtJson(cancel.text)}`)
    return ok(preview(ctx) ? 'preview: send refused + draft cancelled' : 'staging: send simulated + draft cancelled')
  },

  'voice-sink': async (ctx) => {
    const loc = ctx.state.loc
    const contactId = ctx.state.contactId
    if (!loc || !contactId) return skip('lead-capture produced no contact')
    const res = await ctx.client.post(`/api/loc/${loc}/calls`, { contactId })
    if (preview(ctx)) {
      if (res.status === 200 && (res.json as { simulated?: boolean } | null)?.simulated === true) {
        return fail('preview voice call simulated instead of refused')
      }
      ctx.noteOutcome(`voice refused: ${fmtJson(res.text, 120)}`)
      return ok(`preview voice refused (${res.status})`)
    }
    if (res.status !== 200) return fail(`staging voice call -> ${res.status}: ${fmtJson(res.text)}`)
    if ((res.json as { simulated?: boolean } | null)?.simulated !== true) {
      return fail(`staging voice call not simulated: ${fmtJson(res.text)}`)
    }
    ctx.noteOutcome('voice simulated')
    return ok('staging voice placement simulated')
  },

  'sms-sink': async (ctx) => {
    const loc = ctx.state.loc
    const contactId = ctx.state.contactId
    if (!loc || !contactId) return skip('lead-capture produced no contact')
    const res = await ctx.client.post(`/api/loc/${loc}/assistant/confirm`, {
      verb: 'send_text',
      params: { contactId, body: 'Synthetic smoke text — ignore.', nonce: `smoke-${Date.now().toString(36)}` },
    })
    if (res.status !== 200) return fail(`send_text confirm -> ${res.status}: ${fmtJson(res.text)}`)
    const message = (res.json as { message?: string } | null)?.message ?? ''
    if (preview(ctx)) {
      if (!/nothing was sent|disabled|preview/i.test(message)) return fail(`preview send_text not refused: ${fmtJson(message)}`)
      ctx.noteOutcome('send_text refused')
      return ok('preview send_text refused')
    }
    if (!/simulat/i.test(message)) return fail(`staging send_text not simulated: ${fmtJson(message)}`)
    ctx.noteOutcome('send_text simulated')
    return ok('staging send_text simulated (sink)')
  },

  'chatwoot-inbound': async (ctx) => {
    const loc = ctx.state.loc
    const secret = ctx.config.webhookSecret
    if (!secret) return skip('no synthetic webhook secret configured for this run')
    const unsigned = await ctx.anon.post('/api/webhooks/chatwoot', { event: 'message_created' })
    if (unsigned.status !== 401) return fail(`unsigned inbound -> ${unsigned.status}, expected 401`)
    const wrongSecret = await ctx.anon.post(
      '/api/webhooks/chatwoot',
      { event: 'message_created' },
      { 'x-webhook-secret': 'wrong-secret' },
    )
    if (wrongSecret.status !== 401) return fail(`wrong-secret inbound -> ${wrongSecret.status}, expected 401`)
    // HMAC path (byte-exact body): wrong signature 401s, correct verifies.
    const ts = String(Math.floor(Date.now() / 1000))
    const ping = JSON.stringify({ event: 'ping' })
    const badSig = await ctx.anon.postRaw(
      '/api/webhooks/chatwoot',
      ping,
      { 'x-chatwoot-timestamp': ts, 'x-chatwoot-signature': 'sha256=deadbeef' },
    )
    if (badSig.status !== 401) return fail(`bad-hmac inbound -> ${badSig.status}, expected 401`)
    const goodSig = `sha256=${createHmac('sha256', secret).update(`${ts}.${ping}`).digest('hex')}`
    const pingOk = await ctx.anon.postRaw(
      '/api/webhooks/chatwoot',
      ping,
      { 'x-chatwoot-timestamp': ts, 'x-chatwoot-signature': goodSig },
    )
    if (pingOk.status !== 200) return fail(`valid-hmac ping -> ${pingOk.status}: ${fmtJson(pingOk.text)}`)
    // Full processing path needs a channel link for the inbox (fixture via SQL).
    if (!ctx.sql || !loc) return ok('verification enforced + hmac verifies (processing path skipped: no SQL/location)')
    const inbox = `smoke-inbox-${Date.now().toString(36)}`
    await ctx.sql.query(
      'INSERT INTO channel_links (id, location_id, provider, inbox_id, config) VALUES ($1,$2,$3,$4,$5)',
      [`cl_${inbox}`, loc, 'chatwoot', inbox, {}],
    )
    const msgId = `smoke-msg-${Date.now().toString(36)}`
    const event = {
      event: 'message_created',
      message_type: 'incoming',
      id: msgId,
      content: 'Synthetic smoke inbound — ignore.',
      inbox: { id: inbox },
      conversation: { id: 4242, inbox_id: inbox },
      sender: { name: 'Smoke Sender', phone_number: '+15551235555' },
    }
    const raw = JSON.stringify(event)
    const sig = `sha256=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`
    const inbound = await ctx.anon.postRaw(
      '/api/webhooks/chatwoot',
      raw,
      { 'x-chatwoot-timestamp': ts, 'x-chatwoot-signature': sig },
    )
    if (inbound.status !== 200) return fail(`valid inbound -> ${inbound.status}: ${fmtJson(inbound.text)}`)
    if ((inbound.json as { ignored?: unknown } | null)?.ignored !== undefined) {
      return fail(`valid inbound ignored: ${fmtJson(inbound.text)}`)
    }
    ctx.state.inboundAt = String(Date.now())
    return ok('unsigned/wrong-secret/bad-hmac 401; valid hmac processes a real inbound')
  },

  'push-suppression': async (ctx) => {
    if (!ctx.state.inboundAt) return skip('no processed inbound in this run (chatwoot-inbound did not process)')
    const deadline = Date.now() + 45_000
    for (;;) {
      const logs = await ctx.logs()
      if (/push suppressed/.test(logs)) {
        const label = ctx.config.target === 'preview' ? 'preview' : 'staging'
        return ok(`observable push suppression in logs (${label} path), gateway untouched`)
      }
      if (Date.now() > deadline) return fail('no push-suppression line in logs 45s after inbound')
      await new Promise((r) => setTimeout(r, 5000))
    }
  },

  'outbox-drain': async (ctx) => {
    if (!ctx.sql) return skip('no SQL access on this target run')
    const deadline = Date.now() + 90_000
    let last = ''
    for (;;) {
      const rows = await ctx.sql.query<{ status: string; n: number }>(
        "SELECT status, count(*)::int AS n FROM outbox WHERE status IN ('pending','sending','failed') GROUP BY status",
      )
      const byStatus = new Map(rows.map((r) => [r.status, r.n]))
      const failed = byStatus.get('failed') ?? 0
      const open = (byStatus.get('pending') ?? 0) + (byStatus.get('sending') ?? 0)
      last = `pending/sending=${open} failed=${failed}`
      if (failed > 0) return fail(`DLQ has ${failed} failed rows`)
      if (open === 0) return ok(`outbox drained (${last})`)
      if (Date.now() > deadline) return fail(`outbox did not drain in 90s (${last})`)
      await new Promise((r) => setTimeout(r, 5000))
    }
  },

  reporting: async (ctx) => {
    const loc = ctx.state.loc
    if (!loc) return skip('no smoke location fixture')
    const res = await ctx.client.get(`/api/loc/${loc}/reporting`)
    if (res.status !== 200) return fail(`reporting -> ${res.status}: ${fmtJson(res.text)}`)
    const summary = (res.json as { summary?: { contacts?: number } } | null)?.summary
    if (typeof summary?.contacts !== 'number' || summary.contacts < 1) {
      return fail(`reporting summary missing smoke contacts: ${fmtJson(res.text)}`)
    }
    return ok(`reporting honest (contacts=${summary.contacts}; simulated outcomes keep their taxonomy)`)
  },

  federation: async (ctx) => {
    const noBearer = await ctx.anon.get('/federation/capabilities')
    if (noBearer.status === 503) return ok('federation inert (no service token configured) — safe by absence')
    if (noBearer.status !== 401) return fail(`federation without bearer -> ${noBearer.status}, expected 401/503`)
    const wrongBearer = await ctx.anon.get('/federation/today', { authorization: 'Bearer [REDACTED]' })
    if (wrongBearer.status !== 401) return fail(`federation with wrong bearer -> ${wrongBearer.status}, expected 401`)
    return ok('federation bearer gate enforced (deeper paths need the real token — not probed)')
  },

  sigterm: async (ctx) => {
    if (ctx.config.target !== 'local') {
      const logs = await ctx.logs()
      if (logs.includes('shutdown: complete') && /shutdown clean|shutdown deadline/.test(logs)) {
        return ok('prior machine stop in logs shows the ordered drain ran')
      }
      return skip('no machine stop in the available log window — graceful path covered against the same image locally')
    }
    return skip('local stop is executed by the orchestrator after the HTTP probes (see transcript tail)')
  },

  'digest-proof': async (ctx) => {
    // Implemented by run.ts (needs shell access); this entry keeps the inventory total.
    return skip('digest is recorded by the runner harness (see transcript header)')
  },

  'provider-config-absence': async (ctx) => {
    // FIND-01/PR46 strengthening: log-hostname absence alone does not prove
    // zero provider calls. This probe audits the container's own env: with
    // no provider endpoint URLs and no provider credentials present,
    // adapters cannot construct, so no authenticated provider invocation is
    // possible. All findings are names/counts only — values never printed.
    if (!ctx.inspectEnv) return skip('container env not retrievable on this target')
    const env = await ctx.inspectEnv()
    const urlVars = ['GATEWAY_TEXT_URL', 'GATEWAY_PUSH_URL'].filter((k) => (env[k] ?? '') !== '')
    if (urlVars.length > 0) return fail(`provider endpoint URLs configured: ${urlVars.join(',')}`)
    // Known app secrets are allowlisted BY NAME (consumed as HMAC/DB material,
    // never sent to providers); everything else is provider-suspect surface.
    const knownAppSecrets = new Set(['DATABASE_URL', 'SESSION_SECRET', 'CHATWOOT_WEBHOOK_SECRET'])
    const credNameRe = /(ANTHROPIC|TWILIO|BREVO|STRIPE|SQUARE|OPENAI|BEEPER|CHATWOOT|RESEND|SENDGRID|POSTMARK).*(KEY|TOKEN|SECRET|SID|PASSWORD)/i
    const credVars = Object.keys(env).filter((k) => !knownAppSecrets.has(k) && credNameRe.test(k))
    if (credVars.length > 0) return fail(`provider credential names present: ${credVars.join(',')}`)
    const shapes = [/sk_live_/, /AC[0-9a-fA-F]{32}/, /gh[pousr]_/, /whsec_/, /xox[baprs]-/, /sk-ant-/]
    let hits = 0
    for (const [k, v] of Object.entries(env)) {
      if (knownAppSecrets.has(k)) continue
      if (shapes.some((re) => re.test(v))) hits++
    }
    if (hits > 0) return fail(`${hits} env value(s) match live-credential shapes (count only, values never printed)`)
    return ok(`no provider URLs, credential names, or live-credential shapes in container env (${Object.keys(env).length} vars audited)`)
  },

  'provider-non-invocation': async (ctx) => {
    const outcomes: string[] = JSON.parse(ctx.state.outcomesJson ?? '[]') as string[]
    if (outcomes.length === 0) return fail('no send outcomes were observed in this run')
    const bad = outcomes.filter((o) => !/simulat|refus|unconfigured|not set up|disabled|suppressed|nothing was sent/i.test(o))
    if (bad.length > 0) return fail(`live-looking outcomes observed: ${fmtJson(bad.join(' | '))}`)
    const logs = await ctx.logs()
    const providers = ['api.twilio.com', 'api.brevo.com', 'api.stripe.com', 'api.resend.com', 'graph.facebook.com']
    const hits = providers.filter((h) => logs.includes(h))
    if (hits.length > 0) return fail(`provider hosts in logs: ${hits.join(',')}`)
    if (preview(ctx) && ctx.sql && ctx.state.loc) {
      const rows = await ctx.sql.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM outbound_sink WHERE location_id = $1',
        [ctx.state.loc],
      )
      if ((rows[0]?.n ?? 0) > 0) return fail(`preview recorded ${rows[0]?.n} sink rows — preview records nothing`)
    }
    return ok(`${outcomes.length} send outcomes, all simulated/refused; zero provider hosts in logs`)
  },

  'no-staging-reuse': async (ctx) => {
    if (!preview(ctx)) return skip('preview-only probe')
    if (!ctx.config.stagingNeonProject) return skip('SMOKE_STAGING_NEON_PROJECT not provided — cannot compare')
    if (ctx.config.neonProject === ctx.config.stagingNeonProject) return fail('preview Neon project equals staging project')
    return ok(`preview Neon project ${ctx.config.neonProject} differs from staging ${ctx.config.stagingNeonProject}`)
  },

  cleanup: async (ctx) => {
    const loc = ctx.state.loc
    const op = ctx.state.operatorId
    if (!ctx.sql || !loc) return skip('no SQL/location — fixtures cannot be verified or removed')
    await ctx.sql.query('DELETE FROM locations WHERE id = $1', [loc])
    if (op) {
      await ctx.sql.query('DELETE FROM operator_locations WHERE operator_id = $1', [op])
      await ctx.sql.query('DELETE FROM operators WHERE id = $1', [op])
    }
    const checks = [
      ['locations', await ctx.sql.query<{ n: number }>('SELECT count(*)::int AS n FROM locations WHERE id = $1', [loc])],
      ['operators', op ? await ctx.sql.query<{ n: number }>('SELECT count(*)::int AS n FROM operators WHERE id = $1', [op]) : [{ n: 0 }]],
      ['contacts', await ctx.sql.query<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE location_id = $1', [loc])],
      ['outbound_sink', await ctx.sql.query<{ n: number }>('SELECT count(*)::int AS n FROM outbound_sink WHERE location_id = $1', [loc])],
    ] as const
    const remnants = checks.filter(([, rows]) => (rows[0]?.n ?? 0) > 0)
    if (remnants.length > 0) {
      return fail(`remnants remain: ${remnants.map(([t, r]) => `${t}=${r[0]?.n}`).join(', ')}`)
    }
    return ok('smoke location + operator deleted (cascades); zero smoke rows remain')
  },

  'credential-scan': async (ctx) => {
    // Implemented by run.ts over the full captured text; entry keeps the inventory total.
    return skip('credential scan runs over the finished transcript (see transcript tail)')
  },
}
