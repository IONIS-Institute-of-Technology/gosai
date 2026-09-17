# GOSAI refresh plan

Temporary file. It splits the GOSAI refresh into 16 PRs for agents to implement. Delete it once the last PR merges.

The plan comes from a read-only audit of commit `4e6320a`. File and line references point at that commit. Treat them as starting points and check the code before editing, because earlier PRs will have moved things.

## How to use this file

1. Find your PR in the order table and check that everything it depends on has merged.
2. Read the rules, the decisions, and your PR's section. The scope bullets say what to do. The evidence list shows where the problems are.
3. Branch from `master` as `refresh/pr-NN-short-name`.
4. Stay inside your PR's scope. If you find something that belongs to another PR, mention it in your PR description instead of fixing it.
5. Don't edit this file in an implementation PR. Parallel branches would conflict on it.

## Rules for every PR

- GOSAI is a generic platform for AR products. `apps/interactive-pool`, `apps/second-self` and `apps/calibration` are bundled demos, not the full list of use cases.
- Don't remove a Python driver, driver option or action, server event, manifest capability or SDK export because the bundled apps don't use it. Remove platform code only when it is internal and nothing calls it, or when it is broken with no way to make it work.
- Demo apps import only the public `@gosai/sdk` entry, like a third-party app would. When a demo needs something the SDK lacks, add it to the SDK instead of copying it into the app.
- Dead code inside a demo app can go.
- Keep CI green once PR 1 adds it, and add tests for what you fix.

## Decisions already made

- Drivers no bundled app uses stay: `speech_to_text`, `speech_activity_detection`, `speaker`, `hand_sign`, `interpolate`. They get fixes and tests.
- Training data stays in the repo for now and will move out later. Stray and generated files can go.
- Licensing is out of scope for now. Keep the assets the apps actually use, and delete the unreferenced ones.
- `@gosai/sdk` becomes a public npm package.
- Supported targets are Linux x64 and macOS arm64. Windows x64 is welcome if it's cheap, but not required. Intel macOS and ARM Linux are not targets.
- Git history gets rewritten once, between waves 1 and 2. See the section below.

## Baseline at `4e6320a`

- `bun install` and `bun run typecheck` pass for the five `@gosai/*` packages. The four apps also pass `tsc --noEmit` with their own loose tsconfigs.
- `bun test packages/server/test` passes 36 tests. `bun run test` and `bun run lint` exit 1 because no package defines those scripts.
- `bunx prettier --check .` flags `apps/second-self/src/shared/sleep.ts`.
- There is no CI, and no lint config for JS or for `training/`.

## Order

| PR  | Title                                            | Depends on   | Wave            |
| --- | ------------------------------------------------ | ------------ | --------------- |
| 1   | Tooling baseline and CI                          | none         | 1               |
| 2   | Asset cleanup                                    | none         | 1               |
|     | History rewrite                                  | 1, 2         | between 1 and 2 |
| 3   | Lock down the server and Electron windows        | 1            | 2               |
| 4   | Driver lifecycle across server and Python bridge | 1            | 2               |
| 5   | Python dependencies, accelerator, models         | 1            | 2               |
| 6   | Training pipeline cleanup                        | 1            | 2               |
| 7   | Typed protocol, one client, server core          | 3, 4         | 3               |
| 8   | SDK runtime and app hosting                      | 3            | 3               |
| 9   | Desktop boot, kiosk and packaging                | 3, 5         | 3               |
| 10  | Python drivers: fixes, tests, schemas            | 4, 5         | 3               |
| 11  | Calibration contract v2                          | 7, 8, 9      | 4               |
| 12  | Public SDK release                               | 7, 8, 10     | 4               |
| 13  | Dashboard renderer                               | 9, 10, 11    | 5               |
| 14  | interactive-pool on the public SDK               | 10, 11, 12   | 5               |
| 15  | second-self on the public SDK                    | 2, 12        | 5               |
| 16  | App-provided Python drivers (optional)           | 5, 7, 10, 12 | 5               |

PRs in the same wave can run in parallel. Known overlaps:

- PRs 8 and 9 both edit `packages/desktop/src/main/windows.ts`. Merge 9 first.
- PRs 11 and 12 both touch the SDK. PR 11 owns `packages/sdk/src/calibration.ts`.
- PR 10 renames a ball payload field that interactive-pool reads, and updates those reads itself.
- PR 4 changes action errors from `{"ok": false}` replies to rejected requests, and updates the app call sites itself.

## History rewrite, between waves 1 and 2

Run this after PRs 1 and 2 merge and before anyone opens a wave 2 branch. It changes every commit hash.

Facts from the audit:

- `.gitattributes` only arrived in `4e6320a`. History still stores 446 MB of raw blobs, 43 of them over 1 MB and 321 MB in total. Examples: `dance02.gif` at 57 MB from `11e8bcc`, which is no longer at HEAD; `ball.onnx` at 38 MB from `4738840`; the training JPGs from `690a616`.
- LFS content at HEAD totals 613.6 MB.

Steps:

1. An agent works in a fresh mirror clone and writes `deleted-paths.txt`. It lists every path PR 2 deleted, plus large blobs in history that no longer exist at HEAD, such as `dance02.gif`. The owner reviews the list.
2. `git filter-repo --invert-paths --paths-from-file deleted-paths.txt`.
3. `git lfs migrate import --everything --include="*.jpg,*.jpeg,*.png,*.gif,*.webp,*.webm,*.mp4,*.onnx,*.vrm"`, which uses the same patterns as `.gitattributes`.
4. Verify:
   - `git lfs fsck` passes.
   - `git ls-tree -r HEAD` lists the same paths as before.
   - LFS object ids at HEAD match the old ones.
   - CI passes on the rewritten `master`.
   - The pack is far smaller than the current 415 MB.
5. The owner force-pushes branches and tags. Everyone re-clones.

GitHub keeps counting orphaned LFS objects against storage. According to GitHub's docs, only deleting and recreating the repository frees that space. Old pull request refs also keep old objects reachable on GitHub's side.

---

## PR 1. Tooling baseline and CI

Depends on: none. Wave 1.

### Scope

- CI with GitHub Actions and `lfs: false` on checkout.
  - JS: `bun install --frozen-lockfile`, `format:check`, oxlint, a no-emit typecheck of packages, apps, templates and `scripts/`, and `bun test` for the server.
  - Python: `uv sync --locked`, then ruff, pyright and pytest for `python/`, on Linux x64 and macOS arm64.
  - Training: ruff for `training/`.
- Working root `lint` and `test` scripts, and a `test` script in the server package. The server tsconfig includes `test/`.
- A slimmer `tsconfig.base.json`.
  - Drop `composite`, `declaration`, `declarationMap` and `incremental`.
  - Drop the flags `strict` already enables.
  - Remove DOM from the base and add it only in browser packages.
  - Set `verbatimModuleSyntax: true`.
  - Apps and the template extend the base. Add a tsconfig for `scripts/`. Fix the errors this surfaces.
- Stop emitting build output nothing reads.
- `build:apps` uses `bun run --filter './apps/*' build`. Declare `typescript` once, at the root.
- The SDK `dev` script rebuilds `dist/browser.js` with `bun build --watch`.
- Replace `concurrently` in the root `dev` script with `bun run --filter`.
- Version bumps, landed here so their formatting churn lands before the parallel PRs:
  - Bun 1.4.2 in `packageManager`, `engines` and `@types/bun`.
  - In-range lock refresh: hono 4.13, react 19.3, `@types/*`.
  - prettier 3.9.7 and ruff 0.16.
- Try TypeScript 7. If it raises more than a handful of errors, stay on 5.9 and write a follow-up in the PR description.
- Python dev tools move to `[dependency-groups] dev` in both pyprojects. Add a `python:check` script that runs ruff, pyright and pytest. Commit `training/uv.lock`.
- Repo config.
  - `.gitattributes` gets `* text=auto eol=lf`.
  - Delete the contradictory comment and the empty scopes block from `bunfig.toml`.
  - Delete the "Lockfiles to keep" block from `.gitignore` and `.cursor/` from `.prettierignore`.
  - Add Renovate or Dependabot.
- Fix the prettier warning in `apps/second-self/src/shared/sleep.ts`.

### Evidence

- `package.json:24,26-28`: `test`, `typecheck` and `lint` filter `@gosai/*`. No package defines `lint` or `test`, and the apps and template are skipped even though each defines `typecheck`.
- `packages/server/tsconfig.json:11` includes only `src`. Including `test/` reveals one TS2352 error in `test/app-manager.test.ts`.
- Under the base flags, `apps/second-self/src/layers/sign-game.ts:307` has an unused parameter and `scripts/package-kiosk.ts:27` imports with a `.ts` extension.
- `packages/desktop/tsconfig.node.json:4,11` and `tsconfig.web.json:4` inherit `composite` and `declaration`. `tsc -b` writes `out/src/**` and `out/electron.vite.config.js`, and `packages/desktop/electron-builder.config.cjs:42` packs `out/**/*`.
- `tsconfig.base.json`: `:5` adds DOM to Bun code; `:10-15` repeat what `strict` sets; `:29` sets `verbatimModuleSyntax: false`, and flipping it gives 0 errors; `:30-34` apply emit settings to everything.
- `apps/*/tsconfig.json` and `templates/basic/tsconfig.json` are four identical standalone files with `jsx: preserve` and no `DOM.Iterable`.
- Root `tsconfig.json:3-9` references only packages.
- Unused build output:
  - `packages/server/package.json:16` runs `tsc -b` and `bun build` into the same `dist`, and nothing uses the server `dist`.
  - `packages/shared` emits a `dist` nobody imports, since exports point at `src`.
  - `packages/cli/package.json:12` emits declarations nobody uses.
  - `packages/sdk/package.json:17` emits `dist/*.js`, of which only `browser.js` is used.
- `packages/sdk/package.json:21`: `dev` only runs `tsc -b --watch`, so `browser.js` goes stale during `bun run dev`.
- `package.json:22`: `build:apps` hardcodes four names chained with `&&`, including the `hello-gosai` template.
- `typescript` is declared in 10 `package.json` files.
- `package.json:48`: `packageManager: bun@1.3.13` while the runtime is 1.4.2. `@types/node ^26` doesn't match `engines.node >=22.12`.
- `python/pyproject.toml:32-36` and `training/pyproject.toml:36` put dev tools in an optional extra, and `package.json:34` runs a plain `uv sync`. pyright is configured at `python/pyproject.toml:71-74`, but nothing runs it. `package.json:35` lints only `src`.
- `training/.gitignore:3` ignores `uv.lock`, and every training dependency is a loose floor.
- `bunfig.toml:3-4` says "Use exact versions for reproducibility" next to `exact = false`. `:9-10` is an empty scopes block.
- `.gitignore:45-47` and `.prettierignore:2` are leftovers.
- Available versions on 2026-09-17: TypeScript 7.0.2 (6.0.3 is the last JS-based release), prettier 3.9.7, ruff 0.16.8, hono 4.13.8, react 19.3.0, concurrently 10.0.5, @types/bun 1.4.2.

---

## PR 2. Asset cleanup

Depends on: none. Wave 1. It changes no code logic apart from asset paths.

### Scope

- Delete assets nothing references, and duplicates.
- Grep for every name before deleting. Some paths are built from strings in `apps/second-self/src/shared/media.ts`, `sign-game.ts`, `sign-training.ts` and `assets/sign-game/script.txt`.
- For `slr_samples`, also check `python/src/gosai_py/drivers/slr.py` and the SLR class list.
- Merge the sign videos duplicated between sign-game and sign-training into one folder and update both layers.
- Fix the doc and manifest errors listed below.

