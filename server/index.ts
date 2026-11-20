import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import type { PgBoss } from 'pg-boss'
import { Hono } from 'hono'
import { Pool } from 'pg'
import type { AppEnv } from './app-env'
import { PgDatabase } from './db/database'
import type { Database } from './db/database'
import type { ClaudeClient } from './jobs/agent-reply'
import {
  enqueueAgentReply,
  enqueueWorkflowEvent,
  reapStaleWaits,
  registerAgentReplyWorker,
  registerOutboxSweeper,
  registerWorkflowDispatchWorker,
  registerWorkflowResumeWorker,
  startBoss,
} from './jobs/boss'
import type { WorkflowDispatch } from './jobs/workflow-dispatcher'
import { createAnthropicClient } from './lib/anthropic'
import type { sendChatwootMessage } from './lib/chatwoot-client'
import { isPreviewMode, loadConfig } from './lib/config'
import { ContactIdentityConflict } from './repos/contacts-repo'
import {
  SHUTDOWN_DEADLINE_MS,
  type Readiness,
  attachBossErrorHandler,
  attachPoolErrorHandler,
  attachProcessErrorHandlers,
  createReadiness,
  createShutdown,
  parseRole,
  withDeadline,
} from './lib/lifecycle'
import { notifyPush } from './lib/notify-push'
import { injectPreviewBanner } from './lib/preview-banner'
import { reportError } from './lib/secrets'
import { assertLocationNamespacesUnique } from './lib/vault'
import type { SendTextFn } from './lib/operator-tools'
import { makeHttpSendText } from './lib/send-text-rail'
import { operatorAuth } from './middleware/auth'
import { locationAccess } from './middleware/location-access'
import { requireOwner } from './middleware/require-owner'
import { affiliatesRoute } from './routes/affiliates'
import { assistantRoute } from './routes/assistant'
import { authRoute } from './routes/auth'
import { blogRoute } from './routes/blog'
import { calendarsRoute } from './routes/calendars'
import { callsRoute } from './routes/calls'
import { campaignsRoute } from './routes/campaigns'
import { communitiesRoute } from './routes/communities'
import { contactsRoute } from './routes/contacts'
import { conversationsRoute } from './routes/conversations'
import { coursesRoute } from './routes/courses'
import { customFieldsRoute } from './routes/custom-fields'
import { customValuesRoute } from './routes/custom-values'
import { federationRoute } from './routes/federation'
import { formsRoute } from './routes/forms'
import { funnelsRoute } from './routes/funnels'
import { invoicesRoute } from './routes/invoices'
import { locationsRoute } from './routes/locations'
import { opportunitiesRoute } from './routes/opportunities'
import { couponsRoute } from './routes/coupons'
import { pipelinesRoute } from './routes/pipelines'
import { productsRoute } from './routes/products'
import { proposalsRoute } from './routes/proposals'
import { pushTokensRoute } from './routes/push-tokens'
import { settingsRoute } from './routes/settings'
import { subscriptionsRoute } from './routes/subscriptions'
import { transactionsRoute } from './routes/transactions'
import { publicAffiliatesRoute } from './routes/public-affiliates'
import { publicBlogRoute } from './routes/public-blog'
import { publicBookingRoute } from './routes/public-booking'
import { publicCommunitiesRoute } from './routes/public-communities'
import { publicCoursesRoute } from './routes/public-courses'
import { publicFormsRoute } from './routes/public-forms'
import { publicFunnelsRoute } from './routes/public-funnels'
import { publicProposalsRoute } from './routes/public-proposals'
import { publicReviewsRoute } from './routes/public-reviews'
import { publicSurveysRoute } from './routes/public-surveys'
import { publicTriggerLinksRoute } from './routes/public-trigger-links'
import { reportingRoute } from './routes/reporting'
import { reviewsRoute } from './routes/reviews'
import { socialRoute } from './routes/social'
import { surveysRoute } from './routes/surveys'
import { tagsRoute } from './routes/tags'
import { tasksRoute } from './routes/tasks'
import { templatesRoute } from './routes/templates'
import { triggerLinksRoute } from './routes/trigger-links'
import { type InboundEvent, chatwootWebhookRoute } from './routes/webhooks-chatwoot'
import { paymentsWebhookRoute } from './routes/webhooks-payments'
import { voiceWebhookRoute } from './routes/webhooks-voice'
import { workflowsRoute } from './routes/workflows'

