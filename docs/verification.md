# Verification and release limits

Initial verification was performed on November 18, 2026, using Node.js v24.22.0 on Linux. The normal suite is entirely native and needs no install step, public network, credentials, Docker, or Go.

## Streaming fix verification — November 19, 2026

`npm test` passed **126 tests, zero failures, zero skips and zero cancellations** in 42.9 seconds on Node.js v24.22.0. This includes all 91 original tests and 35 additional streaming/scheduling/configuration cases. A real 31-second upstream transfer returned headers in 54 ms under a separate 30-second header deadline. The final verified body completed in 31,086 ms. A targeted streaming/security/recovery run passed 62 tests. Syntax checks passed for all 31 JavaScript files; runtime imports remain built-in/relative with zero runtime dependencies. `git diff --check` passed. See the [engineering report](engineering-report.md) for behavior, settings and deployment limits.

## Initial commands executed

```sh
node --test
node --test tests/integration/mirror.test.js tests/security/network.test.js tests/integration/recovery.test.js
node --test tests/integration/recovery.test.js
node --test tests/integration/startup.test.js tests/integration/push.test.js
node scripts/live-smoke.js
node src/main.js status
node src/main.js doctor
node src/main.js verify
git diff --check
```

The initial delivery test run passed **91 tests, zero failures, zero skipped, zero TODOs**. Focused suites were also executed during development. Early failures exposed test fixture cleanup ordering and a fixture disconnect that could occur before its consumer received bytes; both were corrected. Subsequent fault injection found and covered uncertain metadata publication, upload finalization, and private CAS authorization. No failing test was removed or marked skipped to achieve the result.

A Node script additionally ran `node --check` on all 30 JavaScript files, checked imports against built-in/relative modules, checked for source comment lines, and verified ESM with no dependencies/devDependencies fields. The default status/verify commands operated on an empty default data store; nonempty content verification is exercised by integration tests. Live doctor reached all three independent configured destinations.

## Automated coverage

| Area | Executed checks |
| --- | --- |
| Configuration | Defaults, malformed booleans/numbers/JSON, invalid URLs, safe Push bind, root-relative paths, native .env parsing and environment precedence |
| Routing | Official image normalization, one provider per name, reserved namespaces, connector disablement |
| Content | Canonical SHA-256, exact bytes, OCI and Docker schema 2 types, malformed manifests, descriptor sizes, negotiation, ranges and 416 |
| Archival | Single/multiple platforms, shared layers, nested indexes, artifact classification, unsupported descriptors, missing children, external URLs, depth limits, honest incomplete state |
| Synchronization | Manual and timer-driven checks, HEAD unchanged detection, failed candidate preserving prior tag, complete candidate publication, historical digest retrieval |
| Recovery | Reopen storage, interrupted transfer Range resume, dead-process lock recovery, pending intent without job, fully received temporary blob, corrupt primary recovery from independent copy |
| Forced crashes | Real child processes killed with SIGKILL during a blob stream, between Complete job and tag publication, and between CAS upload commit and repository publication |
| Storage faults | ENOSPC before metadata commit, failure after replica publication, subsequent revision consistency, upload offset reconciliation, on-disk blob corruption and repair |
| Hosted registry | Push disabled, no-user fail-closed startup, Basic login checks, chunk offsets/status, resume, cancellation, monolithic finalization, digest mismatch, manifest prerequisites, private Pull, scopes and mounts |
| Isolation | Unauthorized blob access, different repository sessions, different user sessions, mirrored namespace writes, fabricated public descriptor referencing private CAS, forged committing upload digest |
| Network security | Public/private IPv4/IPv6, metadata destinations, mixed DNS answers, pinned connection resolution, hostile auth realm, redirect allowlist and credential stripping |
| Credentials | Anonymous public proof, arbitrary account count, deterministic selection/cooldown policy, PAT-to-Bearer exchange only at token endpoint, quota headers, no PAT/Bearer values in logs/status |
| HTTP/filesystem attacks | Traversal, encoded traversal, backslashes, malicious repository names, symlinked paths/files, conflicting Content-Length/Transfer-Encoding, duplicate Content-Length, untrusted Host/forwarded headers |
| Offline/outages | Completed archive Pull with unavailable upstream, restart offline, confirmed 404 versus network/401/429/503, suspected broad outage, no diagnostics dependency for cached Pull |
| Startup | Copy only source/package metadata, no .env or install, run mandatory command from `/`, default 127.0.0.1:5000, health/discovery, graceful shutdown, CLI reopen |

The mock upstream speaks real HTTP registry routes with exact content bytes, Bearer challenges, scoped token requests, HEAD, byte ranges, and injected disconnects/status failures. Fixtures never execute containers or extract layers.

## Live upstream smoke checks

`node scripts/live-smoke.js` uses the production network policy and native connector/content paths. It fetched a root index, selected Linux/amd64 manifest, and digest-verified configuration from every connector:

