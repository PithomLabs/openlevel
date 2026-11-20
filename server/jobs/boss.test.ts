import {
  AGENT_REPLY_DLQ,
  AGENT_REPLY_QUEUE,
  OUTBOX_SWEEP_CRON,
  OUTBOX_SWEEP_DLQ,
  OUTBOX_SWEEP_QUEUE,
  WORKFLOW_DISPATCH_DLQ,
  WORKFLOW_DISPATCH_QUEUE,
  WORKFLOW_RESUME_DLQ,
  WORKFLOW_RESUME_QUEUE,
  ensureQueues,
  registerAgentReplyWorker,
  registerOutboxSweeper,
  registerWorkflowDispatchWorker,
} from './boss'

type CreatedQueue = { name: string; options?: Record<string, unknown> }

/** A boss stand-in that records how each queue is created — enough to prove the
 *  durability policy actually reaches createQueue, without a live Postgres. */
function fakeQueueBoss() {
  const created: CreatedQueue[] = []
  const boss = {
    createQueue: async (name: string, options?: Record<string, unknown>) => {
      created.push({ name, options })
    },
  }
  return { boss, created }
}

test('ensureQueues gives the work queues backoff retry instead of pg-boss immediate-retry', async () => {
  const { boss, created } = fakeQueueBoss()
  await ensureQueues(boss as never)

  for (const name of [AGENT_REPLY_QUEUE, WORKFLOW_DISPATCH_QUEUE, OUTBOX_SWEEP_QUEUE, WORKFLOW_RESUME_QUEUE]) {
    const q = created.find((c) => c.name === name)
    expect(q, `${name} was created`).toBeDefined()
    expect(q?.options?.retryBackoff).toBe(true) // spaced-out, not instant
    expect(q?.options?.retryDelay as number).toBeGreaterThan(0) // a real first delay
    expect(q?.options?.retryLimit as number).toBeGreaterThan(2) // more than the default of 2
    expect(q?.options?.retryDelayMax as number).toBeGreaterThan(0) // capped, never unbounded
  }
})

test('ensureQueues dead-letters each work queue, and the DLQ exists before it is referenced', async () => {
  const { boss, created } = fakeQueueBoss()
  await ensureQueues(boss as never)

  const order = created.map((c) => c.name)
  // a queue may only name a dead-letter target that already exists
  expect(order.indexOf(AGENT_REPLY_DLQ)).toBeLessThan(order.indexOf(AGENT_REPLY_QUEUE))
  expect(order.indexOf(WORKFLOW_DISPATCH_DLQ)).toBeLessThan(order.indexOf(WORKFLOW_DISPATCH_QUEUE))
  expect(order.indexOf(OUTBOX_SWEEP_DLQ)).toBeLessThan(order.indexOf(OUTBOX_SWEEP_QUEUE))
  expect(order.indexOf(WORKFLOW_RESUME_DLQ)).toBeLessThan(order.indexOf(WORKFLOW_RESUME_QUEUE))

  expect(created.find((c) => c.name === AGENT_REPLY_QUEUE)?.options?.deadLetter).toBe(AGENT_REPLY_DLQ)
  expect(created.find((c) => c.name === WORKFLOW_DISPATCH_QUEUE)?.options?.deadLetter).toBe(
    WORKFLOW_DISPATCH_DLQ,
  )
  expect(created.find((c) => c.name === OUTBOX_SWEEP_QUEUE)?.options?.deadLetter).toBe(OUTBOX_SWEEP_DLQ)
  expect(created.find((c) => c.name === WORKFLOW_RESUME_QUEUE)?.options?.deadLetter).toBe(WORKFLOW_RESUME_DLQ)
})

