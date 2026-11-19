# Deployment and operations

## Ubuntu Server or Linux VPS

Install an official Node.js 24 LTS or newer binary appropriate to your operating system. Confirm `node --version`. Basic startup needs no other runtime. Run `node src/main.js serve` in a clone to use the local mirror.

For a system service, install the repository at `/opt/fotros-docker-mirror`, create a dedicated `fotros` Unix account, and give it ownership of the repository for initial setup. Copy `.env.example` to `.env` only if configuration is needed. Use mode 0600 on any configuration containing secrets. Initialize automatic storage once as the service account:

```sh
sudo -u fotros /usr/bin/node /opt/fotros-docker-mirror/src/main.js status
```

This creates `data/` without manual storage initialization. Then make source and configuration read-only to the service account while keeping `data/` owned by it. Adjust `/usr/bin/node` if your binary is elsewhere. Source protection and the dedicated identity matter because the data directory must be private.

```sh
sudo cp deploy/fotros-mirror.service /etc/systemd/system/fotros-mirror.service
sudo systemctl daemon-reload
sudo systemctl enable --now fotros-mirror
sudo systemctl status fotros-mirror
journalctl -u fotros-mirror -f
```

The example uses a loopback listener and grants writes only to `data/`. Check [the service file](../deploy/fotros-mirror.service) against local paths. On upgrades, stop the service, back up, update source without replacing `data/` or `.env`, run `node --test`, and restart. The stable startup command is unchanged. Unsupported future storage schemas fail safely rather than silently rewriting data.

## Nginx HTTPS

Point DNS at the VPS, obtain a valid certificate through your normal ACME process, and adapt [deploy/nginx.conf](../deploy/nginx.conf). It uses the fixed hostname `docker-mirror.fotros.dev`, TLS 1.2/1.3, disabled proxy buffering, long streaming timeouts, and relative upload locations. Change every hostname and certificate path for a different installation.

```dotenv
HOST=127.0.0.1
PORT=5000
PUBLIC_URL=https://docker-mirror.fotros.dev
PUSH_ENABLED=false
```

```sh
sudo nginx -t
sudo systemctl reload nginx
```

Cache-miss headers are flushed by Node after upstream status and metadata validation. Keep `proxy_buffering off` and `proxy_request_buffering off`; the example also disables inherited proxy caching, upstream replay and gzip so blob framing and errors pass through consistently. The existing `proxy_read_timeout 900s` limits gaps between backend reads. Increasing it cannot extend Docker's own response-header deadline. Default upstream connection/header budgets fail unavailable requests promptly; slow but active body transfers may continue beyond 30 seconds. Review `blob_request` and `blob_download` events for queue wait, upstream headers, byte counts, retries, duration, cache result and client disconnects.

For PM2, run one process in fork mode (`instances: 1`), using `src/main.js` with the `serve` argument and this repository as `cwd`. The storage ownership lock deliberately rejects multiple writers, including PM2 cluster workers sharing a data directory. After deploying the code and environment changes, restart the existing PM2 process with `--update-env`. Validate the adapted proxy configuration with `nginx -t`, then reload Nginx through your normal service manager. Match `proxy_pass` to the actual `.env` `PORT`: the proxy example uses `5000`, while the GitLab deployment health check defaults to `5007`. A production rollout and a real Docker pull should confirm the deployed path; local tests do not deploy these changes.

Only expose ports 80/443 through the firewall. Never expose the plaintext Node backend remotely for authenticated use. Do not add a second upstream default virtual host that redirects based on an arbitrary Host header. If you enable proxy access logs, do not log Authorization headers, request bodies, or signed upstream URLs. Native HTTP request logging already excludes secrets.

For internal Push, add registry-local users before enabling `PUSH_ENABLED=true`, keep `HOST=127.0.0.1`, and set `PUBLIC_URL` to the internal HTTPS origin. The Nginx and systemd examples are supplied configuration, not deployed or validated against installed Nginx/systemd in this development environment.

## Optional container

Docker is optional for deployment and is never required by the Node server. The Dockerfile has no npm installation or build stage:

```sh
docker build -t fotros-docker-mirror .
docker run -d --name fotros-mirror --restart unless-stopped \
  -p 127.0.0.1:5000:5000 \
  -v fotros-mirror-data:/app/data \
  fotros-docker-mirror
```

