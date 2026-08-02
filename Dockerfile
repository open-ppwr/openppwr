# syntax=docker/dockerfile:1.7
# The build stage and the runtime stage must agree on the C library. The runtime below is musl-based,
# so this stage is too: `npm ci` selects platform-specific optional dependencies for the platform it
# runs on, and a Debian build stage would resolve glibc variants that the runtime could not execute.
FROM node:24-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages ./packages
# `--ignore-scripts`: the root package.json's own `allowScripts` policy names exactly which packages may
# run an install script, but npm itself never enforced that list — a plain `npm ci` runs every lifecycle
# script in the dependency tree regardless of what the policy says. `esbuild` is the one
# production-relevant entry in that list; its postinstall only selects the already-fetched platform binary
# package (an ordinary optionalDependency, not a compiled artifact), so running it explicitly and visibly,
# once, is the reviewed exception the policy already named — not a blanket skip of the policy's own point.
RUN npm ci --ignore-scripts
RUN node node_modules/esbuild/install.js
COPY apps ./apps
COPY scripts/validation/deployed-e2e.mjs scripts/validation/deployed-e2e.mjs
# The web build generates the downloadable ACME samples from the deterministic generator, so the
# generator must exist in the build context. Without it `npm run build` fails at the web workspace.
COPY scripts/acme ./scripts/acme
RUN npm run build
RUN npm prune --omit=dev
RUN mkdir -p /runtime-data/evidence
# The runtime has no glibc, so a glibc-linked binary in the shipped tree would not fail here — it would
# fail on a deployment, as a bare "no such file or directory" naming an interpreter that does exist.
# The pruned tree is pure JavaScript today: zero ELF files. This asserts that rather than assuming it,
# so that a future dependency introducing a glibc-linked native module stops the build instead of
# producing an image that cannot start.
RUN set -eu; \
    glibc_linked="$(scanelf --recursive --nobanner --format '%i %F' /workspace 2>/dev/null | grep 'ld-linux' || true)"; \
    if [ -n "$glibc_linked" ]; then \
      echo "Runtime tree contains glibc-linked binaries; the musl runtime base cannot execute them:" >&2; \
      echo "$glibc_linked" >&2; \
      exit 1; \
    fi

# The Node.js runtime itself, taken from the same musl image the build stage used, so the interpreter
# that runs the code is the one the dependency tree was resolved against. Nothing else is taken from
# this stage: not the shell, not busybox, not npm, not the apk database.
FROM node:24-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS nodejs

# Runtime base. This was `gcr.io/distroless/nodejs24-debian13:nonroot`, which is Debian trixie and
# therefore ships `libc6`. Grype reported CVE-2026-5450 (Critical), CVE-2026-5928 (High) and
# CVE-2026-5435 (High) against that `libc6`. None can be resolved by moving to a newer digest: the
# pinned digest was already the current `:nonroot` tag, no trixie `libc6` fixes any of the three, and
# CVE-2026-5435 is unfixed in every glibc Debian ships including unstable. All three are properties of
# glibc, so they are removed by removing glibc.
#
# `distroless/static-debian13` contains no libc at all — only `base-files`, `media-types`, `netbase`,
# `tzdata` and the CA bundle. The three libraries copied below are the entire musl userland Node needs.
# The result keeps every property the distroless base was chosen for (no shell, no package manager, no
# interactive user, numeric non-root) and additionally has no glibc to be vulnerable.
FROM gcr.io/distroless/static-debian13:nonroot@sha256:f7f8f729987ad0fdf6b05eeeae94b26e6a0f613bdf46feea7fc40f7bd72953e6 AS runtime
COPY --from=nodejs /lib/ld-musl-x86_64.so.1 /lib/ld-musl-x86_64.so.1
COPY --from=nodejs /usr/lib/libstdc++.so.6 /usr/lib/libstdc++.so.6
COPY --from=nodejs /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY --from=nodejs /usr/local/bin/node /nodejs/bin/node
ARG OPENPPWR_VERSION=1.0.0
ARG OPENPPWR_REVISION=unknown
ARG OPENPPWR_BUILD_TIMESTAMP=unknown
ARG OPENPPWR_RELEASE_CHANNEL=private-release-candidate
ARG OPENPPWR_MIGRATION_LEVEL=unknown
LABEL org.opencontainers.image.source="https://github.com/open-ppwr/openppwr" \
      org.opencontainers.image.title="OpenPPWR" \
      org.opencontainers.image.description="Open-source packaging compliance platform for Europe" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="$OPENPPWR_VERSION" \
      org.opencontainers.image.revision="$OPENPPWR_REVISION" \
      org.opencontainers.image.created="$OPENPPWR_BUILD_TIMESTAMP"
# Baked into the image so the running process can state what it is. A version a deployment reports
# about itself is checkable; a version typed into a content file is not.
ENV OPENPPWR_VERSION="$OPENPPWR_VERSION"     OPENPPWR_REVISION="$OPENPPWR_REVISION"     OPENPPWR_BUILD_TIMESTAMP="$OPENPPWR_BUILD_TIMESTAMP"     OPENPPWR_RELEASE_CHANNEL="$OPENPPWR_RELEASE_CHANNEL"     OPENPPWR_MIGRATION_LEVEL="$OPENPPWR_MIGRATION_LEVEL"
ENV NODE_ENV=production OPENPPWR_HOST=0.0.0.0 OPENPPWR_PORT=3000 OPENPPWR_WEB_ROOT=/app/apps/web/dist/client OPENPPWR_EVIDENCE_STORAGE_ROOT=/var/lib/openppwr/evidence
WORKDIR /app
COPY --from=build --chown=65532:65532 /workspace /app
COPY --from=build --chown=65532:65532 /runtime-data /var/lib/openppwr
COPY --chown=65532:65532 LICENSE NOTICE THIRD_PARTY_NOTICES.md docs/audit/LICENSE_INVENTORY.md docs/audit/THIRD_PARTY_LICENSE_INVENTORY.md /app/licenses/
USER 65532:65532
EXPOSE 3000
VOLUME ["/var/lib/openppwr"]
# `distroless/static` declares no entrypoint of its own. The `nodejs` distroless variant supplied
# `/nodejs/bin/node` as ENTRYPOINT, and CMD below is still a script path, so the interpreter has to be
# named here or the image would try to execute the script directly.
ENTRYPOINT ["/nodejs/bin/node"]
# /health/ready, not /health. This is the image's default healthcheck and therefore the one the `api`
# container uses, and until 2026-08-01 it asked for liveness: `/health` answered a static `{status:'ok'}`
# without touching the database, so an API whose pool was exhausted or whose database had gone reported
# itself healthy and kept receiving traffic. Readiness is the question a container healthcheck is asking.
# `/health` still exists and is still liveness — see the comment above the routes in apps/api/src/app.mjs
# for why the meaning of the published route was not changed instead.
#
# The 5 s timeout is deliberately wider than the probe's own 2 s bound, so a slow answer is reported by
# the route rather than by the healthcheck timing out with nothing to say.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["/nodejs/bin/node","-e","fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["apps/api/src/server.mjs"]