| Upstream reference | Result |
| --- | --- |
| Docker Hub `library/hello-world:latest` | Index, manifest, config, and a layer passed |
| GHCR `astral-sh/uv:0.9.0` | Index, manifest, config passed; the layer exceeds the smoke script's 4 MiB transfer limit and was explicitly skipped |
| Quay `prometheus/busybox:latest` | Index, manifest, config, and a layer passed |

The Docker Hub smoke initially rejected a CDN host, `production.cloudfront.docker.com`. This exact host was verified against [Docker's official allowlist](https://docs.docker.com/desktop/enterprise/allow-list/) and added; subsequent checks passed. TLS verification, public address validation, DNS pinning, and origin credential stripping remained enabled.

These checks are not Docker Engine Pulls and do not claim that every live platform was downloaded. The normal registry API and complete graph behavior were tested with controlled local fixtures. Smoke state is retained under `data/live-smoke-*` for inspection. No real upstream account credentials were supplied; profile behavior is tested with protocol fixtures, not live PATs.

## Docker and conformance tooling

Docker CLI/Engine and Go were unavailable in this environment. Actual `docker login`, clean-client `docker pull`, `docker push`, `docker manifest inspect`, container builds, and official OCI conformance runs were **not executed**. The optional Dockerfile and Nginx/systemd configuration were not deployed here. No Docker compatibility certificate, full OCI compliance, independent security audit, or production load qualification is claimed.

The implementation was developed against the official [Distribution specification](https://github.com/opencontainers/distribution-spec/blob/main/spec.md), [OCI image manifest](https://github.com/opencontainers/image-spec/blob/main/manifest.md), [OCI index](https://github.com/opencontainers/image-spec/blob/main/image-index.md), [Docker Registry HTTP API](https://distribution.github.io/distribution/spec/api/), and [registry authentication](https://docs.docker.com/reference/api/registry/auth/) documentation. The official [conformance runner](https://github.com/opencontainers/distribution-spec/tree/main/conformance) and its configuration were inspected. Its current Go path requires Go 1.24 or newer; the alternative runner requires Docker.

To run applicable conformance tests on a suitably equipped development host, create two authorized local repositories and use the official runner with `OCI_REPO1=local/conformance/one`, `OCI_REPO2=local/conformance/two`, `OCI_TLS=disabled` for a loopback HTTP test, and fixture-only credentials. Set unsupported optional APIs/data to false, including manifest/blob/tag deletion, referrers, sha512, sparse descriptors, embedded descriptor data for hosted publication, and anonymous blob mounts. Set `OCI_RESULTS_DIR` beneath this repository's `data/`. Consult the runner's version-specific configuration before selecting category claims; passing a subset does not establish full conformance. Do not point destructive tests at a production archive.

## Remaining limits

- SHA-256 and OCI/Docker schema 2 manifests/indexes are supported. Schema 1, sha512, catalog discovery, referrers discovery, subject graph expansion, manifest/blob deletion, and multipart range bodies are unsupported. Tag listing exposes committed local tags rather than an upstream catalog.
- Supported OCI artifact content is archived as opaque bytes. Unsupported descriptor formats or unavailable external content remain Partial. No external descriptor URL is fetched. Hosted publication requires repository content to exist; inline descriptor data does not automatically publish missing hosted blobs.
- One writer and a private POSIX local filesystem are required. No distributed coordination, shared-NFS guarantee, Windows qualification, or hardware power-loss certification is provided. A double-damaged latest repository record can fall back to an older valid revision, reports recovery, and requires operator investigation. Double-damaged latest user state fails closed.
- Metadata records have a 64 MiB parsing/publication limit, recursive graphs have depth 16 and 10,000 descriptor limits, and request/transfer limits protect process stability. Immutable revisions, retained sessions, and logs grow without compaction or automatic cleanup. Large archives need capacity planning and scale testing.
- Cache misses flush validated upstream headers and stream provisional bytes; the final response byte waits for complete verification and publication. All-platform archival can consume substantially more bandwidth and disk than a single-platform client Pull. Upstream connection, header and idle-read deadlines are independent; the legacy timeout now defaults the idle-read limit. Incoming requests and idle client sockets have five-minute limits. See the current [engineering report](engineering-report.md) for streaming fault-test results.
- Metrics flush every 30 seconds and on clean shutdown, so an abrupt kill can lose recent counters or unflushed log records. Image/reference publication uses separate durable commits and recovery intents.
- Upstream credentials cannot mirror private upstream images publicly. Anonymous proof and fixed CDN allowlists can defer otherwise authorized requests during quota changes or provider infrastructure changes. Account failover is disabled by default and does not establish permission to evade rate limits.
- Remote authenticated Push requires a loopback backend and a local HTTPS proxy. Administrative CLI commands require stopping the server; the protected HTTP diagnostics work while serving. Add perimeter abuse controls suited to the deployment.
- Permanent retention is intentional. No automated eviction or valid-content garbage collection is implemented. Redistribution permission and provider terms must be checked separately from this project's Apache-2.0 license proposal.
