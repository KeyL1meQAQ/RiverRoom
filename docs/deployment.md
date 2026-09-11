# Server deployment

Host: `160.202.237.14`

Initial release: `20260909T081802Z` (2026-09-09).

## Release 20260911T091243Z

- Application source: `fa3debc902f8613623c498969ebb90dddf2abbd4` on `main`,
  pushed before deployment. Before the first game starts, occupied seats display
  two pale frosted placeholders with the River Room spade mark. In-game card
  behavior is unchanged.
- Release directory: `/opt/poker/releases/20260911T091243Z`.
  Previous release: `/opt/poker/releases/20260911T075231Z`.
- Rollback image: `river-room-app:rollback-20260911T091243Z`; original image ID:
  `sha256:226481ec22288016d7089ff898b51710e7d865ea75b81ea87cef895bbb97e652`.
- Database backup: `/opt/poker/shared/backups/poker-20260911T091243Z.dump`
  (36,724 bytes, mode 600), validated with `pg_restore --list` before activation.
  Build log: `/opt/poker/shared/build-20260911T091243Z.log`; build succeeded.
  The allowlist archive passed SHA-256 verification before extraction.
- Local verification: 71 backend tests, 10 presentation tests, production build,
  and placeholder state checks passed. Desktop/mobile screenshots were inspected.
- All 3 existing room browser tests passed against public HTTP using uniquely
  named rooms and owner-API cleanup. Added production checks verified 18 spade
  marks at a full waiting table and removal of placeholders after starting.
  Fresh nine-seat desktop/mobile captures were inspected.
- HTTP and HTTPS smoke checks passed health, byte-for-byte HTML/JS/CSS comparison,
  WS/WSS connection, refresh preserving identity, frosted placeholders, mobile
  layout and desktop empty-seat symmetry. Cookies were HttpOnly on both protocols
  and Secure on HTTPS. All four test rooms created by this run were closed.
- App/database health, single app process, restart policies and private bindings
  passed. LiveKit `/` and `/app/` hashes matched their pre-deployment baselines.
  Database, environment, Nginx and TLS configuration were retained.
- `/opt/poker/current` was updated after verification. Backup, rollback image and
  build log were retained; the uploaded transfer archive was removed.
- Mobile evidence uses Chromium viewport simulation, not a physical phone.
  HTTPS retains the existing self-signed certificate.

## Release 20260911T075231Z

- Application source: `86bd61d5d1242d7261c031b53de7db6a4fd8247a` on `main`,
  pushed before deployment. Desktop empty seats are centered on mirrored anchors;
  mobile tables use a centered 400px maximum width and an elliptical outline.
  Mobile table branding and status text below the community cards are restored.
- Release directory: `/opt/poker/releases/20260911T075231Z`.
  Previous release: `/opt/poker/releases/20260911T054221Z`.
- Rollback image: `river-room-app:rollback-20260911T075231Z`; original image ID:
  `sha256:0bb33fe01b5f3d0faf523cd7857062dbd01a74a4c4044ed38cf489f11d00e9b6`.
- Database backup: `/opt/poker/shared/backups/poker-20260911T075231Z.dump`
  (29,168 bytes), validated with `pg_restore --list` before activation.
  Build log: `/opt/poker/shared/build-20260911T075231Z.log`; build succeeded.
  The allowlist archive passed SHA-256 verification before extraction.
- Local verification: 71 backend tests and production build passed. All 10
  presentation tests passed with expanded wide-phone viewport coverage; separate
  geometry checks covered desktop symmetry, mobile width/shape and visible labels.
- All 3 existing room browser tests passed directly against public HTTP, with
  unique room names and owner-API cleanup. Fresh full-table mobile and desktop
  captures were inspected. Both HTTP and HTTPS smoke tests passed room creation,
  WS/WSS connection, reload preserving identity, 400px mobile width, oval shape,
  visible branding/status and desktop empty-seat symmetry. Each smoke room closed.
- Public HTML, JS and CSS matched the local build byte-for-byte. HttpOnly cookies
  were verified on both protocols; HTTPS also set Secure. App/database health,
  restart policies, single-process operation and private port bindings passed.
  LiveKit `/` and `/app/` content hashes matched their pre-deployment baselines.
- Existing database, environment, Nginx and TLS configuration were retained.
  `/opt/poker/current` was updated after verification. Database backup and rollback
  image were retained; this run's uploaded transfer archive was removed.
- Mobile screenshots use Chromium viewport simulation, not a physical phone.
  HTTPS retains the existing self-signed certificate.

## Release 20260911T054221Z

- Application source: `09a6b763ffe7b5cd3bdc75ba92abbb992d3a2b9f` on `main`,
  pushed before deployment. Includes the accumulated player-frame/showdown updates
  and compact mobile action capsules without chip icons; desktop icons remain.
- Release directory: `/opt/poker/releases/20260911T054221Z`.
- Previous release: `/opt/poker/releases/20260909T081802Z`.
- Rollback image: `river-room-app:rollback-20260911T054221Z`; original image ID:
  `sha256:3966d17c75277327b0ef050604f7688023dfb02e56786ae28510fa91d4897305`.
