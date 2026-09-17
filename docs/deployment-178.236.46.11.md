# River Room: 178.236.46.11

Current configuration (verified 2026-09-17): public HTTPS/WSS at
`https://rr.zandz.nexus` reaches the operator's existing Nginx listener on **443**,
which proxies to `127.0.0.1:8080`. River Room retains host networking and the
private PostgreSQL socket. This supersedes the initial direct Cloudflare-to-8080
ingress described in the historical release below. Do not remove the shared
Nginx service or change its TLS/firewall configuration during an app release.

## Runtime topology

- SSH: `root@178.236.46.11`, port `60022`, key authentication using
  `/Users/keyl1me/.ssh/id_ed25519` on the deployment workstation.
- Application HTTP/WS: port `8080`, reached by the local Nginx proxy.
- Application: one Uvicorn process using `network_mode: host`, listening directly
  on host `0.0.0.0:8080`. No Docker port publishing or DNAT. Ordinary
  UFW INPUT rules now control incoming 8080 traffic.
- PostgreSQL: `postgres:17-alpine`, container port `5432`, no host publication.
  The app connects through `/var/run/postgresql` using the shared
  `river-room_poker-db-socket` volume (read-only mount in the app).
- Compose project: `river-room`; persistent volume: `river-room_poker-db`.
- Both containers use `restart: unless-stopped`; Docker is enabled at boot.
- Existing UFW allows 443, 60022, 7000 and 50022 for IPv4/IPv6, with no public
  8080 allowance. Preserve that policy and unrelated SSH/FRP services.
- Existing Nginx also serves FRP, Y2P and HA; its TLS certificate is under
  `/etc/letsencrypt/live/zandz.nexus/`. No Nginx/TLS changes are part of this release.
- `FORWARDED_ALLOW_IPS` contains the existing Cloudflare IPv4/IPv6 networks
  fetched on 2026-09-16 and the local Nginx source `127.0.0.1`. Trusting this
  loopback peer lets Uvicorn recognize forwarded HTTPS and issue Secure cookies.
  Never replace this explicit list with `*`.

The source configuration is `compose.178.236.46.11.yaml`. On this server it is
installed as the release's `compose.production.yaml`, keeping operational commands
consistent. The repository's generic `compose.production.yaml` and
`deploy/nginx.conf` still describe the original server and must not overwrite this
host's direct-port setup. Docker image metadata still declares the old port 8000;
no process listens on it and it is not published.

Official Cloudflare ranges for future refreshes:
https://www.cloudflare.com/ips-v4/ and https://www.cloudflare.com/ips-v6/.

## Release 20260917T101857Z

- Active release: `/opt/poker/releases/20260917T101857Z`; previous release:
  `/opt/poker/releases/20260917T095519Z`.
- Application source: `26c258926782226da18fb707fde917b064a78f9f`. This release
  removes the badge-driven vertical lift of other players' mobile hole cards,
  uses horizontal avoidance and restores the corresponding seat positioning.
  Normal winning-card lift remains unchanged. The host-specific Compose file
  is byte-identical to the previously running configuration.
- Built and tested an isolated source copy. No concurrent source drift was
  detected before final documentation updates. The staged archive contains
  54 allowlisted files and is 478,224 bytes; SHA-256:
  `0c710adb0645ad56df3c3fc362425e049b9242236b3d646832bd32a347017c83`.
  Archive and individual source/dist hashes were verified before the build.
- Application image:
  `sha256:13a1b55c9e89e0cb9bc4f1780f565b6a9447e0be90c705a3b207bfcd3694708e`.
  App replacement started at `2026-09-17T10:24:47Z`; only the app was recreated.
- Pre-activation backup:
  `/opt/poker/shared/backups/poker-20260917T101857Z.dump`, 20,842 bytes, mode 600.
  Created through the previous release's running DB service and validated with
  `pg_restore --list` before activation. No database restore was performed.
- Rollback image: `river-room-app:rollback-20260917T101857Z`, retaining
  `sha256:8261deaf2c41b537a6aef6b6f10bdfc850a029b7bf62aa79f33996546544e09d`.
  It already supports persisted achievement fields and must retain the current
  host-network/socket/Nginx/proxy-trust contract.
