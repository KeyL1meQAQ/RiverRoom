# River Room: 178.236.46.11

Current configuration (verified 2026-09-19): public HTTPS/WSS at
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

## Release 20260919T094814Z

- Deploys the squid round badge before penalty flights with a server-timed
  three-second interval, black/gold styling, gold reward text and coral payment
  text. Zero-squid players display actual payment amounts.
- Source revision `72757f2dc9532bb08c8de1448cc8faf9c98fa60a` plus requested
  uncommitted changes; isolated snapshot and production build. No commit/push.
- Snapshot backend suite: 185 passed after compiling its native odds library;
  frontend build passed. Public acceptance: eight tests passed initially, then
  the real two-browser squid test passed after updating its old five-second
  notification timeout to account for the badge interval (nine passing cases).
  Both notification tests now assert the badge appears before the final notice.
- Verified public HTTPS health, exact HTML/JS/CSS bytes, WSS, identity reload,
  Secure/HttpOnly cookies, real multiplayer and squid gameplay. Fixture-driven
  badge captures at 1440px/390px were inspected; these use synthetic round data
  against the deployed frontend. Six run-created rooms were verified closed.
- Evidence: `artifacts/deploy-20260919T094814Z/`. Archive SHA-256:
  `b357863c3bbea82aa0a3ba5a5d8068297dff4e7ca1b9f19bf1ca95e97d6ecb9f`.
  The unused root Dockerfile was corrected after an archive path collision;
  production uses the separately verified `deploy/Dockerfile`. The final test
  timeout adjustment and documentation were synced separately with the manifest.
  Application sources did not drift after build.
- Backup: `/opt/poker/shared/backups/poker-20260919T094814Z.dump`, 217813 bytes,
  mode 600, validated by pg_restore. Previous symlink target:
  `/opt/poker/releases/20260919T074127Z`; actual running image saved as
  `river-room-app:rollback-20260919T094814Z`, image ID
  `sha256:cb59d0ea3ac58bdee4f21d9233e43b74851ff70de022d3968aa0048c4d207f52`.
- Before replacement: 16 open rooms, three started, zero online players.
  New app healthy, one Uvicorn process on host 8080, no published ports/DNAT;
  read-only database socket retained. DB/Y2P container identities/start times,
  FRP PID, Nginx/UFW hashes and unrelated listeners match the baseline.

## Release 20260919T074127Z

- Deploys the approved runout unique-win probabilities, including exclusion of
  all used cards, post-vote reveal, per-card/current-board updates, and green/red
  capsules. Mobile card geometry is preserved; only capsule size and position
  change. Both Docker build paths compile the native exact enumerator.
- Source: isolated snapshot of `8eaab866735d307bc4d2682be21334985afa9e64`
  plus requested uncommitted work. No source drift before final documentation
  updates; no commit or push was performed. Archive: 98 files, 609,401 bytes,
  SHA-256 `c0c1783987a92abca302149ba01670ca02ade0e3ca14d76731f8100cf52811a0`.
- Active release: `/opt/poker/releases/20260919T074127Z`; previous release:
  `/opt/poker/releases/20260918T145838Z`. After acceptance and cleanup,
  `/opt/poker/current` was atomically updated at `2026-09-19T07:55:55Z`.
- New image:
  `sha256:133e345330a6103cb897db8231c298e4d7090533267ef401b7c425e57c6a0366`.
  Only the app was replaced, starting at `2026-09-19T07:46:16.293840627Z`.
- Backup: `/opt/poker/shared/backups/poker-20260919T074127Z.dump`, 140,238
  bytes, mode 600; `pg_restore --list` passed before activation. No restore.
- Rollback tag: `river-room-app:rollback-20260919T074127Z`, retaining
  `sha256:d87bc9f7be2334c613a6d7449f6c0100dc286b254be3bc63660316e2856621a6`.
  Review persisted runout-state compatibility before rollback and retain the
  current network/socket/proxy-trust contract; do not automatically restore DB.
- Before activation and after cleanup: two open rooms, one started, zero online
  players. Original rooms were preserved. App replacement interrupts connections;
  existing started rooms recover paused until their owners continue.

Acceptance evidence:

- Isolated snapshot: 179 backend tests and the production frontend build passed.
  Server image built successfully; 19 native-equity tests passed in the container.
- Public Playwright first run: 38 passed, one failed out of 39. The nine-player
  performance case exceeded its 20-second settlement wait. A targeted recheck
  using phase polling passed (exit 0), confirming both runouts and settlement,
  while retaining the latency finding below. This is not a clean first-run pass.
