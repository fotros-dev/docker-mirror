# Security model

All client requests and upstream responses are untrusted. The service stores bytes without executing images, extracting archives, running builds, or mounting filesystems. It needs neither root nor Docker socket access. A matching digest proves content integrity, not publisher identity or malware safety.

## Network boundary

The production transport permits HTTPS with certificate validation, port 443, fixed registry/authentication origins, and provider-specific blob CDN hosts. Authentication challenges cannot choose arbitrary origins, endpoints, or scopes. Scope is constructed as `repository:<mapped name>:pull`. Authentication redirects are rejected. Blob redirects are limited to five hops; every hop receives full URL and DNS validation. Authorization, cookies, and proxy credentials are removed across origins. Signed CDN URLs are used only for that request and never logged.

DNS answers are resolved before connecting; every answer must be public. Loopback, private, shared-address, link-local, multicast, metadata, documentation, IPv4-mapped private IPv6, NAT64, 6to4, and Teredo destinations are blocked. The connection uses the already validated answer list rather than resolving again. A DNS deadline, HTTP total deadline, bounded redirects, header limits, identity encoding, and bounded JSON reads limit resource exposure. The transport never disables TLS verification and does not use environment proxy settings.

Local-network fixtures inject a dedicated transport in tests. There is no environment variable that enables private upstream access in the executable. Private upstream registries and configurable client destinations are outside this release's scope.

Docker Hub profiles cannot enable private upstream access through this public mirror. Anonymous permission proof precedes credential-assisted retrieval. Tag manifests are fetched by the proven digest. Public-provenance records prevent a fabricated upstream descriptor or dishonest HEAD from granting access to a private local blob merely present in the shared CAS.

Content archived while anonymously accessible remains in the public archive if its upstream later becomes private or is deleted. Cached Pulls deliberately do not revalidate upstream permissions. Plan public redistribution and takedown policies accordingly; disabling the connector blocks access through that connector while preserving its archived bytes.

The connectivity subsystem probes a small fixed list of independent HTTPS destinations: Cloudflare, Wikipedia, and Microsoft. Zero reachable destinations is reported as a suspected broad disruption, not proof of its cause. Confirmed upstream 404 responses remain 404. DNS/timeouts/connections are translated to 503, authentication rejection to an upstream error, and rate limiting to 429 with Retry-After. Cached content does not wait for diagnostics.

## Identity and authorization

Push is disabled by default and restricted to `local/` when enabled. Every hosted Pull requires explicit repository permission. Read and write grants are independent; admin status access grants neither. Session identifiers are bound to both owner and repository. Cross-repository mount requires permission to read the source. CAS possession never bypasses repository checks.

Passwords use scrypt with a random 128-bit salt, N=32768, r=8, p=1, a 64-byte output, and constant-time comparison. Authentication work is bounded to four concurrent derivations and a short queue. Repeated failures receive backoff. These in-process controls supplement reverse-proxy limits; they are not a distributed abuse prevention system. There are no default users or passwords. User metadata fails closed on unrecoverable latest-record corruption.

Use HTTPS for remote authentication. Push requires a loopback backend bind to prevent accidental exposure of the plaintext backend. A local reverse proxy terminates TLS. The backend ignores all Forwarded/X-Forwarded values, generates relative upload Locations, and never derives redirects from Host. Public status is limited to liveness. Other diagnostics require an administrator.

PATs and Bearer tokens remain in memory or the administrator's environment inputs. Persisted account diagnostics exclude tokens. Logs accept only a fixed set of safe event fields and exclude headers, URLs, user passwords, manifest annotations, and request bodies. Metrics do not include credentials. Private repository metadata is available only in authorized local APIs and protected diagnostics. Backups still contain private image bytes and password hashes and must be protected.

## Filesystem and process boundary

Untrusted repository names, UUIDs, tags, digests, references, media types, manifests, and descriptor sizes are validated. Percent-encoded path tricks, traversal segments, malformed request targets, and ambiguous HTTP message framing are rejected. Node's strict HTTP parser handles conflicting Content-Length/Transfer-Encoding framing. Directory keys are hashes, content filenames are validated digest hex, and temporary names use cryptographic UUIDs.

Directory traversal checks, O_NOFOLLOW opens, private permissions, exclusive publication, ownership locks, immutable revision checksums, independent metadata copies, and content verification defend against accidental corruption and symlink redirection. Run the service under a dedicated Unix account whose storage directories and parents cannot be changed by other users. Another process running as that same account, root access, or a hostile filesystem can defeat pathname-based filesystem isolation; do not run untrusted code under the service identity.

## Operating boundaries

Public Pull can consume network, memory, storage, file descriptors, and upstream quota. Archive retention is permanent. Set proxy connection/request limits appropriate to your users, monitor disk space, restrict access when appropriate, and keep coherent backups. Byte/descriptor/depth limits protect individual operations, not total retained capacity. The server uses one writer, local filesystem semantics, and bounded transfer workers. It has not received an independent security audit or large-scale load qualification.

The source license does not grant rights to upstream content. Review provider policies, image licenses, data residency, and redistribution permissions for your deployment. Account failover is off by default and must not be used to circumvent provider restrictions.
