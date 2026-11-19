# Architecture and consistency

## Modules

`main.js` owns command dispatch, environment loading, startup messages, and signals. `app.js` wires lifecycle-managed services. `server/http.js` implements registry HTTP semantics without a framework. Business logic is separated into repository metadata, manifests, mirroring, uploads, authentication, archive jobs, and synchronization.

```text
src/
  main.js, app.js
  config/config.js
  core/errors.js, concurrency.js
  registry/validation.js, manifests.js, mirror.js, uploads.js
  storage/store.js, repositories.js
  network/transport.js, connectivity.js
  upstream/client.js
  auth/auth.js
  archive/manager.js, synchronizer.js
  observability/telemetry.js
  server/http.js
tests/
  unit/, integration/, security/, helpers/
scripts/live-smoke.js
deploy/fotros-mirror.service, nginx.conf
Dockerfile, .env.example, package.json, LICENSE
```

Provider descriptors specify the fixed registry origin, permitted authentication origins, and blob CDN hosts. The registry core routes one repository to one provider. Adding a provider requires an explicit mapping and security policy; clients cannot supply URLs.

## Durable layout

```text
data/
  owner.json
  content/sha256/<64 hex characters>
  state/<kind>/<sha256 of logical key>/<revision>-<checksum>.json
  state/<kind>/<sha256 of logical key>/<revision>-<checksum>.json.copy
  downloads/<digest hex>.part
  uploads/<UUID>.part
  quarantine/<digest hex>-<UUID>
  logs/registry.jsonl
```

Metadata kinds include `repos`, `jobs`, `uploads`, `sync`, `public`, and `system`. The versioned schema is initialized automatically. Unsupported schema versions fail startup. Repository names never become filesystem paths: metadata directory keys are hashes. Paths and regular files reject symlinks, directories use mode 0700, mutable files use 0600, and committed CAS content uses 0400.

The CAS holds exact manifest bytes and opaque blobs. Verified hard-link publication prevents overwriting an existing valid digest. Identical bytes occupy one permanent content file. Temporary copies can exist during a transfer or concurrent commit. Manifests, blobs, and repository grants remain distinct even when they share a CAS digest.

Each metadata update writes two independent checksummed copies, fsyncs their files, publishes each with an exclusive hard link, and fsyncs the directory. Revisions are immutable and retained. One record's operations are serialized in-process. Reading selects the latest valid revision; a damaged primary can be read from its independent copy. Older revisions provide another recovery path and recoveries are visible in protected status. User records fail closed if the latest revision and copy are both invalid, preventing resurrection of revoked users. A fully corrupt document fails instead of being treated as empty.

This is not a multi-record ACID database. A crash can leave additional immutable bytes or a pending intent; publication protocols below restore a consistent reachable state. Filesystem durability requires a local filesystem that honors fsync, hard links, and atomic rename. This is not a distributed registry or shared-NFS storage design. Fault injection and SIGKILL tests verify specific process crash windows; they do not establish resilience against every hardware/controller failure. Backups remain essential.

A failed write has an uncertain outcome if a replica was already published. The next read reloads durable revisions before assigning another sequence number. Upload chunks reconcile their file length with the observed durable offset rather than blindly rolling back bytes after an uncertain metadata failure. Clients must query upload status before resuming after a failed response. No guarantee is made that every unacknowledged operation was absent from storage.

One server or maintenance command owns a data directory at a time. An exclusive lock records PID, hostname, and a random ownership identifier. A second process fails. A dead PID on the same host is recovered under a separate exclusive recovery directory. PID reuse fails conservatively. An invalid lock, different hostname, or interrupted recovery lock requires operator inspection while all users of the directory are stopped. Do not share the same directory between containers with separate PID namespaces or across hosts.

## Pull and archival

1. Resolve the repository through the fixed namespace mapping and authorize any `local/` access.
2. Resolve a tag to its committed digest, or to its initial pending digest if no complete revision exists yet. Cached requests do not validate upstream tags.
3. Fetch a missing manifest, bound its size, parse its descriptors, preserve its exact bytes, and check both its requested and advertised digest.
4. Persist a pending tag and deduplicated archive job. The client receives its requested manifest without waiting for unrelated platforms.
5. A bounded archive worker recursively visits all supported index children, including nested indexes. It archives configurations and layers, validates descriptor sizes, and checkpoints verified digests.
6. Only a graph with every required supported descriptor verified and no recorded limitation becomes Complete. The initial tag then receives its committed current digest.

Unknown descriptor formats produce Partial with a reason. OCI artifact manifests are archived as content and identified separately from runnable platforms. External descriptor URLs are never followed. Nondistributable/external content is attempted only through the configured registry's blob API; a missing external blob records a limitation. Subject associations remain in manifest bytes but do not cause reverse referrer traversal.