### Evidence

Paths are relative to `apps/second-self/assets/` unless noted.

- `sign-training/videos/videos/` is a byte-identical copy of `sign-training/videos/`: 23 webm files, 110 MB, same blob ids.
- `sign-game/backgrounds/AdobeStock_*.jpeg` (11 files, about 19 MB) and `Bedroom.png` are unreferenced. `sign-game/script.txt:9-14` only defines Empty, Market, Path, City, Home and Street.
- Twelve animations in `sign-game/characters/Aria/animations/` are byte-identical to sign-training videos: apple, eat, goodbye, house, leave, no, peach, skip, sorry, store, television, yes.
- Unreferenced according to the audit:
  - 44 sprites: Lina04, 06, 08, 11 and 12; 35 sprites named after signs; Grandmother04; Seller01, 04 and 05.
  - 8 Aria animations: iloveyou, my, name, ok2, skip, sorry, thanks, to_meet_you (32 MB).
  - 9 sign-training videos: hey, iloveyou, my, name, nice, skip, sorry, thanks, to_meet_you (5.9 MB).
  - 11 `sign-training/slr_samples` folders: empty, hey, iloveyou, my, name, nice, nothing, skip, thanks, "to meet you", "what's up".
  - Music: `la_vie_en_rose.json`, `no_time_to_die.json`, `score_test.json`, `tonalities-alterations.json`.
  - All 8 `menu/icons/*.svg`.
- `apps/interactive-pool/README.md:51-52` and `apps/interactive-pool/src/shared/audio.ts:1-5` point to `assets/audio/README.md`, which doesn't exist. The mp3 files are already committed.
- `apps/second-self/gosai.app.json:9` declares `speaker: false`, yet the app plays synthesized audio.
- `apps/second-self/README.md` has three errors:
  - `:33` says calibration is reflection-only, but `src/main.ts:270-273` always offers it.
  - `:43,62` say only the avatar uses raw pose data, but `sleep.ts` and `calibrate.ts` use it too.
  - `:99` says "two fields" above a table with seven rows.

---

## PR 3. Lock down the server and Electron windows

Depends on: PR 1. Wave 2. Keep this narrow so it merges fast.

### Scope

- Tokens.
  - A dashboard token generated at each launch, and a token per app tied to its slug.
  - Desktop main passes the dashboard token to the server and the dashboard, and gives each app window its app token.
  - The SDK and renderer clients send their token when connecting.
- An Origin and Host allowlist on HTTP and on the `/ws` upgrade. Remove the wildcard CORS headers.
- App tokens can't install or uninstall apps, call `config:set`, read or write another app's storage, or subscribe to `*`. PR 7 turns this list into capabilities declared per command.
- The static route resolves symlinks with `realpath` on both sides and checks the result with `path.relative`.
- Validate slugs and bindings wherever a command or route receives them.
- Installer.
  - Run `git clone --depth 1 -- <url> <dest>`, allowing only https and ssh URLs (plus `file:` when a test flag is set), with `GIT_TERMINAL_PROMPT=0`.
  - Build in staging and rename into place only on success. Fall back to copying only on EXDEV.
  - Lock per slug.
  - Stream stdout and stderr to the logger, with a timeout on every step.
- Electron.
  - Set `sandbox: true` on the dashboard.
  - In `app.on('web-contents-created')`, deny `window.open`, navigation and permission requests by default, allowing `media` only for app-host windows.
  - Check `event.senderFrame` in every IPC handler.
  - Delete the unused app-host preload.
- Trim `/v1/info` so it no longer exposes filesystem paths.
- Tests: gateway auth and scopes, static route traversal including symlinks, slug validation, and cleanup after a failed install.

### Evidence

Paths are relative to `packages/server/src/` unless noted.

- `server.ts:104-111` sends `Access-Control-Allow-Origin: *` on every response. `server.ts:246-256` upgrades `/ws` with no Origin or token check.
- `server.ts:326-330` handles `app:install`, and `apps/installer.ts:181-186,216-221` then run `bun install` and `bun run build` in the clone. Together, any web page or DNS-rebinding attack can run code on the machine.
- App windows get dashboard-level power. `server.ts:325-464` registers every command for every client, `ipc/gateway.ts:225-232` lets any client subscribe to `*`, and storage over HTTP (`server.ts:181-200`) has no access control. `packages/shared/src/events.ts:15-18` describes isolation that nothing enforces.
- `apps/installer.ts:108`: `git clone` has no `--` separator and no scheme allowlist, and it can prompt for credentials.
- `server.ts:208-217`: the static route normalizes the path, then checks `startsWith` without a trailing separator and strips just one leading `../`. It follows symlinks from cloned repos.
- `server.ts:415-427` passes `appSlug` to `config/app-settings.ts:67-69`, so `"../../x"` escapes the data directory. `server.ts:64` passes a client-supplied `binding` the same way.
- `apps/installer.ts:50-55,72-79` move the clone into place before `bun install` and the build, and the error path only cleans staging. `safeRename` (`:229-239`) falls back to `cpSync` on any error, which merges two installs of the same slug.
- `apps/installer.ts:142-151,181-199,216-226` pipe stdout but never read it, and read stderr only after exit, so a noisy build blocks. Only git has a timeout.
- `apps/installer.ts:232,235` calls `require('node:fs')` inside ESM, next to a static import.
- Electron:
  - `packages/desktop/src/main/windows.ts:118` sets `sandbox: false` on the dashboard.
  - Nothing under `packages/desktop/src` calls `setWindowOpenHandler`, handles `will-navigate`, or calls `setPermissionRequestHandler`.
  - `packages/desktop/src/main/ipc.ts:12-88` never checks the sender or validates arguments.
- The app-host preload is unused: `packages/desktop/src/preload/app-host.ts`, its entry in `electron.vite.config.ts:26`, `renderer/src/types.d.ts:70-73,78` and `windows.ts:170,315`.
- Token plumbing:
  - `packages/desktop/src/main/server-runner.ts` spawns the server.
  - `windows.ts:239,338` build window URLs.
  - `packages/sdk/src/connection.ts` and `packages/desktop/src/renderer/src/lib/server-client.ts` open the sockets.

---

## PR 4. Driver lifecycle across the server and Python bridge

Depends on: PR 1. Wave 2.

### Scope

- TypeScript holds the desired driver state as leases, one per client, driver and event. Python runs drivers and reports their state. Remove dependency starting from Python.
  - A client that subscribes twice holds two leases.
  - After a bridge restart, the two sides reconcile.
- Fix the confirmed bugs in `drivers/manager.ts`, listed in the evidence.
- Inject the bridge into `DriverManager` through an interface, so tests don't monkeypatch private fields.
- One camera config resolver, used by both cold start and hot apply. Small edits to the `server.ts` call sites are fine here.
- Bridge supervisor.
  - Restart with backoff and re-apply leases, so experiences don't keep showing `running` over a dead bridge.
  - Send `ready` before importing driver modules.
  - On shutdown, send `shutdown`, close stdin, wait for exit, then SIGKILL.
- Parse the bridge's stdout buffer in linear time.
- Replace `bun --hot` in the server's `dev` script with `bun --watch`.
- Python bridge.
  - Exit the loop right after `shutdown`, and handle SIGTERM.
  - Reply to `start-driver` only after `pre_run` finishes. When it fails, remove the instance and reply with an error.
  - If a driver thread is still alive after the stop timeout, keep the instance and report `errored`.
  - Run execute, start, stop and list requests on a serial queue per instance. Answer `ping` on the main loop.
  - One writer thread that keeps only the latest value for each stream event, and never drops replies or logs.
  - Loop `os.write` until every byte is written.
  - Summarize metrics once a second, and skip idle loop iterations.
  - Deliver each in-process subscriber through its own latest-value worker.
  - Fold subscriptions and the worker lifecycle from `BaseProcessor` into `BaseDriver`, then delete `processor.py`.
  - Driver actions raise on error, and the bridge sends `ok: false`. Update the app call sites.
  - Protocol version in `ready`, and the instance id in logs and metrics.
  - Strip only top-level `_` keys from payloads, and encode with msgspec. PR 10 uses msgspec for driver schemas.
- Use one timestamp unit, milliseconds, across the bridge boundary.
- Tests.
  - A TS contract test that spawns the real bridge with the `heartbeat` driver.
  - Server tests for named-event subscribe and unsubscribe, a dependency that is already running, `stopping`, and a device change during a subscription.
  - Python tests for the stdio loop, shutdown, restart after a failed start, and the stop timeout.
  - Python tests must stop the threads they start.
- Delete `packages/server/test/smoke-e2e.ts` and `phase4-e2e.ts`, which are already broken. Move the driver metadata checks from `phase5-e2e.ts` and `phase6-e2e.ts` to pytest, then delete those files. Keep `phase7-e2e.ts` as an install test that only runs when a flag is set.
- Don't change the command handlers in `server.ts` beyond wiring, to avoid conflicts with PR 3.

### Evidence

Paths are relative to `packages/server/src/` unless noted. Python paths are relative to `python/src/gosai_py/`.

- Named-event unsubscribe never stops the driver. `drivers/manager.ts:317` and `:188`: `startInstance` records the requester with an implicit `'*'`, and unsubscribing removes only the named event, so the camera stays on until the socket closes. The SDK's `drivers.on(driver, 'color')` takes this path. Confirmed with a test.
- A running dependency gets stuck in `starting`. `drivers/manager.ts:303-308` re-marks it, `bridge.py:227-228` treats the repeat start as a no-op and sends no state, and so `drivers/camera-config.ts:12` silently skips hot apply. Confirmed.
- Every stop shows `errored`. `drivers/manager.ts:659-671` has no `stopping` case, while `bridge.py:253` sends `stopping` on every stop and `packages/shared/src/types.ts:16-17` includes it. Confirmed.
- `drivers/manager.ts:454-458` derives the instance key again from the current device settings, so changing the speaker device while subscribed makes unsubscribe miss the instance.
- The bridge is never restarted. `drivers/manager.ts:105-110`, `server.ts:72-81` and `drivers/bridge.ts:127-133` clear driver state when it exits and never retry. `bridge.py:493-494` imports every driver before `ready`, which has to fit inside a 15 s timeout.
- Shutdown skips driver cleanup. `drivers/bridge.ts:151-167` kills the process right after sending `shutdown`. `bridge.py:480-483,497-499` only checks its running flag after the next stdin line.
- A driver that fails to start can't be restarted. `driver.py:162-167` and `bridge.py:227,239,420` keep a dead instance when `pre_run` fails, and later starts do nothing.
- `driver.py:159-160` and `bridge.py:257` report `available` while the driver thread may still be running.
- The camera floods Node with metrics. `driver.py:188` sends `loop_ms` after every loop, `drivers/camera.py:75,405-407` loops every 2 ms with no new frame, and `bridge.py:177-186` forwards all of it, up to about 500 lines a second.
- `bridge.py:140` ignores the return value of `os.write`.
- Every request runs inline on the main thread (`bridge.py:497-513`). Slow examples:
  - STT `medium.en` on CPU (`drivers/speech_to_text.py:32,125`)
  - the mirror solver grid (`drivers/pose_to_mirror.py:708-724`)
  - ONNX loads (`drivers/slr.py:139`, `drivers/ball.py:410-415`)
  - camera renegotiation (`drivers/camera.py:180-208`)

  Ping times out after 5 s (`drivers/bridge.ts:175`).