- Preflight and pre-activation found two open rooms, one previously started
  room and zero online players. Existing rooms were retained; started rooms
  resume paused until their owners continue.

Acceptance evidence:

- Isolated snapshot: 86 backend tests passed and production build passed.
- Public health returned application `{"ok":true}` with `no-store`. Public
  HTML and referenced assets matched the staged build bytes over normal HTTPS.
- Public JS `index-BDl80yTv.js` SHA-256:
  `43980beae945c7030fded631bdc14a76eea6b5a9fa5a90feeeba04220078ec19`.
- Public CSS `index-BobMIgkH.css` SHA-256:
  `b3e17730ebbbfbd625adaf727be037d0aa51c001a701e6a51ae8646038be64d0`.
- Dedicated public smoke verified room creation, WSS, identity-preserving
  reload and Secure/HttpOnly cookies. No credential or recovery-code values
  were logged.
- All three existing real-room browser tests passed at the public hostname,
  covering multiplayer approval/play/recovery, mobile lobby and nine seats.
- Initial browser invocation: 20 passed, one fixture assertion failed during
  an immediate desktop-to-320px resize. Diagnostic samples found old 14px/11px
  inline amount fonts before ResizeObserver ran; after two animation frames
  they were 12px/10px and every amount row was aligned. The one-off release
  harness now waits those two frames before the unchanged assertion. That
  case passed three consecutive repeats over all six viewport widths.
  No application code or repository test source was changed for this wait.
- Thus all 18 intended presentation/achievement scenarios were verified,
  including the targeted recheck; the initial 21-test invocation itself was
  not a clean pass. These fixture checks exercise deployed frontend assets,
  not live production achievement outcomes. Logs and the adapted harness are
  preserved under `artifacts/deploy-20260917T101857Z/` on the workstation.
- Inspected run-specific real desktop/mobile room and fixture badge captures.
  Mobile cards keep their original height, shift horizontally for badges,
  stay within player-frame edges and retain independent badge spacing.
- Smoke room `IhdC9fnhfuK8` and test rooms `F3vndhvx6-bZ`, `Rhogm7VFj38o`
  were closed through their owner APIs. A read-only check of only those IDs
  confirmed `closed_at`; the original two open rooms remained, with zero
  online players. `/opt/poker/current` was then updated atomically.
- App/DB healthy; one Uvicorn process, host networking, socket DB access,
  no app/DB port publication or Docker DNAT for 8080. No startup/application
  error lines were found. DB and Y2P IDs/images/start times, FRP process and
  all 37 hashed Nginx/UFW configuration files matched the baseline.
- Existing Nginx HTTPS/WSS ingress, TLS and UFW policy were preserved. This
  verifies the public hostname route; it does not assert Cloudflare proxying
  or re-test direct-IP firewall behavior.

Server evidence: `/opt/poker/shared/build-20260917T101857Z.log`,
`/opt/poker/shared/baseline-20260917T101857Z.json`,
`/opt/poker/shared/after-20260917T101857Z.json`,
`/opt/poker/shared/verified-20260917T101857Z.json`, and the backup/list above.
Release documentation was synchronized after acceptance; the staged
`RELEASE.json` records the original source/build snapshot.

## Release 20260917T095519Z

- Release: `/opt/poker/releases/20260917T095519Z`; previous release:
  `/opt/poker/releases/20260916T034843Z`.
- Source: `b2b708eda3c4fca3197e2f6a458dd2428e423fe3`, plus the current host-specific
  deployment files. Includes player achievement badges, chip/payout display,
  winning-card animation and mobile overlapping-card fixes since `5ea39b1`.
  Concurrent edits to `src/styles.css` and `tests/achievements.spec.ts` appeared
  locally at 18:03:20 +0800, after this release was built and verified. Those later
  edits are preserved in the workspace and are not part of this deployed snapshot.
- Application image:
  `sha256:8261deaf2c41b537a6aef6b6f10bdfc850a029b7bf62aa79f33996546544e09d`.
