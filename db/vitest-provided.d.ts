// Vitest provided-context keys for the real-PostgreSQL suite (see
// db/pg-test-setup.ts). Lets test files inject() the shared container URL
// with types instead of casting through never.
declare module 'vitest' {
  interface ProvidedContext {
    pgTestUrl: string
  }
}

export {}