- Subscribers block the emitter. `bridge.py:159-164` runs callbacks on the emitting thread, and `drivers/calibration.py:114-137` runs ArUco detection on the camera loop.
- `bridge.py:136-140`: one blocking write lock makes every driver wait on Node.
- `processor.py` is used by 9 drivers only as "subscribe plus a latest-frame worker", and each driver starts and stops that worker by hand (`drivers/pose.py:125,132`, `drivers/hand_pose.py:153,160`, `drivers/ball.py:387,390`). `drivers/calibration.py:98-108` reimplements subscriptions.
- Two owners. `drivers/manager.ts:294-388` refcounts in TS while `bridge.py:233-235` starts dependencies in Python, and Python's `available` wipes TS subscriber records (`drivers/manager.ts:499-502`).
- `drivers/manager.ts:311-319` treats a `start-driver` reply as success, though Python only replies "thread spawned" (`bridge.py:420`, `driver.py:163-170`).
- `bridge.py:536-551` rebuilds every payload recursively. `bridge.py:494` sends only the package version in `ready`, and `drivers/bridge.ts:286` just logs it. `bridge.py:58-62` leaves the instance out of logs.
- `bridge.py:155` sends timestamps in seconds, and `drivers/manager.ts:102` forwards them as millisecond `PerformanceSample.timestamp`.
- `drivers/bridge.ts:224,260-267` scans the whole growing string buffer again on every chunk.
- Camera config differs between paths. `drivers/camera-config.ts:15-21` sends the raw per-app block, using `rotation ?? 0` and possibly undefined width and height (`config/app-settings.ts:51-53` casts partials). Startup layers global settings under the app block (`server.ts:65`), and `config:set` hot-applies only to `'system'` (`server.ts:411`).
- `package.json:14`: `bun --hot` re-runs `index.ts` in the same process, so every save starts another bridge, monitor interval and set of signal handlers.
- Error replies:
  - Drivers return `{"ok": False}` inside successful replies: `drivers/hand_pose.py:183-224`, `drivers/ball.py:501-517`, `drivers/calibration.py:455-503`, `drivers/slr.py:121-124`.
  - interactive-pool only uses `.catch` (`apps/interactive-pool/src/shared/calibration.ts:46-91`).
  - second-self checks `r.ok` (`apps/second-self/src/layers/calibrate.ts:281,334`).
- Tests monkeypatch private fields: `packages/server/test/driver-lifecycle.test.ts:90-97,221-279`, and they only ever subscribe with `'*'`.
- Broken e2e scripts. `test/smoke-e2e.ts` and `test/phase4-e2e.ts` wait for `driver:event`, but events are now `driver:event:<binding>` (`drivers/manager.ts:430`). `docs/quick-start.md:107` references these scripts.
- Python test hygiene. `python/tests/test_bridge_multiinstance.py` starts driver threads it never stops, and `bridge.py:87` duplicates the stdout file descriptor for every `Bridge()`.
- Dead code:
  - `drivers/manager.ts:165-173` (`startDriver`, `stopDriver`) and `drivers/bridge.ts:27-28` (`venvName`, `env`).
  - `drivers/bridge.ts:172-177` (`ping`): use it for the supervisor health check or delete it.
- Slop:
  - Banner comments at `drivers/manager.ts:290,415,449,518,575`.
  - Swallowed errors at `drivers/manager.ts:284-285,399-409` and `drivers/bridge.ts:150-156`.
  - A type declared between imports at `drivers/bridge.ts:17-23`.

---

## PR 5. Python dependencies, accelerator and models

Depends on: PR 1. Wave 2.

### Scope

- Remove pillow, soundfile, msgpack, torchaudio and scipy after grepping each one. Add msgspec if PR 4 hasn't already.
- Keep the speech drivers. Run Silero voice detection through onnxruntime, and use `ctranslate2.get_cuda_device_count()` for the CUDA check, so the `speech` extra no longer needs torch. If a test on recorded audio shows different detection results, keep torch and say why in the PR.
- onnxruntime.
  - CPU `onnxruntime` by default, plus a `gpu` extra with `onnxruntime-gpu`, declared as conflicting in uv.
  - The desktop bootstrap adds `gpu` on Linux x64 when it finds an NVIDIA GPU.
  - macOS arm64 uses the CoreML provider.
  - Align the version floors.
- Set `[tool.uv] environments` to Linux x64, macOS arm64 and Windows x64.
- Rewrite `runtime/accelerator.py` around one parse of the environment into a dataclass, a table of providers, and a check after the session is created.
  - TensorRT is opt-in.
  - `GOSAI_ACCELERATOR=cuda` no longer breaks MediaPipe.
  - Small models such as SLR can run on CPU.
  - One `select_torch_device` helper, if torch stays.
- A `models.py` registry that any driver can use to declare a model: URL, sha256, and whether it's bundled or downloaded.
  - Pin the MediaPipe `.task` URLs.
  - Detect LFS pointer files that were never pulled.
  - Read `ball.onnx.json` when present. PR 6 writes it.
  - The ball driver reads its input size from the ONNX session.
- Upgrades, each in its own commit: MediaPipe 1.0 and onnxruntime 1.30. numpy and pyright bumps within range.
- CPU smoke tests that load `slr_16.onnx`, `slr_17.onnx` and `ball.onnx` and run one inference.
- Update the extras in `packages/desktop/src/main/python-bootstrap.ts` and pass `--no-dev`. Update `python/README.md`.

### Evidence

Paths are relative to `python/src/gosai_py/` unless noted.

- `runtime/accelerator.py:365-369` raises on `cuda` for MediaPipe, and the CPU retry at `drivers/pose.py:108-119` hits the same error. `python/README.md:21` documents `cuda` as the NVIDIA setting.
- `drivers/slr.py:139` requires a GPU for a tiny model.
- `runtime/accelerator.py:233-241` tries TensorRT first in auto mode, which either fails to load or silently spends minutes building an FP16 engine.
- `runtime/accelerator.py` is 411 lines:
  - `:44-75` is a dict-builder helper and `:352-363` parses the environment repeatedly.
  - `:84` keeps a legacy `GOSAI_ORT_DEVICE` alias.
  - `:323` `explicit_cpu_requested` is never called, and `:138,244` `cpu_allowed` only matters on an unknown OS.
  - `:271-276` is a dead TypeError fallback.

  `_select_device(torch)` is copied at `drivers/speech_to_text.py:97` and `drivers/speech_activity_detection.py:108`.

- Model downloads:
  - `drivers/pose.py:26-56` and `drivers/hand_pose.py:45-80` download `.task` files with duplicated helpers, different timeouts, no checksum and a `latest` URL.
  - `python/pyproject.toml:47-50` bundles the ONNX models.
  - `drivers/ball.py:369` only checks `exists()`, so an LFS pointer file gets through.
- `drivers/ball.py:67` hardcodes `MODEL_INPUT_SIZE = (736, 1280)`, duplicating `training/models/ball/configs/train.yaml:11`. `_letterbox` exists in both `drivers/ball.py:92` and `training/src/gosai_train/pipelines/yolo_detect/export.py:19-32`.
- Unused dependencies:
  - pillow and soundfile at `python/pyproject.toml:15,19`.
  - msgpack, used only by dead helpers in `serialization.py`.
  - torchaudio and scipy in the `speech` extra. `uv.lock` pairs torchaudio 2.11.0 with torch 2.13.0.
- torch is only used in two places. `drivers/speech_activity_detection.py:85-88` loads Silero with `torch.hub.load(trust_repo=True)`, downloading from GitHub at runtime. `drivers/speech_to_text.py:69-70` checks `torch.cuda`. `uv.lock` ends up with both `nvidia-cudnn-cu12` and `nvidia-cudnn-cu13`.
- `python/pyproject.toml:17` makes `onnxruntime-gpu[cuda,cudnn]` a hard dependency on Linux and Windows, which means multi-GB NVIDIA wheels everywhere. Its floor is `>=1.26` while darwin's is `>=1.27`.
- MediaPipe already uses the Tasks API, so no `mp.solutions` calls need migrating. Keep `opencv-contrib-python`, since mediapipe depends on it.
- `packages/desktop/src/main/python-bootstrap.ts:82` hardcodes Python 3.12 and doesn't pass `--no-dev`.
- Available on 2026-09-17: mediapipe 1.0.1, onnxruntime and onnxruntime-gpu 1.30.0, numpy 2.5.3, pyright 1.1.414, faster-whisper 1.2.1.

---

## PR 6. Training pipeline cleanup

Depends on: PR 1. Wave 2.

### Scope

- Keep the data, and the per-model layout under `training/models/<name>/`. Future driver models will need it.
- Trim the registry.
  - Remove the alias table in `registry.py` and the dead `map_all_classes` option.
  - `default_model()` returns the only model when there is exactly one; otherwise `--model` is required.
  - Replace the ~20 path properties in `context.py` with fields set once.
- Merge duplicates:
  - one `resolve_weights(ctx, arg)`
  - one imgsz parser
  - one weights-date print
  - one `iter_video_frames(path, step)`
  - one YOLO label parser
- Defaults live only in argparse. Read `args.conf` directly, so `--conf 0` stays 0.
- Use `resolve_device(cfg)` everywhere.
- Fix the temp file leak, clear the glare pool at the start of `negatives`, and pass unknown `train.yaml` keys through to Ultralytics, or reject them loudly.
- Let errors surface: remove the broad excepts listed below. `export` validates the exported ONNX, not the `.pt` file.
- Remove the fallback in `install.py` that picks any `best.onnx`. `install` writes `ball.onnx.json` next to the model, with sha256, input size, run name, git SHA, dataset versions and eval metrics.
- Pin dataset versions in `datasets.yaml`, and verify the sha256 of the `yolo26s.pt` download.
- Replace the Makefile and `make.bat` with `uv run gosai-train <cmd>`, plus a `clean` subcommand that also removes `data/custom/previews`. Update the README.
- Move `requests` and `gdown` to an extra, and replace the hand-written `.env` parser with `uv run --env-file`.
- Delete stray and generated files: `data/custom/labels/labels.txt`, and the tracked `classes.lock.yaml` (write it under `runs/` instead).
- Remove 27 `# type: ignore[import-not-found]`, 5 `# pragma: no cover`, banner comments and comments that restate code. Move the "Runtime backends" README section to `python/src/gosai_py/drivers/README.md`.
- A small pytest file for `classify_name`, `to_bbox_line`, `_expand_boxes` and `assign_split`.

### Evidence

Paths are relative to `training/src/gosai_train/`, with `pipelines/yolo_detect/` shortened to `yd/`.

- Defaults are defined twice: `cli.py:33,37,47,52,53` and `yd/frames.py:17`, `yd/autolabel.py:25`, `yd/evaluate.py:78`, `yd/mine.py:69-70`. `getattr(args, "conf", 0.25) or 0.25` turns 0 into 0.25.
- Duplicated code:
  - The "latest best.pt" block: `yd/evaluate.py:73-77`, `yd/export.py:93-97`, `yd/mine.py:61-68`, `yd/autolabel.py:33-35`.
  - imgsz parsing: `yd/evaluate.py:81-82` and `yd/export.py:84-91`. The weights-date print: `yd/evaluate.py:85-90` and `yd/export.py:99-107`.
  - The frame loop: `yd/frames.py:19-44` and `yd/mine.py:32-38,101-114`.
  - Label parsing: `yd/sources.py:175-192` and `:307-313`.