- Real public rooms exercised 2/6/9-player double runouts. Fixture-driven UI cases
  verified rendering, percentages/colors and responsive layout, not live game
  outcome calculation. Desktop and 390px screenshots were inspected; browser
  coverage also included 320px.
- Public smoke verified HTTPS/WSS, identity-preserving reload, Secure/HttpOnly
  cookies, and health `{"ok":true}` with `Cache-Control: no-store`. Public HTML
  and referenced assets matched the staged build using normal TLS validation.
- JS `index-DkA8kh8j.js` SHA-256:
  `64728b488f1c14e16ca2815420a5e1f9c1d02e7d4f93028cf005628eb409d23d`.
  CSS `index-B_JfVHLv.css` SHA-256:
  `f75ad56a056c5f10abc8eb51964eee92c8276e1b66d259712e591333de6daa39`.
- All eight run-created rooms were closed through public owner APIs; a scoped
  database query confirmed 8/8 have `closed_at`.
- App/DB healthy, socket SQL check passed, no app ERROR/Traceback lines found.
  DB/Y2P container identity and start times, socket mounts, host networking,
  empty port publication, Nginx/UFW hashes, FRP and NAT state match baseline.
  No database recreation, firewall adjustment or proxy change was required.

Probability performance on the running production container (2 vCPUs):

| Calculation | Median time | Sampling scope |
| --- | ---: | --- |
| Preflop, 2–9 players | 202.855–394.639 ms | Five cold-result-cache samples per count; maximum 544.719 ms |
| Heads-up, first/second flop card visible | 22.008 / 1.950 ms | Ten samples per prefix |
| Heads-up, full flop / turn visible | 0.145 / 0.027 ms | Ten samples per prefix |
| Initial preflop plus three flop prefixes, 2/6/9 players | 362.365 / 403.892 / 254.865 ms | Five samples per count |

These are bounded synthetic calculations with the native library already loaded;
they do not mutate rooms and are not a concurrency or capacity stress test.

| Public real-game sample | Final vote HTTP | Concurrent health median | Baseline health median |
| --- | ---: | ---: | ---: |
| 2 players | 377.6 ms | 48.6 ms | 49.4 ms |
| 6 players | 654.2 ms | 51.7 ms | 50.7 ms |
| 9 players, recheck | 332.5 ms | 46.9 ms | 46.3 ms |

One real hand per player count was measured. Health used five baseline and
15 concurrent samples; concurrent maxima were 52.0/84.5/68.2 ms respectively.
No marked health delay was observed during initial calculation in these samples.
Badge detection used polling and is not a precise rendering-latency measurement.

Known performance finding: the nine-player complete double-runout-to-settlement
flow took approximately 20 seconds. The second board had four cards at 6.95 s,
five at 12.21 s, and settlement was observed at 20.12 s. On private copies of
that run-owned closed room, engine replay took 4.5–5.6 ms before the final river,
97.8–156.7 ms after it, and 126.9–167.1 ms once settled. Profiling located the
cost in PokerKit hand-killing / `can_win_now`; this replay did not call the new
probability calculator. Repeated `state_for` work for views/broadcasts is a
separate bottleneck, but these measurements do not fully attribute the entire
20-second flow. No settlement optimization is included in this release.

Evidence: `artifacts/deploy-20260919T074127Z/`, especially
`server-performance.json`, `public-performance.json`, `settlement-profile.json`,
`public-cleanup.json`, `operational-verification.json` and `finalized.json`.
Final deployment/research documents are synchronized separately from the
immutable tested application snapshot and their server hashes are compared.

## Release 20260918T145838Z

- Application source: `52392630379d88b71a3d0cc5782ea01d2c1b5347`, committed and
  pushed to `origin/main`. Adds server-timed settlement presentation, recipient
  pot transfers, sequential double-runout results, balance transitions and
  departed-player payment presentation. Reveal/rebuy waits begin after payout
  presentation completes.
- Active release: `/opt/poker/releases/20260918T145838Z`; previous release:
  `/opt/poker/releases/20260918T082921Z`. `/opt/poker/current` changed atomically
  after public acceptance and test-room closure verification at
  `2026-09-18T15:10:08Z`.