export interface AppDeps {
  db: Database
  sessionSecret: string
  webhookSecret: string
  /** Set Secure on the session cookie (true in production over HTTPS). */
  secure?: boolean
  /** Phase E hook: enqueue the agent-reply job after a fresh inbound. */
  onInbound?: (e: InboundEvent) => void | Promise<void>
  /** Phase 7 hook: fan a trigger event out to its live workflows. */
  dispatch?: WorkflowDispatch
  /** Claude client for the "Draft from agent" composer button. */
  claude?: ClaudeClient
  /** Injectable Chatwoot sender — dev-server stubs it so Send works offline. */
  sendMessage?: typeof sendChatwootMessage
  /** The gateway text rail for the assistant's approve-first send_text. Prod
   *  injects the real HTTP rail; absent = texting honestly reports "not set up". */
  sendText?: SendTextFn
  /** The hub gateway's shared bearer for /federation/*. Unset => surface is 503. */
  federationServiceToken?: string
  /** G1: manual workflow test runs honor the wait kill-switch; unset = disabled. */
  waitsEnabled?: boolean
  /**
   * Directory of the built Vite bundle (production only). When set, exact
   * files serve same-origin and unknown non-API GETs fall back to
   * index.html for client routing. Unset in dev/tests (Vite owns the UI).
   */
  staticDir?: string
  /**
   * Readiness probe for GET /ready. Bootstrap wires the real one (lifecycle
   * cell + live DB ping); unset in tests, where /ready honestly reports the
   * app never finished booting.
   */
  readiness?: () => Promise<Readiness>
  /**
   * Restricted production preview (R14-11): bootstrap sets this from the
   * validated config. When true the API advertises preview mode (public
   * /api/client-config) so the UI renders the non-production banner.
   */
  preview?: boolean
}