- Work done twice: the golden-set scan at `yd/evaluate.py:51-53` and `:105-108`; stats at `yd/prepare.py:267-270` and `_print_stats`.
- Broad error handling:
  - `devices.py:8-17` wraps a hard torch import.
  - `yd/negatives.py:85-88` swallows every error.
  - `yd/export.py:40-48` falls back to `bus.jpg` inside a try.
  - `yd/download.py:17-20` has a broad except.
- `yd/export.py:135-149` validates `.pt` weights inside a broad try.
- `yd/autolabel.py:53` and `yd/mine.py:82` call `select_device()` and ignore `train.yaml` `device`.
- `yd/train.py:16`: `_AUG_KEYS` silently drops other settings.
- `util.py:72-76` creates temp files with `delete=False` and never removes them. `util.py:34-47` is a hand-written `.env` parser.
- `yd/negatives.py:118-153` never clears the glare pool.
- Small leftovers:
  - `yd/sources.py:255` reads `trust_negatives` inside a loop.
  - `cli.py:107-108` repeats the guard already in `__main__.py`.
  - `__init__.py:1-5` says "ball-detector" and hardcodes a version.
- Banner comments at `context.py:33,60,86,112` and `yd/prepare.py:40,84,154,207`. Comments that restate code at `yd/prepare.py:239,245`. `training/models/ball/model.yaml:1-8` repeats the README.
- The registry:
  - `registry.py:12` has four aliases for one pipeline type.
  - `context.py:158-164` hardcodes `"ball"`.
  - `training/models/ball/model.yaml:14` sets `map_all_classes: false`, which makes `yd/sources.py:228,239-240` a dead branch.
  - `context.py:25-140` is about 20 one-line path properties.
- Install: `yd/install.py:21` falls back to any `best.onnx`, and `yd/install.py:26-35` records no provenance.
- Unpinned inputs: `training/models/ball/configs/datasets.yaml:23,28,35,43` use `version: latest`, and `train.yaml:3` downloads `yolo26s.pt` unpinned.
- `yd/prepare.py:227` writes `classes.lock.yaml` and nothing reads it. It's tracked and gets rewritten on every run.
- The Makefile and `make.bat` are thin wrappers with different argument syntax. Both `clean` targets miss `data/custom/previews`, and `make.bat` is stored with LF line endings.
- `training/pyproject.toml:26-27` makes `requests` and `gdown` hard dependencies, but only the external negative sources use them, and those are off by default.
- `training/README.md:217-246` documents the Python driver's providers.

---

## PR 7. Typed protocol, one client, server core

Depends on: PRs 3 and 4. Wave 3. This is the largest PR. If it grows unwieldy, split the app data move into its own PR.

### Scope

- Typed protocol in `@gosai/shared`.
  - One map of commands to request and response types, and one map of events to payload types, all with zod schemas.
  - The gateway validates every message and checks the envelope's `v`.
  - `registerHandler` is typed from the map.
  - Each command declares the capability it needs, which replaces PR 3's hardcoded list. An app can request extra capabilities in its manifest, and the dashboard shows them at install (PR 13).
- One `ServerClient` in shared that works in browsers and in Electron main. It replaces `packages/sdk/src/connection.ts`, the renderer's `server-client.ts` and kiosk's `EventSocket`, and fixes:
  - a late close event from an old socket wiping out the new one
  - driver subscriptions lost on reconnect
  - pending requests left hanging after a close
  - duplicate subscriptions not being reference-counted on the client
  - listener errors being dropped silently

  The renderer panels lose their casts.

- Gateway.
  - Look up subscribers before serializing an event.
  - Don't deliver `app:broadcast` events back to the sender.
- Keep every server event, even ones the dashboard doesn't use. Type them all, and expose the ones apps care about through the SDK: experience state, app config changes.
- Manifest and config.
  - Parse `gosai.app.json`, the global config and app settings with zod.
  - Publish a JSON Schema so manifests can set `$schema`.
  - Validate the experience slugs `required` references, check for cycles, and roll back partial startup.
  - Every field must have code that reads it:
    - `startup` auto-starts experiences, together with `GlobalConfig.autoStartApps`.
    - The dashboard shows `icon` and `author`.
    - `python` stays for PR 16.
    - `builtin` comes from the install location only.
  - Allow `null` in per-app device patches to clear an override.
  - A command returns an app's settings merged with the manifest defaults. PR 8 exposes it as `rt.settings`.
- Split `server.ts` into HTTP routes, command handlers and wiring.
  - `index.ts` passes paths in, which fixes path lookup in the compiled binary.
  - One `resolvePythonDir` and one version constant.
  - Serve files with `Bun.file`.
- Delete the HTTP routes that duplicate WebSocket commands, and keep `/healthz`.
- Move per-app data (storage, `_config/settings.json`) out of the git checkout into `paths.data/<slug>`, with a one-time migration. Uninstall should no longer delete it silently.
- Logger: write asynchronously and delete old rotated files. Store raw log entries and format them only in the dashboard.
- Keep the installer's Python requirements path for PR 16.
- Tests for gateway validation, capabilities, the client's reconnect and refcounting, manifest parsing, and the storage and config stores.

### Evidence

Paths are relative to `packages/server/src/` unless noted.

- The protocol is untyped:
  - `ipc/gateway.ts:63` registers handlers by plain string.
  - `server.ts:325-464` has about 15 ad-hoc `as { payload }` casts.
  - `ipc/gateway.ts:101` never checks `v`.
  - `config/config.ts:45-57` saves any key.
- The client is duplicated. `packages/sdk/src/connection.ts` (251 lines) says it mirrors `packages/desktop/src/renderer/src/lib/server-client.ts` (281 lines), and `packages/desktop/src/main/kiosk-calibration.ts:140-181` has a third copy.
- Client bugs:
  - `server-client.ts:153-158` and `connection.ts:135-139` clear `this.ws` whichever socket closed. With StrictMode (`renderer/src/lib/server-context.tsx:24-31`) this opens duplicate sockets and delivers events twice.
  - `server.ts:95-98` drops everything a client subscribed to on disconnect. `connection.ts:125-134` re-sends only bus subscriptions, and `packages/sdk/src/driver-client.ts:22-29` swallows the first failure.
  - `packages/sdk/src/driver-client.ts:45-47`: one `unsubscribe()` removes the server's only record.
  - `connection.ts:135-139` doesn't reject pending requests on close, and `connection.ts:217-239` drops listener errors. `driver-client.ts:25-28` promises a retry that never happens.
- Renderer casts:
  - `AppsPanel.tsx:92,100,576,612` and `SettingsPanel.tsx:45,59,109`.
  - Inline copies of shared types: `ResponsePayload` at `server-client.ts:276-281`, `SystemStats` at `Dashboard.tsx:85-90`.
- `ipc/gateway.ts:175-191` stringifies every bus event, including 30 fps base64 JPEG frames, before checking who's subscribed. `ipc/gateway.ts:175` echoes app events back to the sender, so the calibration projector applies its own transform twice (`apps/calibration/src/projector.ts:187-193,236-243`, `control.ts:294-300,309-314`).
- Manifest validation, `apps/manifest.ts`, 349 lines:
  - `:265` casts `exclusive`, and `:266-274` silently filter `drivers`, `allowed` and `required`.
  - `:233-238` coerce select options, and `:201` ignores a bad `storageKey`.
  - `:52-54` drop invalid installed apps without logging.
  - `config/config.ts:71` and `config/app-settings.ts:75` read files with bare casts.
- `apps/manager.ts:116-123` recurses on `required` with no cycle check, `:142-145` doesn't roll back, and crashed records stay in `running`.
- Manifest fields nothing reads:
  - `python.*` at `apps/manifest.ts:115-125,280`.
  - `startup` is never read.
  - `builtin` is overridden at `apps/manager.ts:236`.
  - `icon` and `author` have no consumers.
  - `GlobalConfig.serverPort` and `autoStartApps` are only displayed.
  - `index.ts:30-37` writes `server-info.json`, which nothing reads.
- `server.ts`, 493 lines:
  - `:125-163` duplicate the WebSocket experience handlers at `:341-359`.
  - `index.ts:50,58` and `server.ts:228,488` locate paths with `import.meta.dir`.
  - `resolvePythonDir` exists at `index.ts:48` and `server.ts:484`, and `'0.1.0'` at `server.ts:18` and `ipc/gateway.ts:75`.
  - `server.ts:467-482` is a hand-written `guessMime`.
  - `/v1/logs`, `/v1/config` and `/v1/drivers` are only used by the e2e scripts.
- Per-app data lives in the checkout (`apps/manager.ts:248-252`, `apps/storage.ts:57`, `config/app-settings.ts:67`), uninstall deletes it (`apps/installer.ts:89`), and `paths.ts:26` `paths.data` is unused.
- Logger: `logger/logger.ts:109-114` appends synchronously and never deletes rotated files. `packages/shared/src/enrich-log.ts:27-28` folds data into the message and keeps it too, and its key lists at `:15-20` differ from `:37`.
- Slop:
  - Unused variables silenced with `void`: `index.ts:42`, `apps/installer.ts:103`, `apps/manager.ts:260`.
  - Swallowed errors: `ipc/bus.ts:59-63`, `apps/storage.ts:21-25` (a corrupt value returns 404), `apps/manager.ts:228-231`.
  - Literal event names at `config/config.ts:56` and `'system'` at `server.ts:411`, instead of the constants.
  - One-line barrels at `logger/index.ts` and `monitor/index.ts`.
  - `ipc/gateway.ts:87-97` checks whether a handler returned a promise, and `:19` `CommandContext.bus` is never read.
  - `apps/manager.ts:326-361` wraps a DTO in a class, `:206-211,275-280` split `'::'` string keys back apart, and `:22` imports a value used only as a type.
  - `monitor/monitor.ts:1-4` says "process-level" but samples OS-wide stats (`:64-69`).
- Unused internals:
  - `monitor/monitor.ts:29-41,58-60,90-100` (`recentSamples`).
  - `setMinLevel` and `EventBus.clear`.
  - `apps/manager.ts:377` (`ExperienceLifecycleState`) and `RunningExperience.pid`.
  - In shared, `packages/shared/src/protocol.ts:39-63` (`ServerMessage`), `BridgeManifest` (duplicated at `drivers/manager.ts:34`), `DeviceListResult`, `ServerEventName` and `ClientCommandName`.
  - `ClientCommands` is stale: it lacks `app:broadcast` and `app:log`.
- Events no bundled client subscribes to, which stay and get types: `app:installed`, `app:uninstalled`, `experience:state-changed`, `driver:state-changed`, `server:performance`, `app:config-changed`.
- `packages/shared/src/types.ts:263-268`: device patches can't hold `null`. `packages/shared/src/types.ts:192` `DisplayInfo` isn't used by desktop, which has five copies of its own.
- HTTP calls that should go through the client: `renderer/src/dashboard/panels/AppsPanel.tsx:262`, `components/AppSettingsModal.tsx:37,71`, `main/windows.ts:460`, `main/kiosk.ts:358`.
- Settings drift in second-self, which `rt.settings` fixes: `apps/second-self/src/shared/config.ts:117-122,149-202`.

---

## PR 8. SDK runtime and app hosting

Depends on: PR 3. Wave 3. Merge PR 9 first if both are ready, since both edit `windows.ts`.

### Scope

- Experience API.
  - `defineExperience({ init, start, render, stop })`. The slug, name and description come from the manifest.
  - `init` receives the runtime context, so apps don't need placeholder objects.
