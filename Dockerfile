# OpenLevel product image: Hono API + pg-boss workers (one process) serving
# the built Vite SPA same-origin.
#
# Runtime is TypeScript via tsx (a production dependency, same as the P2
# staging image): the repo's extensionless relative imports run as-is, where
# a tsc emit would need import rewrites or a bundler. See P2 precedent:
# phase0/p2/Dockerfile.p2staging.
#
# Secrets (DATABASE_URL, SESSION_SECRET, ...) are NEVER baked in: they arrive
# via `fly secrets` at deploy time. No demo seed runs here.
#
# Base pin: node:26-slim floats deliberately within the Node 26 LTS line so
# every rebuild picks up Debian + Node security patches; the major is pinned
# by the repo runtime contract (engines/.nvmrc/CI) and CI rebuilds from
# scratch on every run. Update procedure: `docker pull node:26-slim`, rebuild,
# run the Stage 8 smoke; a digest pin would rot without automation, so the
# resolved digest is recorded per release instead (runbook release evidence).
#
# PID 1: node runs as PID 1 and carries EXPLICIT SIGTERM/SIGINT handlers
# (server/index.ts armSignals), which is exactly what makes PID-1 signal
# delivery work — no init shim needed. Never remove those handlers without
# adding an init system.

FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production
# Release identity (Review 11 P3): CI bakes the built commit in so every
# boot log names its release. Non-secret; defaults to 'dev' for local builds.
ARG RELEASE_COMMIT=dev
ENV RELEASE_COMMIT=${RELEASE_COMMIT}
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server/ ./server/
COPY db/ ./db/
COPY --from=build /app/dist ./dist

# Versioned migration runner (V2.1 section 9): real dbmate, pinned release,
# arch-matched. Upstream publishes no checksums file and no Sigstore
# attestation assets on the release (checked 2026-11-19), so the build asserts
# the version string AND a self-recorded sha256 (drift detection; provenance
# is the pinned release URL over TLS plus the version assert). Refresh: bump
# the version, re-record both hashes from a fresh download, rebuild + smoke.
ARG TARGETARCH
ARG DBMATE_VERSION=2.38.1
ADD https://github.com/amacneil/dbmate/releases/download/v${DBMATE_VERSION}/dbmate-linux-${TARGETARCH} /usr/local/bin/dbmate
RUN chmod +x /usr/local/bin/dbmate \
  && case "$TARGETARCH" in \
       amd64) echo "3e2c62735e0e63f3e5e4de6a3fa5c8a29ac9a34dcb8631a08d9589ab943ad9bd  /usr/local/bin/dbmate" ;; \
       arm64) echo "bb7910069907621feb96e75d26676c55a3bf3514dad7d9c4ca69dfd8465c0543  /usr/local/bin/dbmate" ;; \
       *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
     esac | sha256sum -c - \
  && dbmate --version | grep -q "dbmate version ${DBMATE_VERSION}"

# Fail the build when the boot chain is incomplete (fail closed at build time
# rather than on a Fly Machine): server entry, versioned migrations for the
# release_command, and the SPA bundle the production server requires.
RUN test -f server/index.ts \
  && test -f db/migrations/20261119000000_baseline.sql \
  && test -f dist/index.html \
  && node --import tsx -e "console.log('prod image: tsx loader ok')"

EXPOSE 8790
CMD ["node", "--import", "tsx", "server/index.ts"]