test('both workers register at one job per fetch so a failure cannot poison its batch', async () => {
  const works: { name: string; options: Record<string, unknown> }[] = []
  const boss = {
    work: async (name: string, options: Record<string, unknown>, _handler: unknown) => {
      works.push({ name, options })
      return name
    },
  }
  // deps are never touched — the handler is captured, not invoked
  await registerAgentReplyWorker(boss as never, {} as never)
  await registerWorkflowDispatchWorker(boss as never, {} as never)

  expect(works.find((w) => w.name === AGENT_REPLY_QUEUE)?.options.batchSize).toBe(1)
  expect(works.find((w) => w.name === WORKFLOW_DISPATCH_QUEUE)?.options.batchSize).toBe(1)
})

test('the outbox sweeper registers a single-job worker plus a cron schedule (FIND-07)', async () => {
  const works: { name: string; options: Record<string, unknown> }[] = []
  const schedules: { name: string; cron: string }[] = []
  const boss = {
    work: async (name: string, options: Record<string, unknown>, _handler: unknown) => {
      works.push({ name, options })
      return name
    },
    schedule: async (name: string, cron: string) => {
      schedules.push({ name, cron })
    },
  }
  await registerOutboxSweeper(boss as never, {} as never)
  expect(works.find((w) => w.name === OUTBOX_SWEEP_QUEUE)?.options.batchSize).toBe(1)
  expect(schedules).toEqual([{ name: OUTBOX_SWEEP_QUEUE, cron: OUTBOX_SWEEP_CRON }])
  expect(OUTBOX_SWEEP_CRON).toBe('* * * * *')
})

test('the registered reply handler runs handleAgentReply for each job in the batch', async () => {
  let handler: ((jobs: { data: unknown }[]) => Promise<unknown>) | undefined
  const boss = {
    work: async (_name: string, _options: unknown, h: (jobs: { data: unknown }[]) => Promise<unknown>) => {
      handler = h
      return 'wid'
    },
  }
  // A deps whose only exercised member is the location lookup, which returns
  // none → handleAgentReply takes its `skipped` path without needing a model.
  // The FIRST query is the processed_events claim (won), the second the lookup.
  const seen: unknown[] = []
  let calls = 0
  const deps = {
    db: {
      query: async (sql: string, params: unknown[]) => {
        seen.push({ sql, params })
        calls += 1
        if (calls === 1) return [{ event_id: 'm1' }] // claim won
        return [] // LocationsRepo.getById → none → skipped: 'location not found'
      },
    },
    claude: { createMessage: async () => ({ stopReason: null, content: [] }) },
    resolveSecret: () => 'sk',
  }
  await registerAgentReplyWorker(boss as never, deps as never)
  expect(handler).toBeDefined()

  // Driving the handler with one job must invoke handleAgentReply (which reads
  // the location) — proving the worker is actually wired to the job's data.
  await handler!([{ data: { locationId: 'locZ', conversationId: 'conv', contactId: null, messageId: 'm1' } }])
  expect(seen).toHaveLength(2)
  expect(seen[0]).toMatchObject({ params: expect.arrayContaining(['locZ', 'm1']) })
  expect(seen[1]).toMatchObject({ params: expect.arrayContaining(['locZ']) })
})

test('a redelivered agent-reply job is skipped without touching the handler (FIND-07)', async () => {
  let handler: ((jobs: { data: unknown }[]) => Promise<unknown>) | undefined
  const boss = {
    work: async (_name: string, _options: unknown, h: (jobs: { data: unknown }[]) => Promise<unknown>) => {
      handler = h
      return 'wid'
    },
  }
  const seen: unknown[] = []
  const deps = {
    db: {
      query: async (sql: string, params: unknown[]) => {
        seen.push({ sql, params })
        return [] // claim lost: already processed
      },
    },
    claude: { createMessage: async () => ({ stopReason: null, content: [] }) },
  }
  await registerAgentReplyWorker(boss as never, deps as never)
  await handler!([{ data: { locationId: 'locZ', conversationId: 'conv', contactId: null, messageId: 'm1' } }])
  expect(seen).toHaveLength(1) // claim only; handleAgentReply never ran
  expect(String((seen[0] as { sql: string }).sql)).toMatch(/processed_events/)
})