- Database backup: `/opt/poker/shared/backups/poker-20260911T054221Z.dump`
  (8,897 bytes); `pg_dump` succeeded and `pg_restore --list` validated the archive
  before activation. Existing environment, database volume, Nginx and TLS retained.
- Build log: `/opt/poker/shared/build-20260911T054221Z.log` (`BUILD_EXIT=0`).
  The uploaded allowlist archive passed SHA-256 verification before extraction.
- Local verification: 71 backend tests, production build and 10 presentation
  browser tests passed. Production room browser tests passed all 3 cases; a
  temporary wrapper added unique room names and owner-API cleanup while retaining
  the original test assertions. Fresh desktop/mobile captures were inspected.
- Public HTTP and HTTPS health checks passed; both served JS and CSS bytes matched
  the local production build. Final direct browser checks passed WS/WSS connection,
  reload preserving identity and HttpOnly cookies; HTTPS also set Secure.
- Initial direct/proxy access was intermittent. The room regression and asset
  comparison used an SSH SOCKS connection to production Nginx. Subsequent direct
  HTTP/HTTPS health and browser smoke checks passed after connectivity recovered.
  Early cleanup-wrapper failures were corrected without application changes.
- Application/database health, single-process operation, `unless-stopped` restart
  policies and private bindings were checked. LiveKit `/` and `/app/` returned the
  same content as before deployment. This run's test rooms were closed through
  room APIs; no existing user rooms were modified by test cleanup.
- Mobile evidence uses Chromium viewport simulation, not a physical handset.
  HTTPS still uses the existing self-signed certificate.

## Service topology

- HTTP: `http://160.202.237.14:8080`
- HTTPS: `https://160.202.237.14:8443`
- Current release: `/opt/poker/current`
- Release directories: `/opt/poker/releases/`
- Database credentials: `/opt/poker/shared/production.env` (root only)
- Database volume: `river-room_poker-db`
- Nginx configuration: `/etc/nginx/sites-available/poker`

Nginx forwards HTTP and WebSocket requests to `127.0.0.1:18080`.
The database has no published host port. Both containers restart automatically.
The game service runs as a single process. Local development data is not uploaded.

HTTPS reuses the server's existing self-signed IP certificate from
`/opt/livekit/tls/`. Browsers display a certificate warning until that certificate
is trusted. The existing LiveKit service on ports 80 and 443 is separate.

## Operations

Run on the server:

```sh
cd /opt/poker/current
docker compose --env-file /opt/poker/shared/production.env -f compose.production.yaml ps
docker compose --env-file /opt/poker/shared/production.env -f compose.production.yaml logs --tail 100 app
curl --fail http://127.0.0.1:8080/api/health
```

## Update

Run `npm ci` and `npm run build` locally, then upload the source and the complete
`dist/` directory to a new timestamped directory under `/opt/poker/releases/`.
Include `.dockerignore`, `compose.production.yaml`, `deploy/`, frontend build
configuration, `src/`, `public/`, and `backend/`. The production Dockerfile uses
the prebuilt frontend. Do not upload `.env`, `data/`, `node_modules/`, or `.venv/`.

`PIP_INDEX_URL` in the server environment file selects the Python package index.
This host uses `https://mirrors.aliyun.com/pypi/simple/` because direct access to
PyPI is slow. Without that setting, builds use the official PyPI index.

From that release directory:

```sh
docker compose --env-file /opt/poker/shared/production.env -f compose.production.yaml up --build -d --wait
curl --fail http://127.0.0.1:8080/api/health
ln -sfn "$PWD" /opt/poker/current
```

Existing hands pause after a service restart and require the room owner to resume.
Use the same Compose project name and environment file to preserve the database.
Never run `docker compose down -v` when room data needs to be retained.

If changing Nginx, back up `/etc/nginx/sites-available/poker`, install the updated
`deploy/nginx.conf`, run `nginx -t`, then run `systemctl reload nginx`.

## Backup

```sh
cd /opt/poker/current
mkdir -p /opt/poker/shared/backups
chmod 700 /opt/poker/shared/backups
umask 077
docker compose --env-file /opt/poker/shared/production.env -f compose.production.yaml exec -T db pg_dump -U poker -d poker -Fc > "/opt/poker/shared/backups/poker-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

To roll back application code, run the update commands from the previous release
directory. The persistent database is reused; future incompatible schema changes
may also require restoring a compatible database backup.

## Initial Release Verification

- Production frontend build completed and uploaded files matched local SHA-256 hashes.
- All 64 backend tests passed locally and in the deployed application container.
- All three room browser tests passed against the public HTTP endpoint, including
  multiple browsers, nine seats, identity recovery, and mobile layouts.
- HTTPS, Secure/HttpOnly cookies, and WebSocket reconnection passed browser checks.
- The room and browser identity survived an application container restart.
- Test rooms were removed or closed after verification.