Single-flight operations deduplicate concurrent work by digest. Separate manifest and blob schedulers bound work and reserve additional foreground capacity. Foreground work takes priority over queued archival work; joining a queued download promotes it. Cache hits and blob HEAD bypass the download scheduler. A requested platform manifest and its blobs therefore progress while other architectures archive in the background.

For a cache miss, the downloader validates the upstream status, advertised digest if present, length if present, content encoding, and any resume Content-Range before releasing headers to clients. A chunked upstream is accepted using the verified manifest descriptor's size. Responses explicitly flush headers. One writer streams into the private temporary file, awaiting disk writes for backpressure; independent readers tail only written offsets in bounded chunks, with HTTP pipeline backpressure. Disk acts as the shared spool, so a slow or disconnected client cannot stall other pulls or archival. Large layers are never buffered in memory.

Every live response, including a byte range, withholds its final byte until the entire blob passes SHA-256 and size verification, CAS publication, and the source repository/public-provenance writes. An upstream interruption or integrity failure destroys the response, leaving it short of Content-Length. Bytes already streamed are provisional; clients must verify the complete digest as required by the registry protocol. A zero-length response waits for commit because it has no final byte to withhold. Cache hits stream verified files directly. HEAD returns validated upstream metadata on a miss without claiming a verified local blob or starting a download.

Connection (including DNS), response-header, and idle-read deadlines are configured separately. The total header budget covers authentication bodies, redirects, bounded transient retries and exponential backoff. Successful body transfers have no absolute upstream duration deadline. Foreground blob waits also have a header budget, returning a bounded 503 on overload. Permanent 404, authentication/policy failures, metadata/integrity errors and 429 are not retried; 429 preserves Retry-After and cooldown. Once body streaming starts, failures abort attached clients; a later pull or persistent archive retry resumes from disk instead of replaying bytes into an existing response.

Interrupted downloads retain their temporary bytes. A later attempt uses `Range` and verifies the returned range and total size, then hashes the complete result. If the upstream ignores Range, the temporary file is restarted. A fully received temporary blob is verified and committed without another transfer. Invalid temporary content is discarded; damaged committed content is quarantined only when replacement verified bytes are ready.

Repository access is checked before a CAS lookup can grant content. A public manifest's descriptor alone does not grant access to a private local CAS blob. New public provenance is recorded only after actual upstream or inline bytes are verified. Previously public bytes can be reused across repositories only after the destination upstream repository authorizes their digest. Private hosted blob mounts require source Pull and destination Push permission.

## Jobs and synchronization

Archive jobs retain route, root digest, tags, state, attempts, retry time, verified progress, platforms, limitations, and safe error codes. States are Pending, Downloading, Partial, Complete, Failed, and Corrupted. Failed work uses exponential backoff with jitter and honors a longer Retry-After. Six automatic attempts bound retries; the `retry` CLI permits an explicit fresh attempt cycle.

Startup restores interrupted Downloading jobs to Pending, reconstructs missing jobs from pending tag intents, and replays Complete job publication. Checkpoints support recovery; they are not blindly trusted as proof that bytes still exist. A retried traversal reopens and verifies required content. Digest-verified files are memoized by inode, size, mtime, and ctime for that process. `verify` clears this memoization and hashes all associated stored content.

Synchronization serially checks tracked upstream tags, preferring HEAD. An unchanged digest avoids a manifest GET. A changed tag records a candidate and schedules its complete graph. The current tag remains unchanged until that candidate is Complete. Publication verifies that the candidate is still current before committing, preventing an older finishing job from reverting a newer candidate. Tag history stores all committed digests and archival timestamps. No historical content is evicted. Failures preserve the previous version and persist safe diagnostics with a retry time. A startup check and persistent candidate/job intents recover interrupted synchronization work.

## Hosted publication

Upload sessions bind a random ID to the exact repository and authenticated username. PATCH validates the starting offset and inclusive range. Only a completely received, fsynced chunk advances the durable offset; extra uncommitted bytes are truncated on session recovery. GET/HEAD report status, PUT validates SHA-256, and DELETE cancels only temporary session data.

Finalization records a Committing intent before CAS publication, then grants the repository access and marks the session Complete. Startup replays that intent if a crash happened between these steps. A digest mismatch leaves the session active for correction. Completed upload URLs cease to be active sessions.

Manifest publication checks every required repository-scoped blob and child manifest, including size, media type, recursion depth, and verified content. Content commits precede the atomic tag metadata revision. A crash before the tag commit can leave valid untagged content, but does not replace the prior tag. Manifest/blob deletion is deliberately unsupported.