- Runtime.
  - On stop, it removes every `ctx.drivers.on` and `ctx.events.on` listener, and exposes `ctx.signal` for DOM listeners.
  - Caps `deltaMs` after a stall.
  - Logs a render error once, then stops the experience after repeated failures, instead of sending 60 `app:log` requests a second.
  - `runExperience` closes its client and clears its timer on failure.
- General-purpose building blocks, not shaped around the demos:
  - `LayerManager`, based on `apps/second-self/src/shared/menu-controller.ts`, with activation tokens so a stop during start cancels cleanly, a `persistent` flag instead of the hardcoded `'menu'`, and suspend and resume.
  - `createFullscreenCanvas()` returning `{ canvas, ctx, fit() }` with contain, cover and stretch modes, and a `fitCanvas` that doesn't reset the backing store every call.
  - `applyQuadWarp(el, quad)` and `clearQuadWarp(el)`.
  - `rt.assets.url(path)`, `rt.app.params` and `rt.settings`, the last using PR 7's command.
  - `drivers.execute<T>()`, and `storage.get` returning `T` when a fallback is given.
  - An audio context the runtime owns, resumed on start.
  - A cheap `rt.ping()`.
- Move `packages/shared/src/homography.ts` into the SDK and keep all its functions, with tests. A point at infinity returns `null` instead of `(0, 0)`, and callers are updated.
- Two entries.
  - The app entry holds everything an app author needs from the platform, not only what the demos use.
  - The host entry holds `runExperience` and the server-only types: `GlobalConfig`, `LogEntry`, `DisplayInfo`, `ServerEvents`, `ClientCommands`.
  - The import map maps both `@gosai/sdk` and the `@gosai/sdk/` prefix.
- Keep `rt.router`. PR 13 makes `switchTo` open windows.
- App host.
  - Replace the React and Tailwind app host with a small TypeScript loader.
  - Serve each app from its own origin through a custom protocol or a server-served host page, with a static import map and no `'unsafe-inline'` in the CSP.
  - Load the single app entry directly instead of fetching every installed app.
  - Stop the runtime on `pagehide`.
  - Electron main asks the window to stop, with a timeout, before calling `destroy()`.
- Update each app's entry point to the new `defineExperience` shape, and change nothing else in the apps. PRs 11, 14 and 15 do the rest.
- Rewrite `templates/basic` and `packages/sdk/README.md` so they document only what works. Fix the root README example.

### Evidence

Paths are relative to `packages/sdk/src/` unless noted.

- `runtime.ts` only reads `definition.lifecycle`, so identity fields go unused and have already drifted (`templates/basic/src/main.ts:20` vs `templates/basic/gosai.app.json:13`). `experience.ts:14-19` flattens the object, then nests it again.
- Placeholder objects exist because `init` gets no context: `apps/interactive-pool/src/main.ts:125-128`, `apps/second-self/src/main.ts:117-118,150` (`undefined as unknown as LayerManager`), and `runtime.ts:74` (`undefined as unknown as TState`).
- Manual cleanup: `apps/calibration/src/control.ts:79-87` has 11 fields for teardown, and `projector.ts:64-67` does the same. The template never removes its subscription (`templates/basic/src/main.ts:40`) or its `beforeunload` listener (`:49`).
- `deltaMs` is never capped: `apps/interactive-pool/src/main.ts:218` and `apps/second-self/src/main.ts:201`. After a stall, `apps/second-self/src/layers/menu.ts:182` completes instantly.
- Render errors:
  - `runtime.ts:92-96` logs on every frame.
  - `apps/interactive-pool/src/main.ts:430-439` and `apps/second-self/src/shared/menu-controller.ts:164-170` catch again.
  - `runtime.ts:137-140,75-78` leak the client on failure and never clear the timeout.
- `stop` never runs in production. It's only called from React effect cleanup (`packages/desktop/src/renderer/src/app-host/AppHost.tsx:86-89`), and windows end with `BrowserWindow.destroy()` (`packages/desktop/src/main/windows.ts:440`).
- Two layer runtimes:
  - `apps/second-self/src/shared/menu-controller.ts:72-260`. It has an activation race at `:197-205`, stops the menu twice at `:175-194`, and hardcodes `'menu'` at `:70,141`.
  - `apps/interactive-pool/src/main.ts:62-104,183-212,394-424`.
  - `Layer` and `FrameContext` are copied between `apps/interactive-pool/src/shared/types.ts:39-68` and `apps/second-self/src/shared/types.ts:67-94`.
- Canvas code:
  - The SDK's `renderer.ts:14-31` resets the backing store in `fitCanvas` (`:27-31`) and has no resize handling. It appends to `document.body` (`:40`), while `AppHost.tsx:112` creates an unused `#gosai-experience-root`.
  - Copies: `apps/interactive-pool/src/shared/canvas-utils.ts` (279 lines), `apps/second-self/src/shared/canvas.ts` (206 lines), and `setBodyFullscreen` also in `apps/calibration/src/shared.ts:186`.
- The warp code is duplicated between `apps/calibration/src/projector.ts:349-366,384-396` and `apps/interactive-pool/src/shared/canvas-utils.ts:101-135`. `calibration.ts:139` types `surfaceQuadDisplay` as `Point2D[]` instead of a `Quad`.
- The asset URL resolver is written twice, each in a try/catch that can't fail: `apps/interactive-pool/src/shared/audio.ts:33-39` and `apps/second-self/src/shared/assets.ts:9-16`.
- Launch params:
  - `apps/calibration/src/calibrate.ts:124-127` and `shared.ts:197-199` read `window.location.search`.
  - `packages/desktop/src/main/windows.ts:239,338` add them to the URL.
- Missing typing:
  - `apps/calibration/src/control.ts:705-724` writes a 20-line inline result type because `execute` isn't generic.
  - `types.ts:86` returns `T | undefined` even with a fallback, so `templates/basic/src/main.ts:46-47` needs `?? 0`.
- Audio: `apps/second-self/src/main.ts:171-173` and `shared/synth.ts:34-64` only create the audio context from a `pointerdown` listener, and a gesture-driven kiosk may never get a click.
- `apps/second-self/src/layers/show-ping.ts:27` "pings" by downloading the whole mirror payload four times a second.
- `index.ts` exports 71 names:
  - `:11` exports `runExperience`, `:17-18` `ServerClient`, and `:62-79` server-side types and constants.
  - `types.ts:5-29` re-exports settings, stats and performance types.
  - `storage.ts:21,63-66` have an unused `server` parameter and `getServer`.
- `packages/desktop/src/renderer/app-host.html:22` maps only the bare `@gosai/sdk`.
- `experience-router.ts:19-45`: `switchTo` and `stop` only change server state, and nothing opens a window.
- `packages/shared/src/homography.ts`:
  - No package imports it except the SDK.
  - `:43` returns `(0, 0)` for a point at infinity, and `apps/calibration/src/projector.ts:341` accepts it.
  - `:51,62,173` are unused today. Keep them, since they're useful to AR apps, and add tests.
- App host:
  - `packages/desktop/src/main/windows.ts:245-247` loads `app-host.html` from `file://`, so every app and the dashboard share one origin and its storage.
  - `app-host.html:8,17-28` inline the import map, which forces `'unsafe-inline'` in the CSP, and `connect-src` allows any `ws:` or `http:` URL.
  - `AppHost.tsx:39-55` fetches every installed app to find one entry. `AppHost.tsx:36,59` use `@gosai/sdk` without declaring it.
- Stale comments: `renderer.ts:1-5` mentions "Phase 4/5/6". `logger.ts:41-43` says the server may not implement `app:log`, but `packages/server/src/server.ts:451` does. `types.ts:106` says "synchronous-only" on a signature that can return a Promise.
- Doc drift:
  - `packages/sdk/README.md:237-261` documents Python integration that doesn't exist, and `:263-273` documents error handling and versioning that don't exist.
  - `packages/sdk/README.md:173-185` lists the broken router and omits `rt.events`, `:156` says `init` is synchronous, and `:16-25` describe a layout the template doesn't use.
  - Root `README.md:129,137` use `fitCanvasToWindow`, which doesn't exist, and leave out `start`.
  - `templates/basic/README.md:35` says to refresh the dashboard, but apps are only discovered when the server starts. `:25` hardcodes port 7777, and `:43-73` repeat the manifest reference with drift.

---

## PR 9. Desktop boot, kiosk and packaging

Depends on: PRs 3 and 5. Wave 3.

### Scope

- Targets.
  - Linux x64 and macOS arm64 are required. Windows x64 is best effort.
  - Drop the Intel Mac arch from electron-builder.
  - Compile the server with `bun build --compile --target` for `bun-linux-x64`, `bun-darwin-arm64` and `bun-windows-x64`.
  - Fetch a pinned uv for each target and verify its published sha256. Cache per version.
- CI release workflow that builds artifacts on Linux x64 and macOS arm64 runners. The Windows job may fail without blocking.
- One `bootRuntime()` used by both desktop and kiosk: splash, Python bootstrap, server start, wait for ready. Failures show to the user in both modes, and the Python directory fallback works the same in both.
- `app.requestSingleInstanceLock()`. Desktop starts its server on port 0 and hands the actual port to windows.
- The server exits when its stdin closes and stops the bridge first, so an Electron crash doesn't orphan the server on port 7777. This works on Windows too, unlike process groups.
- In kiosk mode, exit non-zero when the server exits or a renderer crashes, so systemd restarts it.
- Python bootstrap.
  - Compute the runtime hash at package time.
  - Stage in a temp directory and rename, with a lock file and a `.complete` marker.
  - Delete stale `~/.gosai-runtime/python-*` runtimes.
  - Handle the Windows venv layout.
  - Take the Python version from `pyproject`.
- Packaging.
  - uv goes in the regular bundle, not only the kiosk bundle.
  - Restrict `files` to `out/{main,preload,renderer}/**`.
  - Replace `externalizeDepsPlugin` with `build.externalizeDeps`.
  - Use `import.meta.dirname`.
  - Upgrade to Electron 44.
- Parse arguments with `node:util` `parseArgs` in `kiosk.ts` and `scripts/package-kiosk.ts`, with one `parseExtras`.
- Delete `packages/cli`. Document `GOSAI --kiosk <dir>` instead.
- Move `@gosai/shared` to devDependencies.
- Delete the dead options and handlers listed below.
- Fix `docs/deployment.md` and `docs/quick-start.md`, and add the missing environment variables.

### Evidence

Paths are relative to `packages/desktop/` unless noted.

- `electron-builder.config.cjs:69-73` builds mac arm64 and x64, while root `package.json:22` and `scripts/package-kiosk.ts:124-127` compile the server for the host arch only.
- `electron-builder.config.cjs:43-66` has no uv resource, and only `electron-builder.kiosk.config.cjs:64-72` adds it. `src/main/index.ts:76-78` only logs when Python is missing.
- `scripts/fetch-uv.ts:39-48` downloads uv's `latest` release without a checksum, and `:41-45` skip the download when the file exists.
- Boot is duplicated: `src/main/index.ts:66-93` and `src/main/kiosk.ts:247-287` fail differently, and only kiosk has the Python fallback (`kiosk.ts:197-206`).
- `src/main/server-runner.ts:61-65` overwrites `GOSAI_PORT` and `GOSAI_HOST` and pins 7777. `src/main/index.ts:83-89` only logs a port conflict, and nothing takes a single-instance lock.
- `src/main/server-runner.ts:73-76` spawns the server with no link to the parent. `:143-149` SIGKILL only the server after 5 s, which orphans the bridge.
- `src/main/server-runner.ts:115-121` only log a server exit, and `src/main/kiosk.ts:296-305` don't handle renderer crashes.
- `src/main/python-bootstrap.ts`:
  - `:98-121` hash the whole 44 MB Python tree on every packaged launch, although `:12-16` and `docs/deployment.md:95` say only `pyproject` and `uv.lock` are hashed.
  - `:71-84` aren't atomic and take no lock, and `:63,94-96` count a run as complete when the bridge script exists.
  - `:82` hardcodes 3.12.
