# Multi-worker concurrency handoff

Status: phases A/B/C and phase D automatic tests/documentation are accepted. **Real Windows two-window core E2E passed on 2026-09-30**: controlled slow handshake, independent reports/detail reads, targeted messages after closing one instance, and independent process exit. No Worker remains active. Additional real OS/fallback/fault-injection and TUI visual checks were not performed; do not claim those passed.

## Source of truth and workspace

- Plan: `docs/multi-worker-concurrency-plan.md` (pre-existing untracked design; not overwritten).
- Workspace: `E:/web/pi-terminal-worker`. Implementation was reviewed and accepted in the working tree before the final commit. Preserve accepted changes; do not reset or discard them.
- The controlling agent owns planning, actual diff review, independent tests and acceptance. Implementation used one scoped Worker at a time.
- Verification matrix and manual checklist: `docs/verification/multi-worker-concurrency.md`.

## Completed and accepted

### Phase A: registry and routing

- `src/multi-worker.ts` gives each Worker its own `ControllerManager`, pipe, tokens, connections, reports and lifecycle resources.
- Synchronous registration and workerId routing; production entry uses `MultiWorkerCoordinator` while direct controller APIs/tests remain.
- Unknown IDs never select another Worker. Ambiguous no-argument commands never choose the newest instance.
- Previously independently verified typecheck, build and 154/154 tests; implementation Worker accepted.

### Phase B: parallel starts and per-Worker ordering

- Controller tools declare `executionMode: "parallel"`; independent starts may overlap.
- Per-entry send/stop/close queue; wait/status remain outside it. Concurrent close disposition rules and non-reused IDs are tested.
- Previously independently verified typecheck, build and 165/165 tests; implementation Worker accepted.

### Phase C: lists, commands, UI and lifecycle

- Resumed Worker `worker-42446fe2` completed C, underwent two review/revision rounds and was closed as `accepted`.
- `worker_list` returns at most 20 bounded summaries, including bounded title/cwd/model/provider strings. Detail reads stay scoped by workerId.
- ID-aware commands retain single-instance shortcuts, refuse ambiguous targets and recheck confirmation state before queued forget. Forget does not kill a process and cancels waiters.
- A session-scoped 1-second unref'ed status-bar poller covers idle asynchronous reports/disconnections; shutdown stops it. Disconnected review instances count as issues.
- Queued mutations check entry reference/epoch at execution. Lifecycle operations serialize; disposal cleans entries independently, rejects new starts until the next session start, and is idempotent.
- Minimal `src/controller.ts` generation checks prevent late start/listen/error/socket/task-ACK callbacks from reviving resources or contaminating a new session. An initial generation-pump workaround was rejected and removed.
- Main agent independently verified `git diff --check`, typecheck, build, 76/76 isolated tests and 226/226 full tests. Test processes exited normally (about 8.6s/8.9s).
- Historical pause schema failure/hanging test did not reproduce at resume: initial baseline was 30/30, exiting normally in 7.8s. Do not treat the old pause findings as current failures.

### Phase D: automatic fault tests and documentation (limited scope accepted)

- Worker `worker-c6126a7f` delivered only automatic tests/documentation, underwent one revision and was closed as `accepted` for that scope. Real E2E was subsequently performed by the main agent under the user-authorized two-test-Worker exception.
- Nine added coordinator-level fault tests use real controller kernels and fake socket frames: cross-instance authentication, interleaved reports/local input/revision, wait timeout/abort, heartbeat/disconnect, close timeout/late child_exit, initial task delivery unknown without redispatch, inbox count/byte limits and report-cache count/byte limits.
- Byte-limit tests fill real payload/cache data calibrated by `jsonByteLength`, rather than setting fake full-byte counters.
- README documents seven tools, commands, parallel execution settings, linear resource scaling, write contracts (not a sandbox), lifecycle/reload limits and OS failures. The historical design has a supersession note.
- Main agent independently verified `git diff --check`, `npm run typecheck`, `npm run build`, 59/59 coordinator tests and **235/235 full tests**, exit 0 with natural process termination (about 10.6s/11.0s).
- Main agent clarified documentation after review: shutdown attempts close/resource cleanup but does not guarantee every child process/window exits.

## Real two-window acceptance: PASS (2026-09-30)

After updating `E:/web/ptw-installed` and restarting Pi, the user authorized a bounded two-read-only-Worker exception in global AGENTS.md. The main agent used only `worker_start` for actual terminal starts; no hand-written terminal launcher was used.

- Evidence: `docs/verification/multi-worker-concurrency.md` section 5; local artifacts under `E:/web/ptw-e2e-20260930-104636`.
- A: `worker-3c19d667` / `task-20b676d1`, Worker PID 15884, bootstrap PID 30244. B: `worker-5b1edf0f` / `task-68faed7c`, Worker PID 42080, bootstrap PID 29316.
- A had a temporary cwd-scoped pre-connection delay of 15,008ms. B sent ready 14,897ms before A and received its task 14,784ms before A. This delayed handshake, not task work.
- Both workers delivered their independent initial result/idle states. Own eventId reads worked; cross-worker reads returned no eventDetail.
- A closed as accepted; its Worker/bootstrap exited while B stayed connected with its initial report intact. B then received a targeted revision and returned `E2E_B_AFTER_A_CLOSED_7F42` at revision/runId 2/2.
- B closed as accepted. Final worker_list total=0, and Windows process queries found none of the four test PIDs.
- Temporary installation hooks were restored immediately after launch; final src/dist/runtime comparisons match the development build. Project runtime source was not changed for E2E.
- After restoration, independent typecheck/build and 235/235 full tests passed, naturally exiting in about 11.1s.

Core required real E2E is now passed. Real terminal-fallback/resource-exhaustion/abnormal-close injection and TUI/window visual checks remain outside this run's verified scope. Do not confuse automatic fault tests with real fault injection.

## Reviewed files (pre-commit snapshot)

- Runtime: `src/multi-worker.ts` (untracked), `src/controller.ts`, `src/extension.ts`, `src/ui.ts`.
- Tests: `test/multi-worker.test.ts` (untracked), `test/controller.test.ts`, `test/extension.test.ts`, `test/generation.test.ts`.
- Documentation: `README.md`, `docs/pi-terminal-worker-扩展设计与实施方案.md`, this handoff, the pre-existing untracked plan, and `docs/verification/multi-worker-concurrency.md` (untracked).
- README had a pre-existing multi-instance limitation edit; its semantics were retained.

At verification completion the changes had not yet been committed; this handoff records that pre-commit review snapshot. No active Worker remains, no temporary hook remains in the installed extension, and core real E2E acceptance is complete. Future tests may cover the explicitly unverified extended scenarios. Final commit/push status is recorded by Git history, not by this snapshot.