The image runs as the `node` user. Ensure the volume is writable by that user; Docker's initial named-volume copy should preserve the application directory ownership. An existing bind mount must be owned by the container's Node UID. Do not mount the Docker socket. For Push, use Linux host networking, override `HOST=127.0.0.1`, and put the HTTPS proxy on that same host. Independent-container loopback namespaces cannot share a loopback backend; the executable intentionally rejects public-interface Push binds.

Build and container runtime behavior still require validation on your Docker installation; Docker was not available for the repository's initial verification.

## Health and diagnostics

`GET /healthz` reports process liveness without repository metadata. It does not certify archive completeness or upstream reachability. Check `/admin/status` using an admin user's HTTP Basic credentials over HTTPS for job states, tag history, storage usage, provider quota headers, and synchronization state. `/admin/metrics` returns JSON counters and cache ratio. `/admin/doctor` runs bounded connectivity probes. Avoid putting passwords directly in shell history.

The CLI uses exclusive storage ownership. While the server is stopped:

```sh
node src/main.js status
node src/main.js doctor
node src/main.js verify
node src/main.js sync
node src/main.js retry
```

`verify` exits nonzero on corruption/missing associated content. `sync` and `retry` wait for currently runnable archive work; jobs deferred by backoff remain visible for a running server to retry. Persisted errors omit secrets. Six automatic attempts prevent endless retry loops. Restart replays interrupted work and pending publication intents.

## Backup and restore

Stop the service before ordinary file-copy backups. Save **all** of `data/`, including immutable content, repository/tag metadata, both metadata copies, users, jobs, partial transfer files, metrics, and logs. Save `.env` separately with restricted permissions. A single consistent filesystem snapshot can be taken instead of stopping when the storage system guarantees a coherent point in time.

Restore into the same repository-relative `data/` mount, restore ownership to the dedicated service user, and retain mode 0700 on data directories. There must be only one writer. If restoring to a different host, inspect and remove the copied `owner.json` only after ensuring no running process owns that restored directory. A stale PID lock on the same host is normally recovered automatically. An invalid lock or abandoned `owner-recovery` directory requires the same careful offline inspection.

Run `node src/main.js verify` before restarting service. Keep the backup until verification and representative offline Pulls succeed. A correct digest does not restore a missing repository permission or tag history, so backing up only `content/` is insufficient.

Use a mounted local filesystem at `data/` for larger disks. Do not symlink it. Avoid NFS/shared writable storage. Monitor bytes and inode usage: permanent archives and immutable metadata revisions grow without eviction. Temporary invalid/incomplete files are separate from valid archive retention, but there is no automatic cleanup command in this release. Never delete content by age. Arrange log archival/rotation externally while stopped; rotation by renaming a live open file requires a service restart to reopen it.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Address already in use | Stop the other listener or set PORT; confirm HOST |
| Storage already owned | Stop the existing process; use protected HTTP diagnostics while running |
| Lock from another host | Inspect the backup/restore or shared-volume setup; never remove a live owner's lock |
| Permission/read-only filesystem error | Check directory ownership, mount state, disk capacity, and systemd ReadWritePaths |
| Missing image returns 404 | Upstream confirmed absence, or the requested repository lacks the blob association |
| 503 network/DNS/timeout | Check doctor; previously complete archives should still work |
| Suspected international disruption | Several independent probes failed; inspect local DNS/firewall too |
| Upstream authentication failure | Verify provider access; a PAT does not enable private upstream mirroring |
| 429 with Retry-After | Wait for provider cooldown; do not rotate identities to bypass restrictions |
| Partial archive | Inspect limitations, missing children, descriptor errors, and retry time |
| Cached tag stays old | A candidate must archive completely before tag publication |
| Private Pull gives 401/403 | Log in and check repository-specific Pull permissions |
| Push startup rejected | Add a hashed user with Push permission and keep a loopback HOST |
| CDN destination rejected | Confirm the new host with provider documentation before changing the source allowlist |
| Metadata recovery reported | Preserve backups, investigate disk integrity, and run verify while stopped |

There is no TTL or automatic archive deletion. Previously committed version digests remain pullable even after upstream tag movement or deletion, provided their complete content and repository metadata are intact.