- `electron.vite.config.ts:2,8,20` use the deprecated `externalizeDepsPlugin`. `:14-16` has a redundant `external: ['electron']`, and `:36-38` an unused `@renderer` alias.
- `src/main/index.ts:11-12` computes `__dirname` by hand, while `src/main/server-runner.ts:177` relies on electron-vite's shim.
- Three argument parsers: `packages/cli/src/index.ts:53-96`, `scripts/package-kiosk.ts:59-102` and `src/main/kiosk.ts:74-99,173-176`, and `parseExtras` is written twice.
- `packages/cli/src/index.ts:144-149` only renames flags, and re-reads the manifest that `src/main/kiosk.ts:165-171` already reads. Its `bin` is a `.ts` file (`packages/cli/package.json:8-12`).
- Dead code and settings:
  - `src/main/server-runner.ts:45-47` (`shouldAutostart`) and `:19-20` (`host`, `serverBinPath` options), `src/main/windows.ts:7-8` (`serverHost`, `serverPort`).
  - `src/main/windows.ts:165` (`simpleFullscreen: false`) and `electron-builder.config.cjs:75-78` (explicit `undefined` keys).
  - Stale comments at `src/main/server-runner.ts:172,181-182`.
- `package.json:19-21` lists `@gosai/shared` as a runtime dependency.
- `docs/quick-start.md`:
  - `:215` uses the wrong clone URL, `github.com/gosai/gosai`; the real one is `IONIS-Institute-of-Technology/gosai`.
  - `:251` says "five tabs", lists six, and includes a Terminal tab that doesn't exist.
  - `:257,262` name UI labels that don't exist.
  - `:293-303` omit `GOSAI_HOME`, `GOSAI_SERVER_BIN`, `GOSAI_SDK_RUNTIME`, `GOSAI_OZONE_PLATFORM`, `BUN_BIN` and `GOSAI_AUTOSTART_SERVER=0`.
- `docs/deployment.md`:
  - `:203`: `GOSAI_PORT` does nothing in the packaged app.
  - `:205`: logs are in `<GOSAI_HOME>/logs`.
  - `:52-55,176-178`: Python setup needs uv on PATH today.
  - `:195-197`: "own data directory" only holds when `GOSAI_HOME` is unset.
  - `:123-125`: a blank line splits the environment table.
  - `:42` and `:110` disagree on the AppImage name.
- Electron 43.1.1 is current in the repo, and 44.4.1 is available. electron-vite 5 pins Vite 7, so stay on Vite 7 and plugin-react 5.

---

## PR 10. Python drivers: fixes, tests and schemas

Depends on: PRs 4 and 5. Wave 3.

### Scope

- Every driver declares its config, events and actions as msgspec Structs, and the bridge's describe reply includes them as JSON Schema. PR 12 generates the SDK's driver types from this, and PR 13 shows it in the dashboard.
- Every driver gets a test that runs without hardware, including drivers no bundled app uses: `speech_to_text`, `speech_activity_detection`, `speaker`, `hand_sign`, `interpolate`, `frequency_analysis`, `calibration`, `hand_pose`.
- Fixes in drivers the demos don't use:
  - `interpolate` jobs orphan the threads of the jobs they replace. Fix it with real cancellation.
  - `speaker` plays every app's audio from one shared queue. Use a queue per instance.
  - The microphone callback only enqueues. FFT, voice detection and emitting run on a worker.
  - Voice detection receives 512-sample blocks at 16 kHz.
  - Frequency analysis applies its `max_frequency` mask before `argmax`, removes DC, and applies a Hann window.
  - Microphone and speaker raise when their stream fails to open.
- Other fixes:
  - The camera stops its worker and releases the old handle before negotiating a new mode. `list_formats` returns cached modes for a device in use. One `_reconfigure()` path.
  - Calibration becomes a pure `compute_homographies()` with typed parameters, and the ArUco detector is built once.
  - Mirror geometry moves to vectorized numpy in `geometry/mirror.py`, using `lstsq`, with a lock around `_raw_history`. The existing tests carry over.
  - hand_pose tracks the live frame size instead of the first one it saw.
- Import hard dependencies at the top of each file, then delete the `except ImportError` branches and the `type: ignore` comments.
- One shared helper each for: device listing, homography parsing, frame and surface size setters, capture latency, flip and crop, and smoothing.
- Delete internal dead code: unused parameters and fields, no-op methods, stale "Phase" docstrings, the `register_drivers()` mention, the dead helpers in `serialization.py`, and `ball_models/.gitkeep`.
- Keep public driver actions, such as camera `snapshot` and calibration `get_latest_frame`, `reproject_point` and `reproject_points`, and test them. Remove only private helpers nothing calls, such as `_detect_encoded` if nothing references it.
- Remove the RealSense stub: the `depth` event declaration, its docstring and the `realsense` extra. There's no pyrealsense2 code. A real depth camera can come later as its own driver.
- Payloads.
  - Ball events send `diameter` instead of `r`, which already holds a diameter. Update interactive-pool's reads.
  - Add an opt-out for `face_mesh` in pose events, as additive config.
  - Every other payload change must be additive.

### Evidence

Paths are relative to `python/src/gosai_py/` unless noted.

- `drivers/camera.py:275-306` opens a second `VideoCapture` on the device and negotiates before releasing the old one. Linux V4L2 refuses this with EBUSY. `bridge.py:315-321` probes formats while the device streams.
- `drivers/camera.py:467-523` has four identical save, reopen and restore blocks, and `:460-461` is a `cv2=None` path that silently skips settings. `list_formats` is handled in both `bridge.py:315-321` and `drivers/camera.py:451-455`.
- `drivers/camera.py:8,66` declare a `depth` event and RealSense support with no code behind them. `python/pyproject.toml:23-25` define the `realsense` extra.
- `drivers/pose_to_mirror.py`:
  - `:569` appends from the pose worker while `:656` iterates on the bridge thread.
  - `:222-223` recompute cos and sin for every point, including the 478-point face mesh, every frame.
  - `:172-183` hand-roll least squares.
  - `:199` has an unused `eyes_depth` parameter.
  - `:378-389` duplicate `:592-601`.
  - `:438-455` is one of three smoothers.
- `drivers/calibration.py`:
  - `:160-162` rebuild the ArUco detector every frame.
  - `:269-453` tie the homography math to driver state.
  - `:455-503` duplicate `_reproject_point` and `_reproject_points`.
- `drivers/microphone.py:130-132` and `drivers/speaker.py:167-169` log and continue when the stream fails, so the driver reports `running`.
- `drivers/microphone.py:107-118` run emit, FFT, VAD and JSON encoding on the audio callback. `:39` uses 1024-sample blocks, while `drivers/speech_activity_detection.py:53-72` expects 512 at 16 kHz with Silero v5+.
- `drivers/frequency_analysis.py:86-91` run `argmax` over the whole spectrum.
- `drivers/interpolate.py:79-84`: new jobs orphan old threads, and the "generation counter" in the comment doesn't exist.
- `drivers/speaker.py`: `:35-36` hold one shared queue, `:147-154` pad "defensively", and `:68-72` clear the queue by looping until an exception.
- Lazy imports of hard dependencies: 40 in-function numpy and cv2 imports, 34 `except ImportError` branches and 53 `type: ignore[import-not-found]`. Examples: `drivers/hand_pose.py:190`, `drivers/calibration.py:139-145`, `drivers/speaker.py:91`.
- Duplicate helpers:
  - Device listing: `bridge.py:279-306`, `drivers/microphone.py:78-98`, `drivers/speaker.py:270-290`.
  - Homography parsing, float32 in one and float64 in the other: `drivers/ball.py:501-509`, `drivers/hand_pose.py:183-197`.
  - Setters with identical bodies: `drivers/hand_pose.py:199-224`.
  - Capture latency: `drivers/ball.py:433-436`, `drivers/hand_pose.py:277-280`.
  - Flip and crop: `drivers/pose.py:168-179`, `drivers/hand_pose.py:258-267`.
  - Smoothing: `drivers/ball.py:240-241`, `drivers/pose_to_mirror.py:438-455`, `drivers/interpolate.py`.
- `drivers/hand_pose.py:250-251` keep the first frame size forever, and `_last_inference_ms` is written but never read.
- Dead code:
  - `driver.py:83,151`: `_paused` is never read.
  - `drivers/hand_sign.py:43-44`: a no-op `__init__`.
  - `drivers/slr.py:129`: an unused numpy import.
  - `bridge.py:9` mentions a `register_drivers()` that doesn't exist.
  - `drivers/__init__.py:3` and `drivers/heartbeat.py:4` still have "Phase" docstrings.
  - `serialization.py`: everything except `frame_to_jpeg_base64` is unused.
- `drivers/ball.py:472` sends `r * 2` as `r`. interactive-pool reads it at `src/main.ts:371`, `src/layers/balls.ts:21,39` and `src/layers/rabbits-game.ts:23,103`.
- Payload shapes are only described in docstrings, and apps retype them by hand in `apps/second-self/src/shared/types.ts` and `apps/interactive-pool/src/shared/types.ts`.
- `apps/second-self/src/main.ts:410,421` subscribe to both `pose.raw_data` and `pose_to_mirror.mirrored_data`, so two 478-point face meshes cross stdio every frame.
- Test gaps: nothing covers calibration, frequency_analysis, the hand_pose warp, speaker, microphone, speech_to_text or speech_activity_detection.

---

## PR 11. Calibration contract v2

Depends on: PRs 7, 8 and 9. Wave 4. PR 11 owns `packages/sdk/src/calibration.ts`.

### Scope

- Built-in calibration kinds are configured with manifest data, starting with `camera-projector-surface`: `"calibration": { "kind", "options", "required" }`. PR 7's manifest schema validates it. `required` means the app must be calibrated before it starts.
- An app that needs its own flow sets `calibration.experience` to one of its own experiences. This replaces `defineCalibration`, the separate `calibration.js` bundle and the dynamic import of another app's module, while keeping custom flows possible.
- One versioned `calibration_profile` object per app replaces the nine separate keys.
  - It includes a reader for the old keys.
  - "Calibrated" is derived from the profile.
  - The SDK exposes typed load and save for any kind, and the loader returns `null` when nothing is saved.
- The calibration app saves the target app's profile through a server command gated by a capability, instead of a raw storage client for another app.
- One calibration orchestrator in Electron main behind IPC `calibration:run`. It replaces `renderer/src/lib/calibration-wizard.ts` and `main/kiosk-calibration.ts`. Wizard event names and status keys become constants in shared.
- Rename the generic `'pool-corners'` step to `surface-corners`.
- Fix the wizard:
  - After a compute failure, go back to the corners step.
  - Back from preview goes to corners.
  - Reject points at infinity, using PR 8's `null`.
  - When loading fails, emit `finished` with `{ ok: false, error }`, so the desktop doesn't wait forever.