- Built from an isolated source snapshot with no detected source drift before
  final documentation updates. The allowlisted archive contained 90 files and
  588,446 bytes; SHA-256:
  `b95d7cf191e98874394e7a27cf3bf234e86c8136bfe1ece5e3cae441e90bf80a`.
  Archive and packaged file hashes were checked before the server build.
  Post-acceptance documentation is synchronized separately from the immutable
  application snapshot.
- New image:
  `sha256:d87bc9f7be2334c613a6d7449f6c0100dc286b254be3bc63660316e2856621a6`.
  Only the app was recreated, starting at `2026-09-18T15:02:19.48653504Z`.
  Database and Y2P container IDs, images and start times were unchanged.
  Database mount comparison was normalized by destination because Docker
  returned the same mounts in a different list order; the DB was not recreated.
- Backup: `/opt/poker/shared/backups/poker-20260918T145838Z.dump`, 102,181 bytes,
  mode 600, validated with `pg_restore --list` before activation. No restore.
- Rollback image: `river-room-app:rollback-20260918T145838Z`, retaining
  `sha256:385e3633937e632785be308a6524a9c37d42a8943c815bca2d974a9da9f060ef`.
  Assess compatibility with newly persisted settlement presentation state before
  rollback; retain the current network/socket/proxy-trust contract and do not
  restore the database automatically.
- Before activation: three open rooms, two started, zero online players.
  After test cleanup: the same open/started counts remain. Original rooms were
  not closed. App replacement interrupted connections; started rooms recover
  paused until their owners continue.

Acceptance evidence:

- Isolated snapshot: 160 backend tests and the production build passed.
- All 57 public Playwright cases passed in 5.0 minutes, with exit code 0,
  including successful teardown. Real scenarios covered multiplayer rooms,
  recovery, showdown, squid payment and double-runout settlement. The added
  live settlement case verified first-result presentation without premature
  payment or future-board disclosure, and reveal after presentation.
- Dedicated public smoke verified HTTPS, WSS, identity-preserving reload and
  Secure/HttpOnly cookies. Fixture-driven presentation cases establish deployed
  frontend rendering/interaction, not every live server game outcome.
- All 21 run-created rooms were closed through owner APIs, then a scoped
  read-only database query confirmed 21/21 have `closed_at`.
- Public health returned `{"ok":true}` and `Cache-Control: no-store`; public HTML
  and assets matched the staged build with normal TLS validation.
- Public JS `index-6N2d5Lcf.js` SHA-256:
  `09d41aebf6348f6f6077eb13a12f6339d89cea91dc03db61349f9a17424f2dcb`.
- Public CSS `index-lEgGXydA.css` SHA-256:
  `1e27775829c912df2735074f4a283e23dbda2216ae891f85f6e891b066504093`.
- Inspected this run's desktop pot-transfer and 390px departed-player payment
  captures. Timing and balance transitions were checked by browser assertions;
  static animation captures alone do not establish those transitions.
- App/DB healthy, socket SQL query passed, one Uvicorn process, host networking,
  restart policies, mounts, listeners and unpublished ports preserved. No app
  error/traceback/critical log lines were found at finalization. Nginx/UFW hashes,
  routes, firewall, Docker NAT, FRP and Y2P matched the baseline.
- Acceptance verifies the public hostname through existing Nginx; it does not
  assert Cloudflare proxying or re-test direct-IP firewall behavior.

Workstation evidence: `artifacts/deploy-20260918T145838Z/`, including source and
package manifests, backend/build logs, `public-browser-result.json`,
`public-cleanup.json`, `smoke.json`, `live-settlement.json`, `public-assets.json`,
`operational-verification.json`, `final-state.json`, `finalized.json` and
`public-captures/`. Server records under `/opt/poker/shared/` include
`build-20260918T145838Z.log`, `activation-20260918T145838Z.json`,
`verified-20260918T145838Z.json`, rollback metadata and backup/listing.
The run-owned remote transfer archive was removed.

## Release 20260918T082921Z

- Application source: `05019f6f28270be02171d515e045887ed3047592`, committed and pushed to `origin/main`
  before deployment. Includes squid rounds, dynamic participation, capped independent
  payments, leave/rejoin balances, configurable automatic reveal, and mobile
  horizontal badges with top-left rank/suit indexes. Also carries the earlier
  committed nine-player settlement fixes and 2–7 bounty changes not present in
  the previous production release.
- Active release: `/opt/poker/releases/20260918T082921Z`; previous release:
  `/opt/poker/releases/20260917T101857Z`. `/opt/poker/current` changed atomically only after public
  acceptance and test-room closure verification.