- Transfer archive SHA-256:
  `f97751124bf31573b576bf81fb7800776263a26a473f7697510ae65037af940d`;
  47 allowlisted files, 453,213 bytes. Verified before extraction; deployment
  documentation was synchronized again after acceptance.
- Pre-activation backup:
  `/opt/poker/shared/backups/poker-20260917T095519Z.dump`, 14,853 bytes, mode 600;
  `pg_restore --list` passed. The database container/image/data/socket volumes
  were unchanged. No database restore was performed.
- Rollback image: `river-room-app:rollback-20260917T095519Z`, retaining
  `sha256:d0941ada519ae33034d62b6923c3b1b0a86f302291beba15bdaa6ca0dc5d7d9d`.
  Any rollback must retain the current host-network/socket/proxy-trust settings
  and account for achievement fields added to persisted room state.
- The preflight found two open rooms, zero online players and one previously
  started room. App replacement completed at `2026-09-17T09:58:49Z`; previously
  started rooms recover paused until the owner resumes.
- Existing host Nginx on 443 was discovered during live inspection. Preserved
  its configuration, certificate, firewall rules, FRP process and Y2P container.
  Added only `127.0.0.1` to application proxy trust; before this adjustment the
  public HTTPS identity cookie lacked Secure. It now has Secure and HttpOnly.

Acceptance evidence:

- Backend: `.venv/bin/python -m pytest backend/tests -q` — 86 passed.
- Frontend: `npm run build` passed. Public HTML and referenced JS/CSS matched
  local build bytes over normally validated HTTPS. Public `/api/health` returned
  application JSON `{"ok":true}` with `Cache-Control: no-store`.
- Public JS `index-C7jQSh7v.js` SHA-256:
  `43980beae945c7030fded631bdc14a76eea6b5a9fa5a90feeeba04220078ec19`.
- Public CSS `index-B-GzfY7s.css` SHA-256:
  `e5dc0961dac08efa71dceffd0f5201402661e2ca1e0cecfd0637f668e51bf911`.
- Dedicated browser smoke at `https://rr.zandz.nexus` verified creation, WSS,
  identity-preserving reload and Secure/HttpOnly cookies.
- Browser suite with `BASE_URL=https://rr.zandz.nexus`: 21 passed in 2.1 minutes.
  Three existing room tests exercised real multiplayer APIs/WSS, recovery and
  nine seats, using a temporary run-specific cleanup wrapper. The other 18
  presentation/achievement tests used deterministic browser fixtures against
  deployed frontend assets; these do not establish live gameplay outcomes.
- Inspected desktop/mobile real-room and badge captures. Selected evidence is
  retained locally under `artifacts/deploy-20260917T095519Z/`.
- Run-owned rooms `wxoJ6EEIWHYg`, `QdSRzIfr_DMZ`, `OEQ_kgCt340B` and
  `uYZm-XaBBWgq` were ended via their owner APIs at the public hostname and
  confirmed to have `closed_at`. Existing rooms were not ended.
- App/DB healthy; one Uvicorn process on 8080, host network, no published app/DB
  ports or Docker DNAT. Application database query verified Unix-socket access.
  Startup logs contained no errors. Nginx and UFW hashes matched the baseline;
  DB/Y2P container IDs and FRP process remained unchanged.
- Acceptance proves the current public hostname path through existing Nginx.
  It does not assert an active Cloudflare proxy or revalidate direct-IP firewall
  behavior; neither Cloudflare nor firewall policy was changed for this release.

Server evidence: `/opt/poker/shared/build-20260917T095519Z.log`,
`/opt/poker/shared/baseline-20260917T095519Z.txt`, and
`/opt/poker/shared/backups/poker-20260917T095519Z.list`.

## Release 20260916T034843Z

- Active release: `/opt/poker/releases/20260916T034843Z`, selected through
  `/opt/poker/current` after verification.
- Previous release: `/opt/poker/releases/20260916T034053Z`.
- Same application source/image as first deployment: source commit
  `5ea39b1aea5ef5dc86a965285392d6984f981169`, application image
  `sha256:d0941ada519ae33034d62b6923c3b1b0a86f302291beba15bdaa6ca0dc5d7d9d`.
  This is a deployment-configuration change; no app rebuild was required.