- The control window owns pan and zoom. Delete the projector's input handlers, and share one `imageRect()`.
- Use the SDK types and warp helpers, and delete the calibration app's copies.
- interactive-pool: change only its calibration loading and manifest. Delete `src/calibration.ts` and the wrappers in `src/shared/calibration.ts` that the SDK now covers.

### Evidence

Paths are relative to `apps/calibration/src/` unless noted.

- `apps/interactive-pool/src/calibration.ts` only returns an options object. The custom `init`, `start` and `stop` path (`calibrate.ts:103-120`, `packages/sdk/src/calibration.ts:70-74`) has no users but costs a bundle entry, a dynamic import (`calibrate.ts:145-148`) and a type guard.
- `calibrate.ts:141` rejects optional calibration, and `{"required": false}` in two manifests does nothing.
- Nine keys:
  - `control.ts:684,735-771` write up to nine keys sequentially, so a failure halfway leaves a mixed state.
  - `packages/sdk/src/calibration.ts:22` declares a markers layout key that's never written.
  - Status only checks whether the key exists (`packages/desktop/src/renderer/src/dashboard/panels/AppsPanel.tsx:267`, `packages/desktop/src/main/kiosk-calibration.ts:39`), and `calibrate.ts:74-80` hardcode `version: 1`.
- Scattered strings:
  - `wizard:step` and `wizard:finished` appear at `shared.ts:94-105`, `calibrate.ts:84`, `calibration-wizard.ts:69,87`, `kiosk-calibration.ts:85-86,120-127` and `AppsPanel.tsx:280`.
  - `calibration_status` is defined at `packages/sdk/src/calibration.ts:10`, `kiosk-calibration.ts:21` and `AppsPanel.tsx:27`.
- Two orchestrators: `packages/desktop/src/renderer/src/lib/calibration-wizard.ts:10-96` over WebSocket and IPC, and `packages/desktop/src/main/kiosk-calibration.ts:65-133` over HTTP plus a hand-written WebSocket. `kiosk-calibration.ts:109-132,146-163` hang when the socket drops.
- `packages/sdk/src/calibration.ts`:
  - `:45-57`: `CalibrationStepContext` repeats `rt`, and puts `rt.storage` next to `targetStorage`.
  - `:76,84`: `'pool-corners'`.
  - `:105-124,198-209`: `steps` and `defaultStepTitle` are never read, while `control.ts:91-110` has its own titles.
  - `:144-154` duplicates the const object's shape, and the `storageKeys` override option is never passed.
- `calibrate.ts:62` builds a storage client for the target app, and `packages/server/src/server.ts:181-200` storage has no access control.
- Wizard bugs:
  - `control.ts:666` returns early during compute, while Back is enabled at `:730,788`.
  - `control.ts:669` goes back to compute, which re-runs at `:360-362`.
  - `projector.ts:341` accepts `(0, 0)`.
  - `calibrate.ts:130-155` leave both windows open when loading fails.
- Duplicated types and logic:
  - `shared.ts:43` redeclares a mutable `Point2D`, and `:67,72-82` redeclare `SizeXY`, `SurfaceQuadDisplay` and `STORAGE_KEYS`.
  - Pan and zoom exist at `control.ts:290-302,606-631` and `projector.ts:195-233`.
  - Letterbox math exists at `control.ts:407-430` and `:486-504`, and corner labels at `control.ts:432` and `projector.ts:424`.
- Null checks and casts:
  - Contexts are rechecked for null at `control.ts:680,689,796` and `projector.ts:314`. The last is inside a `void` async call, so it becomes an unhandled rejection.
  - Casts at `projector.ts:93-96,148-151`.
  - Tuples rebuilt at `control.ts:682,755-760`, `projector.ts:361-366` and `apps/interactive-pool/src/main.ts:294`.
  - `control.ts:744,749,764` add `.catch(() => undefined)` to `remove()`, which already accepts a 404.
- Dead code in the calibration app:
  - `WIZARD_EVENTS.Corners` and `Aborted`, plus `CornersEvent`, are emitted at `control.ts:563,588,596,674` and nothing listens.
  - `ControlState.busy` and the `targetAppSlug` fields (`control.ts:66`, `projector.ts:56`).
  - `shared.ts:172` has a dead `cols <= 1` check, and `shared.ts:1-39` duplicates the README.
  - The "background" step no longer exists, but `shared.ts:88`, `projector.ts:9`, `calibration-wizard.ts:72` and `kiosk-calibration.ts:125` still reference it.
- interactive-pool:
  - `src/main.ts:146-150` say "in parallel" above an `await`, and the `.catch` never fires because the loader never rejects.
  - `src/main.ts:164-174` catch again, and `:178-180` is dead.
  - `src/shared/calibration.ts:18-22` is a pass-through, and `:45-53,77-91` repeat error handling.
- `apps/calibration/README.md:62-63` says the drivers run for the calibration app, but they run under the target app's binding.

---

## PR 12. Public SDK release

Depends on: PRs 7, 8 and 10. Wave 4.

### Scope

- Publish `@gosai/sdk` on npm.
  - Built ESM plus bundled `.d.ts`, with `@gosai/shared` types inlined, since shared stays private.
  - `exports` has separate entries for the app API and the host API.
  - It stays 0.x until PRs 14 and 15 have moved the demos, then goes to 1.0.
- A driver type generator.
  - It reads the schemas from PR 10, either through the bridge's describe reply or a dump script, and writes TypeScript types, so `rt.drivers.on('pose', 'raw_data', cb)` gets a typed payload and `execute` gets typed actions.
  - Commit the generated file. CI fails when it drifts from the Python schemas.
  - Ship the generator with the SDK so apps with their own drivers can use it (PR 16).
- Version contract.
  - Manifests declare an `sdk` semver range, which the server checks at install and at start.
  - The SDK compares the protocol version in `server:welcome` and fails loudly on a mismatch.
  - Serve `/sdk-runtime.js` with a version in its URL.
- The template moves out of the workspaces and depends on the published range. A CI job packs the SDK with `bun pm pack` and builds the template in isolation. Remove the installer's `workspace:*` special case.
- A release workflow: a version tag triggers `npm publish --provenance` and a changelog entry.
- A driver reference page generated from the schemas, linked from the SDK README.

### Evidence

- `packages/sdk/package.json:4-15,23-25`: `private: false`, `main` and `exports` point at `.ts` source, and it depends on the private `@gosai/shared`.
- `templates/basic/package.json:12` uses `workspace:*`, which only works because `packages/server/src/apps/installer.ts:163-199` special-cases it. `docs/quick-start.md:76` tells users to `cp -R templates/basic`, which breaks `bun install` outside the monorepo.
- Versions:
  - The manifest has no `sdk` field.
  - `packages/server/src/server.ts:225-239` serves `/sdk-runtime.js` without a version and with `no-cache`.
  - `packages/shared/src/protocol.ts:41` defines `server:welcome`, and the SDK ignores it.
- Apps retype driver payloads by hand: `apps/second-self/src/shared/types.ts`, `apps/interactive-pool/src/shared/types.ts:32-36` (`HandPosePayload`, unused), and `apps/calibration/src/control.ts:705-724`.

---

## PR 13. Dashboard renderer

Depends on: PRs 9, 10 and 11. Wave 5.

### Scope

- Electron main owns experience windows.
  - It subscribes to `experience:state-changed` and opens or closes windows itself, so `rt.router.switchTo` and crashes elsewhere are reflected.
  - The renderer only sends `experience:start` and `experience:stop`.
  - Resolve the display before starting.
  - Delete `renderer/src/lib/stop-experience.ts` and the 1.5 s window polling. Main pushes a `windows-changed` event instead.
- One type-only `src/ipc-contract.ts`, mapping each channel to its arguments and result, imported by main, preload and renderer. Use the shared `DisplayInfo`.
- Split `AppsPanel.tsx` into an `apps/` folder: `AppRow`, `DeviceSettingsSection`, `CameraSettingsControls`, `DeviceSelect`.
- One `CameraModePicker` and a `useCameraFormats(device)` hook, used by the Apps and Settings panels.
- A `useServerResource(request, event)` hook built on `useSyncExternalStore`, a `Button` component, and one `toErrorMessage` helper.
- Keep panels mounted across tab switches, so logs, filters and the camera probe survive.
- A native `<dialog>` for the settings modal.
- The Drivers panel lists every driver's events, actions and config from PR 10's schemas, including drivers no app uses.
- Installing an app shows its `icon`, `author` and requested capabilities from PR 7.
- Choosing "Default" camera sends `null` to clear the override.
- Remove the `window.gosai?` optional checks and the browser fallbacks. The dashboard always runs with its preload.
- Delete the dead code listed below, and update the dashboard sections of `docs/quick-start.md`.

### Evidence

Paths are relative to `packages/desktop/src/` unless noted.

- The IPC contract exists four times: `main/windows.ts:26-54`, `main/ipc.ts:17-87`, `preload/dashboard.ts:4-86` and `renderer/src/types.d.ts:1-82`. The display type has five copies: `SettingsPanel.tsx:8-14`, `ExperiencesPanel.tsx:9-14`, `AppsPanel.tsx:45-49`, the IPC files, and the shared `DisplayInfo`.
- Split ownership of windows:
  - The renderer starts the experience, then asks main for a window (`renderer/src/dashboard/panels/AppsPanel.tsx:290-301`).
  - Main stops the experience over HTTP when a window closes (`main/windows.ts:260-265,458-465`).
  - A dashboard stop goes renderer, IPC, main, HTTP (`renderer/src/lib/stop-experience.ts:10-13`).
  - `AppsPanel.tsx:290-307` starts the experience before choosing a display, so it keeps running without a window when that fails.
- The camera picker is copied in `SettingsPanel.tsx:16-30,54-80,120-148,219-266` and `AppsPanel.tsx:29-43,743-858`.
- `AppsPanel.tsx` is 945 lines with seven components. Button class strings are repeated at `AppsPanel.tsx:402-406,449-453` and `ExperiencesPanel.tsx:110,136`.
- Hand-written data loading: `AppsPanel.tsx:90-126`, `DriversPanel.tsx:13-34`, `ExperiencesPanel.tsx:22-62`, `SettingsPanel.tsx:43-104`, `LogsPanel.tsx:29-44`.
- `renderer/src/dashboard/Dashboard.tsx:68-81` unmounts panels on every tab switch, which re-runs the camera probe in `SettingsPanel.tsx:86-89`. `ExperiencesPanel.tsx:49-53` polls the window list every 1.5 s.
- Error boilerplate: `if (!isNotConnectedError(err)) setError(...)` appears 17 times, plus 12 `// ignore` catches. `main/windows.ts:284-289,381-387,438-444` wrap `destroy()` in a try/catch right after an `isDestroyed()` check.
- Optional `window.gosai?` checks: `stop-experience.ts:10-15`, `AppsPanel.tsx:77,295`, `SettingsPanel.tsx:92-93`.
- `renderer/src/dashboard/components/AppSettingsModal.tsx:100-186` is a hand-built modal with no focus trap, and `:274` has a banner comment.
- `AppsPanel.tsx:829`: "Default" camera saves `device: 0`.
- Dead code:
  - `renderer/src/lib/server-context.tsx:43-49,5`: `useServerEvent` and `DEFAULT_URL`.
  - `projectorDisplayId` is never read: `main/windows.ts:48`, `main/ipc.ts:61`, `preload/dashboard.ts:58`, `renderer/src/types.d.ts:54`.
  - `main/windows.ts:406-409`: the `endExperience` wrapper.
  - `main/ipc.ts:5`: a re-export.
  - `preload/dashboard.ts:91`: `DashboardApi`.
  - `main/index.ts:54-58`: an `activate` handler, although closing the dashboard already quits (`main/windows.ts:135`).
  - `renderer/src/styles.css:3-13`: `@theme` color tokens nothing uses.
  - `renderer/src/dashboard/SystemHeader.tsx:1-4`: a changelog comment. Fold the component into the status bar.