/**
 * Builds the full Hono app. Pure (no I/O at construction) so tests mount it with
 * a FakeDatabase. Route groups:
 *   - public:        /health, /api/auth/*, /api/webhooks/chatwoot (own secret), /api/public/{f,forms,proposals}/* (hosted funnel + form + proposal pages)
 *   - operator-auth: /api/locations
 *   - auth + tenant: /api/loc/:loc/{contacts,conversations,opportunities,calendars,campaigns,workflows,reporting,funnels,forms,invoices,surveys,proposals}/*  (locationAccess -> 403)
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Liveness: the event loop turns and routes answer. No I/O, always 200 —
  // a process that can run this handler is alive by definition.
  app.get('/health', (c) => c.json({ ok: true, service: 'openlevel' }))

  // Readiness: may this instance take traffic / is the release good? The
  // probe owns the verdict; reasons are short enums, never errors, URLs, or
  // stacks. Unwired (tests) means boot never ran: honestly not ready.
  app.get('/ready', async (c) => {
    const probe = deps.readiness ?? (async (): Promise<Readiness> => ({ ready: false, reason: 'starting' }))
    const state = await probe()
    if (state.ready) return c.json({ ready: true })
    return c.json({ ready: false, reason: state.reason }, 503)
  })

  // Public client config (R14-11): the SPA reads this to decide whether to
  // render the restricted-preview banner. Unauthenticated by design — the
  // preview label is itself public information, and the banner must render
  // on public pages too. Carries no secrets, ids, or URLs.
  app.get('/api/client-config', (c) => c.json({ preview: deps.preview === true }))

  // FIND-01: explicit error boundary. Without this, Hono's default handler
  // console.errors the RAW exception (pg errors embed the connection
  // string) into Fly logs. Thrown errors report scrubbed server-side with
  // method+path context (path excludes the query string, which may carry a
  // webhook secret); the client gets a generic 500 that leaks nothing.
  // Deliberate 4xx responses are returned, never thrown, so this only fires
  // on genuine faults.
  app.onError((err, c) => {
    // R13-12: contact-identity refusals surface as structured 409s from every
    // capture path at once (no route catches this type today). The message
    // names the policy and the contact ids are non-secret resolution handles.
    if (err instanceof ContactIdentityConflict) {
      return c.json({ error: err.message, code: err.code, contactIds: err.contactIds }, 409)
    }
    reportError(`http ${c.req.method} ${c.req.path}`, err)
    return c.json({ error: 'internal error' }, 500)
  })

  app.route('/api/auth', authRoute({ db: deps.db, sessionSecret: deps.sessionSecret, secure: deps.secure }))
  app.route(
    '/api/webhooks/chatwoot',
    chatwootWebhookRoute({
      db: deps.db,
      webhookSecret: deps.webhookSecret,
      onInbound: deps.onInbound,
      dispatch: deps.dispatch,
    }),
  )
  // Public hosted funnel + form pages — unauthenticated, read location from the
  // URL. Mounted before the operatorAuth boundary so visitors never hit a login.
  app.route('/api/public/f', publicFunnelsRoute({ db: deps.db, dispatch: deps.dispatch }))
  app.route('/api/public/forms', publicFormsRoute({ db: deps.db, dispatch: deps.dispatch }))
  app.route('/api/public/reviews', publicReviewsRoute({ db: deps.db }))
  app.route('/api/public/courses', publicCoursesRoute({ db: deps.db }))
  app.route('/api/public/blog', publicBlogRoute({ db: deps.db }))
  // Public hosted community space — read-only feed of published communities.
  app.route('/api/public/communities', publicCommunitiesRoute({ db: deps.db }))
  app.route('/api/public/surveys', publicSurveysRoute({ db: deps.db, dispatch: deps.dispatch }))
  // Public signable proposal pages — render, sign, decline; a signature fires the
  // proposal_signed trigger so an accepted proposal can start an automation.
  app.route('/api/public/proposals', publicProposalsRoute({ db: deps.db, dispatch: deps.dispatch }))
  // Trigger links redirect + record a click, then fire trigger_link_clicked, so
  // the public hop carries the dispatch like funnels/forms do.
  app.route('/api/public/l', publicTriggerLinksRoute({ db: deps.db, dispatch: deps.dispatch }))
  // Affiliate referral links: record the visit (attributed when ?c= names a real
  // contact), then 302 to the program landing URL. Self-contained — no dispatch.
  app.route('/api/public/ref', publicAffiliatesRoute({ db: deps.db }))
  // Hosted booking pages: pick a day + time, leave details. A booking creates a
  // contact + appointment and fires appointment_booked into live automations.
  app.route('/api/public/booking', publicBookingRoute({ db: deps.db, dispatch: deps.dispatch }))
  // Payment-processor webhooks + the post-checkout landing page. Signature-
  // verified per location; a completed checkout marks the invoice paid.
  app.route('/api/public/pay', paymentsWebhookRoute({ db: deps.db }))
  // Voice-provider webhooks (Twilio status callbacks / Vapi call reports).
  // Signature-verified per location; events keep the call log honest.
  app.route('/api/public/voice', voiceWebhookRoute({ db: deps.db }))

  // The Acme Hub federation surface. Mounted OUTSIDE the operator-session
  // boundary because it carries its own bearer gate (the hub gateway's shared
  // service token); it is inert (503) until federationServiceToken is set. The
  // tenant rides in the trusted X-Federation-Tenant header, never the body.
  app.route(
    '/',
    federationRoute({
      db: deps.db,
      federationServiceToken: deps.federationServiceToken,
      claude: deps.claude,
      sendText: deps.sendText,
    }),
  )

  app.use('/api/locations', operatorAuth(deps.sessionSecret))
  app.use('/api/locations', requireOwner(deps.db))
  app.route('/api/locations', locationsRoute({ db: deps.db }))

  app.use('/api/push-tokens', operatorAuth(deps.sessionSecret))
  app.use('/api/push-tokens', requireOwner(deps.db))
  app.route('/api/push-tokens', pushTokensRoute({ db: deps.db }))

  app.use('/api/loc/:loc/*', operatorAuth(deps.sessionSecret))
  app.use('/api/loc/:loc/*', locationAccess(deps.db))
  app.route('/api/loc/:loc/contacts', contactsRoute({ db: deps.db, dispatch: deps.dispatch }))
  app.route(
    '/api/loc/:loc/conversations',
    conversationsRoute({ db: deps.db, claude: deps.claude, sendMessage: deps.sendMessage }),
  )
  // The "AI front door" — operator chats in plain English, the assistant reads
  // across the location with its tools and answers, and (approve-first) drafts a
  // text the operator confirms. The confirm tap is the only send path; deps.sendText
  // is the gateway rail it goes through. 501 when no Claude client is configured.
  app.route(
    '/api/loc/:loc/assistant',
    assistantRoute({ db: deps.db, claude: deps.claude, sendText: deps.sendText, dispatch: deps.dispatch }),
  )
  app.route('/api/loc/:loc/opportunities', opportunitiesRoute({ db: deps.db, dispatch: deps.dispatch }))
  // Pipeline + stage *structure* management (the Settings -> Pipelines area). The
  // opportunities route owns the board reads/writes; this owns create/rename/
  // delete of pipelines and their stages, with guarded deletes (never a silent
  // cascade over live deals).
  app.route('/api/loc/:loc/pipelines', pipelinesRoute({ db: deps.db }))
  app.route('/api/loc/:loc/calendars', calendarsRoute({ db: deps.db, dispatch: deps.dispatch }))
  app.route('/api/loc/:loc/campaigns', campaignsRoute({ db: deps.db }))
  app.route('/api/loc/:loc/workflows', workflowsRoute({ db: deps.db, waitsEnabled: deps.waitsEnabled }))
  app.route('/api/loc/:loc/reporting', reportingRoute({ db: deps.db }))
  app.route('/api/loc/:loc/funnels', funnelsRoute({ db: deps.db }))
  app.route('/api/loc/:loc/forms', formsRoute({ db: deps.db }))
  app.route('/api/loc/:loc/invoices', invoicesRoute({ db: deps.db }))
  // The reusable product/service catalog (Payments -> Products): saved items an
  // invoice or proposal can be built from. Editing it never sends or moves money.
  app.route('/api/loc/:loc/products', productsRoute({ db: deps.db }))
  // Recurring-commitment ledger (Payments -> Subscriptions): tracks who is on a
  // recurring arrangement and derives MRR and renewals. Bookkeeping only — it
  // never charges a card or moves money.
  app.route('/api/loc/:loc/subscriptions', subscriptionsRoute({ db: deps.db }))
  // Reusable discount codes (Payments -> Coupons): definitions a later module can
  // apply to an invoice total. Bookkeeping only — defining or applying a coupon
  // never charges a card or moves money.
  app.route('/api/loc/:loc/coupons', couponsRoute({ db: deps.db }))
  // The Transactions ledger (Payments -> Transactions): a read-only projection of
  // invoices that carry a recorded payment. There is no create/charge path —
  // OpenLevel never moves money, so a row exists only because an operator wrote
  // down a payment, and each amount is derived from that invoice line items.
  app.route('/api/loc/:loc/transactions', transactionsRoute({ db: deps.db }))
  // The call log + click-to-call (Module 52). Calls run inside the location's
  // own Twilio/Vapi account; this only places them and mirrors what the
  // provider reports. Operator-only — the AI agent has no call tool.
  app.route('/api/loc/:loc/calls', callsRoute({ db: deps.db }))
  app.route('/api/loc/:loc/reviews', reviewsRoute({ db: deps.db }))
  app.route('/api/loc/:loc/courses', coursesRoute({ db: deps.db }))
  app.route('/api/loc/:loc/blog', blogRoute({ db: deps.db }))
  app.route('/api/loc/:loc/communities', communitiesRoute({ db: deps.db }))
  app.route('/api/loc/:loc/social', socialRoute({ db: deps.db }))
  app.route('/api/loc/:loc/surveys', surveysRoute({ db: deps.db }))
  app.route('/api/loc/:loc/proposals', proposalsRoute({ db: deps.db }))
  app.route('/api/loc/:loc/trigger-links', triggerLinksRoute({ db: deps.db }))
  app.route('/api/loc/:loc/affiliates', affiliatesRoute({ db: deps.db }))
  // Cross-contact task worklist (the global "Tasks" page). Writes happen through
  // the nested /contacts/:id/tasks routes; this is read-only aggregation.
  app.route('/api/loc/:loc/tasks', tasksRoute({ db: deps.db }))
  app.route('/api/loc/:loc/templates', templatesRoute({ db: deps.db }))
  // Location-wide tag management (the "Tags" settings area). Per-contact tag
  // add/remove lives on the nested /contacts/:id/tags routes; this is the
  // distinct-set view plus rename/delete across every contact.
  app.route('/api/loc/:loc/tags', tagsRoute({ db: deps.db }))
  // Custom-field *definitions* (the "Custom Fields" settings area). Per-contact
  // values are written through the nested /contacts/:id/custom-fields/:key route;
  // this manages the field definitions themselves.
  app.route('/api/loc/:loc/custom-fields', customFieldsRoute({ db: deps.db }))
  // Custom *values*: location-level constants (business name, booking link, etc.)
  // referenced as {{custom_values.<key>}} merge tags in templates and automations.
  app.route('/api/loc/:loc/custom-values', customValuesRoute({ db: deps.db }))
  // AI Agent settings (the "AI Agent" settings area): reply mode (approve-first /
  // autonomous) + the agent's persona, instructions, and knowledge-base facts.
  app.route('/api/loc/:loc/settings', settingsRoute({ db: deps.db }))

  // Production-only static bundle, registered LAST so no API, health, or
  // federation route is ever shadowed. When staticDir is unset (dev, tests)
  // these routes do not exist at all and unknown paths stay 404.
  if (deps.staticDir !== undefined) {
    const root = deps.staticDir
    const staticFiles = serveStatic({ root })
    const spaFallback = serveStatic({ path: join(root, 'index.html') })
    // Preview banner (R14-11): in validated preview mode the exact-wording
    // label ships inside the served document (/, plus every SPA fallback),
    // with no JavaScript needed. Assets are never touched.
    const previewShell = (): string => injectPreviewBanner(readFileSync(join(root, 'index.html'), 'utf8'))
    app.use('/*', async (c, next) => {
      if (deps.preview === true && c.req.path === '/') return c.html(previewShell())
      return staticFiles(c, next)
    })
    app.get('*', async (c, next) => {
      const path = c.req.path
      if (path === '/health' || path.startsWith('/api/') || path.startsWith('/federation/')) {
        return next()
      }
      if (deps.preview === true) return c.html(previewShell())
      return spaFallback(c, next)
    })
  }

  return app
}

async function bootstrap() {
  const config = loadConfig()
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required to boot the server')
  const role = parseRole(config.ROLE) // throws on unknown values: fail closed
  const serveHttp = role === 'web' || role === 'all'
  const runBoss = role === 'worker' || role === 'all'
  // Production serves the built SPA same-origin; dev/test leave staticDir
  // unset (Vite owns the UI there). Fail fast when the bundle is missing so
  // a deploy without `npm run build` never ships silent 404s. Workers serve
  // no HTTP, so they never need the bundle.
  const staticDir =
    serveHttp && config.NODE_ENV === 'production'
      ? fileURLToPath(new URL('../dist', import.meta.url))
      : undefined
  if (staticDir !== undefined && !existsSync(join(staticDir, 'index.html'))) {
    throw new Error(
      `production static bundle missing: expected ${join(staticDir, 'index.html')} — run \`npm run build\` first`,
    )
  }
  const pool = new Pool({ connectionString: config.DATABASE_URL })
  attachPoolErrorHandler(pool, reportError)
  const db = new PgDatabase(pool)
  // N7: tenant secret namespaces must be collision-free before serving —
  // two locations normalizing to one namespace would share credentials.
  await assertLocationNamespacesUnique(db)
  const readiness = createReadiness()
  let boss: PgBoss | null = null
  let server: { close(cb: (err?: Error) => void): void; closeAllConnections?: () => void } | null = null

  // Everything from here can fail after acquiring resources; the catch below
  // unwinds newest-first so a failed boot leaks no boss pollers, listeners,
  // or pools (Review 11 P2).
  try {
    // Jobs: pg-boss runs the agent-reply + workflow-dispatch workers; routes and
    // the webhook enqueue onto them. Every role starts boss (pg-boss requires
    // start() before send()); only worker/all register consumers, so web
    // Machines enqueue without ever consuming.
    boss = await startBoss(config.DATABASE_URL)
    // From here on the local alias is non-null; the outer `boss` stays
    // nullable so the catch block can tell "never started" from "started".
    const startedBoss: PgBoss = boss
    attachBossErrorHandler(startedBoss, reportError)
    const dispatch: WorkflowDispatch = (e) => enqueueWorkflowEvent(startedBoss, e)
    if (runBoss) {
      // The autonomous agent books/tags through real tools; thread the dispatcher
      // so an agent-booked appointment fires appointment_booked like the page.
      const waitsEnabled = config.WORKFLOW_WAITS_ENABLED === 'true'
      await registerAgentReplyWorker(boss, { db, claude: createAnthropicClient(), dispatch })
      await registerWorkflowDispatchWorker(boss, { db, waitsEnabled })
      await registerOutboxSweeper(boss, { db, dispatch })
      if (waitsEnabled) {
        await registerWorkflowResumeWorker(boss, { db, waitsEnabled })
        // Boot reaper (FIND-06): waits orphaned by a previous crash/shutdown get
        // their resume jobs re-enqueued; the atomic claim keeps this safe to run
        // on every boot, including concurrent boots during a deploy.
        const reaped = await reapStaleWaits(db, boss)
        if (reaped > 0) console.log(`openlevel env=${config.APP_ENV} reaped ${reaped} stale workflow wait(s)`)
      } else {
        // G1: no resume consumer, no reaper, and the runner refuses wait steps
        // loudly — wait-dependent workflows cannot silently strand anywhere.
        console.log(`openlevel env=${config.APP_ENV} workflow waits disabled — resume worker not registered`)
      }
    }

    // Readiness = lifecycle phase AND a live DB ping. The ping is bounded so
    // a wedged pool degrades the check instead of hanging it; failures map to
    // short reasons, never errors or connection strings.
    const probe = async (): Promise<Readiness> => {
      const phase = readiness.snapshot()
      if (!phase.ready) return phase
      try {
        const pong = await Promise.race([
          pool.query('SELECT 1').then((): boolean => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
        ])
        if (!pong) return { ready: false, reason: 'db-timeout' }
      } catch {
        return { ready: false, reason: 'db' }
      }
      return { ready: true }
    }

    // Pure construction (no I/O) — built in every role, served only when the
    // role listens. Workers construct it solely so the file stays simple; they
    // never accept a connection.
    const app = createApp({
      db,
      sessionSecret: config.SESSION_SECRET,
      webhookSecret: config.CHATWOOT_WEBHOOK_SECRET,
      secure: config.NODE_ENV === 'production',
      readiness: probe,
      preview: isPreviewMode(config),
      staticDir,
      claude: createAnthropicClient(),
      waitsEnabled: config.WORKFLOW_WAITS_ENABLED === 'true',
      dispatch,
      // The approve-first text rail. Injected unconditionally — the env vars are the
      // deployment control, NOT a feature flag (no dormant texting toggle). When
      // GATEWAY_TEXT_URL/INTERNAL_PUSH_SECRET are unset, the rail honestly reports
      // "not set up" rather than silently dropping. Reuses the gateway's internal
      // push secret; the gateway owns the Beeper credential, OpenLevel never sees it.
      sendText: makeHttpSendText({
        url: config.GATEWAY_TEXT_URL ?? '',
        secret: config.INTERNAL_PUSH_SECRET ?? '',
      }),
      // The hub gateway's shared bearer for /federation/*. Unset => that surface
      // stays inert (503); the env var is the deployment control, not a feature flag.
      federationServiceToken: config.FEDERATION_SERVICE_TOKEN,
      // A fresh inbound both drafts an agent reply and fires the inbound_message
      // trigger so message-triggered workflows enroll the contact.
      onInbound: async (e) => {
        await enqueueAgentReply(startedBoss, {
          locationId: e.locationId,
          conversationId: e.conversationId,
          contactId: e.contactId,
          messageId: e.messageId,
        })
        await enqueueWorkflowEvent(startedBoss, {
          locationId: e.locationId,
          triggerType: 'inbound_message',
          contactId: e.contactId,
          eventId: randomUUID(),
        })
        // Nudge the Hub Android app out-of-process: a fresh inbound just landed.
        // Fire-and-forget — a down/unconfigured gateway must never block ingestion.
        void notifyPush(
          { url: config.GATEWAY_PUSH_URL ?? '', secret: config.INTERNAL_PUSH_SECRET ?? '' },
          {
            source: 'openlevel',
            title: e.contactName ? `New message — ${e.contactName}` : 'New OpenLevel message',
            body: (e.preview ?? '').slice(0, 140),
            data: { conversationId: e.conversationId, locationId: e.locationId },
          },
        )
      },
    })
    const log = (msg: string) => console.log(`openlevel env=${config.APP_ENV} ${msg}`)
    // Release evidence (FIND-10): Fly sets FLY_IMAGE_REF to the running image;
    // logging it at boot binds every log line to an immutable release.
    if (process.env.FLY_IMAGE_REF) log(`image ${process.env.FLY_IMAGE_REF}`)
    if (process.env.RELEASE_COMMIT) log(`release ${process.env.RELEASE_COMMIT}`)
    // Restricted preview is LOUD at boot: no one reading the logs mistakes
    // this deployment for live production.
    if (isPreviewMode(config)) {
      log('RESTRICTED PREVIEW — external effects disabled, synthetic data only, NOT production-ready')
    }

    if (serveHttp) {
      // markReady fires only once the listener accepts AND (for all) the
      // workers above registered — boot ordering is the boss-readiness proof.
      server = serve({ fetch: app.fetch, port: config.PORT }, () => {
        readiness.markReady()
        log(`api (role=${role}) listening on :${config.PORT}`)
      })
      armSignals(createShutdown({ server, boss, pool, readiness, log }))
    } else {
      armSignals(createShutdown({ boss, pool, readiness, log }))
      readiness.markReady()
      log(`worker (role=${role}) consuming agent.reply.dispatch, workflow.dispatch`)
    }
  } catch (err) {
    // Partial boot: unwind newest-first. Each step is best-effort with a
    // scrubbed note — a failing close must never mask the original error,
    // which propagates to the entry-point handler (redacted, exit 1).
    if (server) {
      try {
        server.closeAllConnections?.()
      } catch {}
      try {
        server.close(() => {})
      } catch {}
    }
    if (boss) {
      try {
        await boss.stop({ timeout: 5000 })
      } catch (cleanupErr) {
        reportError('boot-cleanup-boss', cleanupErr)
      }
    }
    try {
      await pool.end()
    } catch (cleanupErr) {
      reportError('boot-cleanup-pool', cleanupErr)
    }
    throw err
  }
}

/**
 * SIGTERM (Fly deploys) and SIGINT (Ctrl-C) run the ordered shutdown inside
 * SHUTDOWN_DEADLINE_MS, then exit 0 on a clean drain, 1 on a deadline
 * overrun. A second signal exits immediately — an operator hammering Ctrl-C
 * (or Fly's SIGKILL at kill_timeout) must never hang behind a stuck drain.
 */
function armSignals(shutdown: () => Promise<void>): void {
  let signals = 0
  const onSignal = (name: string) => {
    signals += 1
    if (signals > 1) {
      console.log(`openlevel ${name} again, exiting immediately`)
      process.exit(1)
    }
    console.log(`openlevel ${name} received, shutting down`)
    void withDeadline(shutdown, SHUTDOWN_DEADLINE_MS).then((clean) => {
      console.log(clean ? 'openlevel shutdown clean' : 'openlevel shutdown deadline exceeded')
      process.exit(clean ? 0 : 1)
    })
  }
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('SIGINT', () => onSignal('SIGINT'))
}

// Boot only when run directly (tsx server/index.ts), never on import (tests).
const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  // All process-boundary failures report through the central boundary:
  // pg/driver errors embed the connection string, so the raw error object
  // must never reach stderr. Fatals exit(1); boot failure exits(1) too.
  attachProcessErrorHandlers(reportError)
  bootstrap().catch((err) => {
    reportError('boot', err)
    process.exit(1)
  })
}