- Removed the app port publication, enabled host networking and changed the
  database URL to the shared Unix socket. Both app and database containers were
  recreated once to attach that socket volume; the existing database data volume
  and password were preserved. Docker daemon iptables handling was left enabled.
- Pre-change query found zero open rooms.
- Pre-activation backup: `/opt/poker/shared/backups/poker-20260916T034843Z.dump`,
  8,966 bytes, mode 600. `pg_restore --list` passed before activation.
- Image retained as `river-room-app:rollback-20260916T034843Z`.
- Historical Nginx configuration retained only as an inactive backup:
  `/opt/poker/shared/backups/nginx-before-direct-20260916T034053Z.conf`.
  Nginx is uninstalled, so restoring the previous proxy topology would require
  explicit reinstallation/reconfiguration. No database restore was performed.

## Historical verification for 20260916T034843Z

- Compose configuration validation and application/database health checks passed.
- External 8080 was blocked with the existing UFW default-deny policy, succeeded
  after temporarily allowing only the verification source IP, and was blocked
  again after removing that temporary rule. UFW reload retained this behavior.
- During the temporary source allowance, port 8080 served matching production
  HTML/JS/CSS and a healthy API.
- A dedicated Chromium context verified room creation, WebSocket connection,
  identity-preserving reload, and HttpOnly cookies. A spoofed direct
  `X-Forwarded-Proto: https` header was ignored. The run's room was ended through
  its owner's API and checked closed in PostgreSQL.
- The host listener belongs to Uvicorn, Docker reports app network `host` with no
  published ports, and the Docker NAT chain has no 8080 rule. Database queries
  through the Unix socket succeeded. Other Poker-related ports stay unpublished.
- The user-managed Cloudflare hostname was not supplied, so actual edge
  HTTPS/WSS and Secure cookies through that hostname are not yet verified here.
- No gameplay code changed. The first deployment had already passed 73 backend
  tests, the production build, and all 3 room browser tests (multiple browsers,
  identity recovery, nine seats and mobile layouts).

## UFW management

8080 now follows ordinary UFW rules, for example:

```sh
# Allow a chosen source (replace the example address).
ufw allow proto tcp from 203.0.113.10 to any port 8080
# Remove that allowance.
ufw delete allow proto tcp from 203.0.113.10 to any port 8080
ufw status numbered
```

For Cloudflare-only ingress, allow each current official Cloudflare network to
8080 while retaining default-deny; do not add a global 8080 allowance. Updating
UFW policies does not require restarting Docker. Do not set Docker's global
`iptables` option to false for this setup; host networking needs no Docker NAT
rule and other bridge-network services keep their normal network management.

## Persistent files and operations

- Environment: `/opt/poker/shared/production.env`, mode 600; generated database
  credentials are kept only on the server.
- Backups: `/opt/poker/shared/backups/`, mode 700.
- Initial install/build logs remain under `/opt/poker/shared/`.
- First deployment was a fresh database; no data from the original server or local
  development environment was imported. The original `160.202.237.14` server
  was not changed.

```sh
ssh -i /Users/keyl1me/.ssh/id_ed25519 -o IdentitiesOnly=yes -p 60022 root@178.236.46.11
cd /opt/poker/current
docker compose --env-file /opt/poker/shared/production.env -f compose.production.yaml ps
docker compose --env-file /opt/poker/shared/production.env -f compose.production.yaml logs --tail 100 app
# From the deployment workstation, with normal TLS verification:
curl --fail https://rr.zandz.nexus/api/health
```

Future deployments must retain this host-specific Compose configuration, shared
environment and persistent database volume. Build/stage in a new release directory,
back up and validate the database, then activate and verify before updating the
symlink. Do not use `down -v`. App recreation pauses active hands until their owners
resume them.

The initial server had Docker Hub DNS/connectivity problems; official amd64 Python
and PostgreSQL images were imported from checksum-verified archives downloaded
locally with `crane`. Future uncached pulls may need that transfer path again.