---

## PR 14. interactive-pool on the public SDK

Depends on: PRs 10, 11 and 12. Wave 5.

### Scope

- Import only the public `@gosai/sdk` entry. Use the generated driver types, and delete the hand-written payload types.
- Build layers on the SDK `LayerManager`. Delete `src/shared/canvas-utils.ts`, `feed.ts`, `controller.ts`, the asset URL code in `audio.ts`, and the local `Layer` and `FrameContext` types.
- Fix: layers stopped twice on teardown, and the `switchActive` race.
- Parse ball payloads with one typed check, using `diameter` and one default constant.
- Move the always-on debug text (title, render FPS, ball FPS) and the live relay URL into manifest settings. Today the URL can only be set with a raw storage POST.
- In `univers`, precompute positions, batch drawing into one path, draw orbits at the planet radius, and remove the branch that does nothing.
- Scale motion by `deltaMs`.
- Delete the dead code listed below. Remove `!` assertions where the types already allow it.

### Evidence

Paths are relative to `apps/interactive-pool/src/`.

- `main.ts:268` stops the active layer, then `:272-278` stop every launchable again, including ones never started.
- `main.ts:416-418` set `activeReady` without checking the layer is still current, and `:419-423` swallow a failed start.
- `main.ts:338-388`: 50 lines of ball parsing. The default 80 appears at `main.ts:371`, `layers/balls.ts:21,39` and `layers/rabbits-game.ts:23,103`, and `ball.r ||` can never fall through.
- Debug text is always projected: `main.ts:452-467` and `layers/balls.ts:42-55`.
- `layers/live.ts:20,73` and `README.md:37-47`: the relay URL is set only by a raw storage POST.
- `layers/univers.ts`:
  - `:148-169` does 4000 save, rotate and restore calls and about 6000 paths per frame.
  - `:220-221` draw orbits at `radiusW/2` while planets sit at `radiusW` (`:227`).
  - `:181-191` is a branch that does nothing.
- Motion tied to frame rate: `layers/ambient-display.ts:104-109,126-130`, `layers/rabbits-game.ts:144-145,161,165`, `layers/univers.ts:159,219`, `layers/menu.ts:210,214`.
- `layers/menu.ts`:
  - `:47-49,309,332,337`: `ARROW_FILL_BASE/50` and `APP_FILL_BASE/50` both equal 1.
  - `:69,111,161`: `lastHandSeen` is written but never read.
  - `:102-106,116,125-129`: `ensureSounds` runs every frame, and `stop()` clears handles that the next render recreates.
  - `:387-389`: the comment describes a fingertip dot that is never drawn.
- More dead code:
  - `shared/math.ts:26-28,93-95` (`roundInt`, `clamp`), `shared/types.ts:32-36` (`HandPosePayload`), `shared/canvas-utils.ts:137-139` (a re-export).
  - `shared/audio.ts:57-62,82-84`: `loaded` tracking.
  - `layers/ambient-display.ts:47,69`: an unused `_feed` parameter and a redundant 200 ms check.
  - `shared/types.ts:42-51,61`: `FrameContext.refWidth`, `refHeight` and `frameCount` are never read, and `Layer.preload` is never called.
- Swallowed errors: `main.ts:260-278,399-403,419-423`.

---

## PR 15. second-self on the public SDK

Depends on: PRs 2 and 12. Wave 5. It's large, so the agent can split it into core, then layers.

### Scope

- Core.
  - Import only the public `@gosai/sdk` entry, and use the generated driver types.
  - Replace `src/shared/menu-controller.ts`, `canvas.ts`, `assets.ts` and the config handling with the SDK's `LayerManager`, canvas helpers, `rt.assets.url` and `rt.settings`.
  - Add the `sleep.*` settings to the manifest.
  - `mergeConfig` must not return `DEFAULT_CONFIG` itself.
- Fix:
  - Layer activation racing stop.
  - The avatar renderer never being disposed, and per-frame allocations.
  - The audio context only being created on click.
  - The `pointerdown` listener never being removed.
  - Sleep mode leaving the theremin and score playback running.
  - The avatar's WebGL canvas sitting above the sleep veil and the menu. Use the manager's suspend.
  - Leaving mirror calibration early: restore the saved profile, cancel pending solves, and bring the overlays back.
  - Videos playing after their layer stops. Media becomes per layer and gets released.
  - Sign training counting render frames instead of recognizer outputs, and dividing by zero when nose and hip coincide.
- Motion and UI.
  - Scale motion in music training, particles and sign training by elapsed time.
  - One `src/shared/ui.ts` for the cursor picker, hover button, progress ring, `roundRect` and `dist`.
- Upgrade three and `@types/three` to 0.186. Keep kalidokit pinned at 1.1.5, and copy its solvers into the repo only if it blocks the three upgrade.
- Delete app-internal dead code, duplicated constants and needless casts, listed below.

### Evidence

Paths are relative to `apps/second-self/src/`.

- Layer races:
  - `shared/menu-controller.ts:197-205` never re-checks `running` after `preload` and `start`, so `layers/aria.ts:312-317` attach WebGL to a layer that has already stopped.
  - `shared/menu-controller.ts:175-194` stop the menu twice, and the comment at `:185-186` is wrong.
  - `'menu'` is hardcoded at `:70,141`, and the always-on list is repeated at `layers/menu.ts:267-269` and `main.ts:92`.
- Avatar:
  - `layers/aria.ts:333-336` never dispose the renderer. A new manager is built on every start, which leaks a WebGL context each time; Chromium caps them around 16.
  - `layers/aria.ts:75-91` allocate Euler, Quaternion and Vector3 objects per bone per frame.
- Audio: `main.ts:171-173` and `shared/synth.ts:34-64` create the context only from `pointerdown`, and `main.ts:214-227` never remove that listener.
- Sleep:
  - `main.ts:207-208` skip render while asleep, but `layers/theremine.ts:70-71` update the tone only from render.
  - `layers/aria.ts:270-272` put the WebGL canvas at z-index 5, above the 2D veil drawn in `shared/sleep.ts:157-234`.
- Config: `shared/config.ts:149-150` return `DEFAULT_CONFIG` itself, and `layers/calibrate.ts:377-379` write to it, although `shared/deps.ts:21` says it's read-only.
- Settings drift:
  - `shared/config.ts:34-45,74-80` and `README.md:106-110` define `sleep.*`, which `gosai.app.json:21-49` lacks.
  - `shared/config.ts:149-202` duplicate the defaults and bounds.
  - `shared/config.ts:117-122` save the full defaults, so later default changes never apply.
- Mirror calibration:
  - `layers/calibrate.ts:460-467` reset the driver only in direct mode.
  - A solve in flight at `:330-346` switches the driver after stop.
  - Only `finish()` at `:391-395` restores the overlays.
- Media: `shared/media.ts:6-35` hold global caches that are never released, and `:38-41` start looping playback that continues after `layers/sign-game.ts:249-252` and after `layers/sign-training.ts:93-99` moves on.
- Sign training:
  - `layers/sign-training.ts:161-164` hold for 10 render frames, while `shared/sign.ts:34-37` count recognizer outputs.
  - `:208,226` divide by a ratio that can be 0.
  - The sign list is duplicated at `main.ts:72-89` and `layers/sign-training.ts:52-67`.
- Sign game:
  - `layers/sign-game.ts:572-590` compute values and discard them with `void`.
  - `:206` has an unneeded cast, and `:307` an unused `now` parameter.
  - `:438` `wrapText` ignores `fontLoaded`.
  - `:368` asks for a "goodbye" sign that nothing handles.
- Music training:
  - `layers/music-training.ts:27,121` move notes a fixed number of pixels per frame while the synth schedules by clock time.
  - `:34-35,123-125` hold unused `score` fields, and `:11-13` split one import over two lines.
  - `drawBars` copies `layers/theremine.ts:95-113`.
- Driver parsing: `main.ts:448-477` map every landmark on every message, which contradicts `shared/feed.ts:4-6`. 1280x720 is repeated at `main.ts:474-475`, `shared/feed.ts:57-58` and `layers/aria.ts:190-193`.
- Dance: `layers/dance.ts:300-306` hand-write an `ImageDecoder` type that is never closed, `:102-103` skip the `resp.ok` check, and `:107` has a redundant `.catch`.
- Duplicated UI:
  - Cursor grace: `layers/menu.ts:37` and `layers/calibrate.ts:59`.
  - Picker and buttons: `layers/menu.ts:92-139,210-218` and `layers/calibrate.ts:399-416,662-701`.
  - The progress ring is drawn four ways: `layers/menu.ts:287-293`, `layers/calibrate.ts:717-731`, `layers/poke-it.ts:64-77`, `layers/dance.ts:283-296`.
  - `layers/menu.ts:345-361` hand-roll `roundRect`.
  - `dist` is redefined at `layers/menu.ts:363`, `layers/poke-it.ts:89`, `layers/dance.ts:334` and `layers/sign-training.ts:363`.
- Frame rate: `shared/particles.ts:44-47`.
- Dead code:
  - `shared/synth.ts:66-73` (`setMuted`, `isMuted`).
  - `LayerDef.icon`, set on 14 layer definitions and never read.
  - `MenuController.definition`, 27 unused exports, and `layers/clock.ts:16` `_deps`.
- Unneeded casts: `layers/dance.ts:301`, `layers/sign-game.ts:206`, `shared/synth.ts:39`.
- Display layers: `layers/show-frequency.ts:21-34` build one path per bin, and `layers/show-ping.ts:27` should use `rt.ping()`.
- `layers/aria.ts:26` is the only kalidokit import. The last kalidokit release was in February 2022.

---

## PR 16. App-provided Python drivers (optional)

Depends on: PRs 5, 7, 10 and 12. Wave 5. This adds a feature. It completes what the manifest and SDK README already describe.

### Scope

- Implement the manifest `python` field, so an installed app can ship Python drivers.
- Run each app's drivers in their own bridge process and uv environment. A crashing or conflicting third-party driver then can't take down the built-in drivers. Name them `<app>/<driver>`.
- App drivers get the same leases, lifecycle, schemas and describe reply as built-in drivers, and generate types with PR 12's generator.
- The installer installs the app's Python dependencies with uv. Reuse the Python requirements path in `installer.ts`, which nothing calls today.
- Discovery accepts a package path per app, alongside the built-in `gosai_py.drivers` walk.
- The template gets an optional driver example, and the SDK README documents the feature.

### Evidence

- `packages/server/src/apps/manifest.ts:115-125,280` parse `python.*` and the per-experience `python` field, and nothing loads them.
- `packages/server/src/apps/installer.ts:18,21,57-63,133-152` contain a Python requirements path that `packages/server/src/apps/manager.ts:77-81` never enables, because `pythonDir` is never passed.
- `python/src/gosai_py/bridge.py:104-130` only walk `gosai_py.drivers`. `bridge.py:9` mentions a `register_drivers()` that doesn't exist.
- `packages/sdk/README.md:237-261` document Python integration. `templates/basic/README.md:43-73` give a Python path, `src/main.py`, that differs from the SDK README's `python/main.py`.