- Built from an isolated 83-file source snapshot. The allowlisted transfer had
  83 files and 569,606 bytes; SHA-256:
  `d8c2fd334ccb23f9b2aa2e329867e049a9f749cf915b6a01a66aadfc1b1374f6`.
  Every packaged source/dist hash was checked before building on the server;
  no concurrent source edits were detected. Post-acceptance documentation is
  synchronized separately from the immutable application snapshot.
- New image: `sha256:385e3633937e632785be308a6524a9c37d42a8943c815bca2d974a9da9f060ef`.
  Only the app container was recreated, starting at `2026-09-18T08:36:16.265773183Z`.
  Host networking, 8080 listener, explicit proxy trust, Unix-socket DB mount and
  both restart policies remain unchanged. Database and Y2P IDs/start times,
  FRP process, Nginx/UFW hashes and firewall rules matched the preflight baseline.
  No new published ports or Docker DNAT for 8080 were introduced.
- Database backup: `/opt/poker/shared/backups/poker-20260918T082921Z.dump`,
  77,642 bytes, mode 600. Created through the previous release's DB service and
  validated with `pg_restore --list` before activation. No data restore occurred.
- Rollback image: `river-room-app:rollback-20260918T082921Z`, holding previous image
  `sha256:13a1b55c9e89e0cb9bc4f1780f565b6a9447e0be90c705a3b207bfcd3694708e`.
  The old image does not implement squid-held balances: before an application
  rollback, inspect/resolve any new unfinished squid rounds and held funds using
  compatible code. Do not blindly deploy the old code over such state or restore
  the backup and discard later operations. Preserve the current network contract.
- Preflight and pre-activation: three open/started rooms, zero online players.
  All three original rooms remain open and paused for owner recovery after restart.

Acceptance evidence:

- Isolated snapshot: 153 backend tests, production build and 50 local browser
  tests passed. Same snapshot tests were used for public verification.
- Public `https://rr.zandz.nexus/api/health` returned application JSON with
  `Cache-Control: no-store`. Public HTML and referenced assets matched the staged
  build byte-for-byte with normal TLS verification.
- Public JS `index-C6YmEVXW.js` SHA-256:
  `892522f9960492a4db75468042602ff4dc02cdc670b46d168d138e7ce5cdb67e`.
- Public CSS `index-CRnkW3On.css` SHA-256:
  `f0bb2a0c3c3901d9e4bfbfb50d1cf8bc637921b0a87b7e6fee2e7cdf450c622e`.
- All 51 public browser test cases passed (about 5.5 minutes), including dedicated
  HTTPS/WSS, identity-preserving reload and Secure/HttpOnly cookie checks, real
  multiplayer approval/recovery/showdown, real squid creation and payment, and
  deployed frontend presentation tests. Fixture-based cases intercept game state;
  they establish frontend rendering/interaction, not every server game outcome.
- The initial command exited nonzero because teardown actions for two run-created
  rooms returned HTTP 400. Both had accepted the end request. Subsequent read-only
  inspection and public API checks found both already closed; no database edits,
  credential recovery or production-room actions were needed. The 51 test cases
  passed, but the initial full invocation was not a clean exit.
- All 20 captured run-created room IDs were verified closed, then confirmed by a
  scoped read-only PostgreSQL count of 20/20. Original rooms were not closed.
- Inspected run-specific 390px three-badge/corner-index capture and real mobile
  multiplayer capture. The latter was captured during community-card animation;
  settled layout acceptance uses the deterministic settled captures and geometry
  checks at 320/360/390/760/761/1440px.
- Application health and socket-based SQL query passed; one Uvicorn process,
  private PostgreSQL, shared Nginx 443 and unrelated services were preserved.
  Acceptance verifies the public hostname through Nginx; it does not assert
  Cloudflare proxying or re-test direct-IP firewall access.

Evidence on workstation: `artifacts/deploy-20260918T082921Z/`, including
`commit-review.json`, `source-manifest.json`, `baseline.json`, `after.json`,
`operational-verification.json`, `public-assets.json`, `public-browser.log`,
`public-cleanup.json`, `cleanup-recovery.json`, `finalized.json`, and
`public-captures/`. Server records include `build-20260918T082921Z.log`,
`activation-20260918T082921Z.json`, `verified-20260918T082921Z.json`, and the
backup/listing under `/opt/poker/shared/`. Run-owned transfer archive removed.

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
