# Task lifecycle replay guide

This guide preserves the model-driven Owner/Executor exercise run on 2026-09-21,
including its inputs, user turns, controlled failures, assertions and evidence
requirements. It is a repeatable test specification, not a production workflow or
a checklist every Task must follow.

The baseline used Task source
`da55eb4bf034b2940f90eac6d2cbff51dde95cd4`, four model actors and five Tasks.
All 40 assertions in cases S1-S6 were evidenced by an independent observer.
The subscription-necessity cases N1-N3 were subsequently run separately:
**18/18 scoped assertions passed in one supervised trial per case.** They are not
included in the 40/40 result and use the narrower setup documented below.

## Contents

- [Scope and safety](#scope-and-safety)
- [Inputs and actors](#inputs-and-actors)
- [Harness and startup](#harness-and-startup)
- [Actor instructions](#actor-instructions)
- [Phase order](#phase-order)
- [Cases S1-S6](#cases-s1-s6)
- [Controller fault recipes](#controller-fault-recipes)
- [Subscription-necessity cases N1-N3](#subscription-necessity-cases-n1-n3)
- [Coding workflow cases G1-G4](#coding-workflow-cases-g1-g4)
- [Executor preparation: rationale and acceptance](#executor-preparation-rationale-and-acceptance)
- [Completion retro acceptance](#completion-retro-acceptance)
- [Selective reading and follow-up acceptance](#selective-reading-and-follow-up-acceptance)
- [Coverage and grading](#coverage-and-grading)
- [Artifacts, review and shutdown](#artifacts-review-and-shutdown)
- [Baseline observations and untested boundaries](#baseline-observations-and-untested-boundaries)

## Completion retro acceptance

These are current-source acceptance requirements, not additional claims about
the historical S/N/G baseline results below. Preserve those original outcomes
and source snapshots; reruns use the current explicit Agent completion contract.
Scripted Agent fixtures must submit retro too; script automation itself does not
run an Agent and remains exempt.

Use isolated synthetic data and the existing tests. Check:

- Done with a new outcome and useful retro text, and done with explicit null,
  persist together. Missing retro, retro on ordinary reports (even null), blank
  text, over 2,000 characters, or combined serialized `{outcome,retro}` over
  16,000 characters reject without accidental completion.
- Exact replay of a completion accepted under the current contract retains its
  saved result without duplicate outcome/retro. Every incoming done request
  missing retro, including old-format replay attempts, returns `INVALID_INPUT`
  before any writes, including activity. Original legacy operations remain
  untouched and readable through `task_read(view=operation,request_id=<original ID>)`
  without side effects. Do not auto-fill null or retry changed input under the
  same request ID. A stale completion
  can save acknowledged old activity but rejects status/outcome/retro; ACK,
  lifecycle and write-context protections still apply.
- Schema v4 migration preserves historical outcomes with `not_recorded`, not
  invented no-findings text. Fresh writes, restart and bounded history retain
  the same outcome ID, revision, executor, reported author/source and timestamp.
- Execution/definition and outcomes expose independent full retro; default overview/list
  expose attribution/status without text. A post-completion description edit
  preserves the original revision and yields `current:false`; no Task reopens.
- Automation returns `not_applicable` and keeps its service-generated outcomes.
  Rendering distinguishes recorded text, explicit no findings, missing legacy
  history and automation, without mixing retro into the delivery outcome.
- Existing status subscriptions behave unchanged. No new notices, dispatch,
  Owner mandatory review or improvement authorization comes from recording retro.

Separately assess model behavior: delivery happens before reflection; findings
identify useful actionable observed automation candidates, concrete slow/repeated
sticking points, or Skill/MCP discovery/contract/capability harness gaps with
locatable evidence. Distinguish observation from hypothesis and external waits;
do not fabricate timings. No mandatory multi-section template or filler: genuine
no-findings work uses null. Verify retro does not replace outcome or blockers.
Passing schema/storage tests proves submission and persistence, not that an
Agent actually reflected or produced useful text. Do not report a model-behavior
pass without a separate observed run.

## Selective reading and follow-up acceptance

These current-source requirements supersede historical fixed-view and routine
cleanup-subscription examples, not the recorded S/N/G observations or their counts.
Use only synthetic stores/hosts and the existing store, MCP, module and Skill tests.

- Discover `overview.include` through the real MCP tools/list schema; reject empty,
  duplicate, unknown or cross-view selections and pagination/revision combinations.
  A context-only read must not load or return body/history/log columns.
- After actual synthetic done/blocked notifications, one selected read must yield
  current context and complete requested activity/outcome/retro, including blocked
  with no outcome. Check old revision/current/source/author/time and distinguish
  absent records, explicit retro null and unselected keys.
- Concurrent commits from another SQLite connection must not mix revisions within
  one selected result. Keep the separately refreshed definition_check and all ACK,
  actor, replay and write-conflict behavior unchanged.
- JSON escaping counts toward the 48,000-character result budget. Overflow is an
  explicit error with group sizes, not an excerpt. Legacy views stay compatible;
  history and automation logs remain paginated. HTTP and MCP share validation.
- Skill examples choose content by purpose rather than a fixed notification bundle.
  Executor still reads full execution requirements and ACKs the exact revision.
  Default no subscription applies to Agent and automation. Only necessary authorized
  future Owner action justifies a wait; direct Executor questions need no Owner relay.
- Routine merged-worktree cleanup may be deferred/batched. Record PR/branch/path
  and release evidence, retain Owner safety checks, and never imply new cleanup
  scripts/timers or deletion of Executor's cwd.

These scripted assertions do not establish autonomous model behavior. A new model
exercise must separately observe selective reading and subscription judgment;
do not relabel the older supervised trials as evidence for the new guidance.

## Scope and safety

| Layer | What this exercise uses |
| --- | --- |
| Task | Actual module activation, service, SQLite, revisions, receipts and subscriptions |
| Agent interface | Official HTTP MCP requests, schemas and responses |
| Guidance | Actual role prompts, Skill metadata, bodies and bundled references |
| Actors | Separate model contexts making choices within staged user requests |
| Host | Synthetic sessions, capability observations, queues, messages and interruption |
| User decisions | Controller-supplied questions/answers, continuation and acceptance |
| Evaluation | Read-only observer, raw audit, retained outputs and bounded snapshots |

Do not use production data, installations, credentials, sessions or Owner messages.
Do not migrate a real database, deploy, or restart a real Cockpit service.
Use a loopback-only lab with a new storage directory. No actor may
call real Cockpit session tools, contact another actor through a side channel, or
read another actor's private experiment report.

Only the controller may manipulate synthetic host fixtures. Task business writes
must still use real handlers/MCP; do not change Task rows to manufacture success.
Direct fixture SQL, if used in a separate recovery experiment, must be labelled
and excluded from this model-driven baseline.

The baseline is supervised coverage, not proof of autonomous Skill triggering,
Skill-only causality, native delivery, native interruption, UI behavior or a general
exactly-once guarantee. Technical probes and injected failures must be distinguished
from mistakes the models make naturally.

**Subscription restraint:** normal work defaults to no subscription. Owner should
subscribe only when a future state unlocks a concrete, necessary Owner action,
not merely to know that work finished. S1-S6 deliberately request subscriptions
to exercise interfaces and failure paths; that frequency is not a recommended
operating pattern. N1-N3 separately evaluate the necessity judgment.

## Inputs and actors

### Immutable input

Create `fixtures/observations.csv` in the new experiment workspace, using UTF-8,
LF line endings and a final newline:

```csv
id,service,latency_ms,result
R01,checkout,120,ok
R02,checkout,180,ok
R03,checkout,900,error
R04,checkout,240,ok
R05,search,60,ok
R06,search,80,ok
R07,search,300,error
R08,search,100,ok
```

Expected SHA-256:
`318cb725c1c6e100b84812db17477b38bb8ec56f4fdaf94c3bc1e61d49a712c0`.
Check the hash before and after the exercise. Actors may read, but not modify,
this file. These are synthetic observations, not production measurements.

### Actor and Task map

| Actor | Selected roles | Responsibility | Allowed output directory |
| --- | --- | --- | --- |
| Owner | `owner` | Delegate and coordinate A-E | `actors/owner/` for private observations; `handoffs/` for explicitly shared pending context |
| Executor A | `executor` | Complete A, then handle C | `work/baseline/`, `actors/executor-a/` |
| Executor B | `executor` | Complete B across clarification and review | `work/risk/`, `actors/executor-b/` |
| Dual | `owner`, `executor` | Execute actual assignments D, then E | `work/dual/`, `actors/dual/` |
| Observer | No operational role | Grade evidence without changing state | `evaluator/` |

Owner creates the normal Executors using `task_session_create`. Controller creates
the initial Owner and the deliberately selected dual-role candidate as synthetic
fixtures. A role selection alone is not an assignment. Give each model its real
synthetic session ID; never reuse IDs from an earlier run.

| Task | Independent outcome | Completion boundary |
| --- | --- | --- |
| A | Per-service count, mean/max latency and error rate | Complete report; no review gate |
| B | Per-observation risk classification | Draft `in_review`, then explicit user acceptance |
| C | Anomaly notes, later narrowed to checkout errors | Preparation only, then user cancels |
| D | Data limitations and two future sampling recommendations | Complete report; no actual collection |
| E | Markdown note explaining the synthetic sample limitation | At most 150 characters, including Markdown/link/whitespace |

Keep a controller-owned mapping of labels, IDs, subscriptions, request IDs, queue
IDs and output paths. Exact replay requires the original complete input, including
its opaque context, not just the request ID.

### Evaluator-only expected results

Do not give this table to the actors as their answer:

| Output | Expected content |
| --- | --- |
| A, checkout | count 4; mean 360 ms; max 900 ms; error rate 1/4 = 25% |
| A, search | count 4; mean 135 ms; max 300 ms; error rate 1/4 = 25% |
| B | critical: R03/R07; warning: none; normal: the remaining six |
| C, narrowed scope | Only R03 satisfies `service=checkout AND result=error` |
| D, if medians are used | checkout 210 ms; search 90 ms |
| E | Correct sample limitation, valid original-input reference, at most 150 characters |

## Harness and startup

### Availability and portability

The original lab is a **session artifact**, not a repository script or packaged
module. Its archive root is named `task-flow-simulation/` and contains:

```text
lab/
  USAGE.md
  common.mjs
  server.mjs
  client.mjs
  operator.mjs
  smoke.mjs
  runs/lifecycle/
fixtures/
actors/
work/
evaluator/
review/
```

The commands below apply to that archived harness or an equivalent isolated copy.
A fresh repository checkout alone does not contain these commands. Obtain the
archive before attempting them; never substitute production endpoints if it is
unavailable. The case specifications and assertions in this document are
independent of the archive.

An equivalent harness must activate the real module with isolated storage,
advertise `serviceReadyVersion: 1`, and call its real `onReady` after the loopback
server is listening. Implement only synthetic public host intents needed by Task:
`session/new`, `session/get`, `roles/readiness` and `prompt`. Keep model scheduling
separate from recording accepted/queued messages. Derive role tool subsets and
Skill paths from the actual manifest instead of duplicating a guessed contract.

Before reuse, inspect the copied harness's `common.mjs`: its original `REPO`
constant points to the original worktree, and its SDK imports use that worktree's
installed dependencies. Update a copy for the intended source tree. Record source
commit, module/SDK/Node versions, role/Skill hashes and available model settings.
Node.js 24 or later and the repository's existing dependencies are required.
Do not infer installed capabilities from a package version label.

The original summary and review-packaging helpers also assume the `lifecycle`
run and particular phase filenames. Adapt copies explicitly for a new run; do not
accidentally summarize the old database or overwrite its evidence.

### Start a new run

In these examples, replace paths and uppercase identity placeholders with actual
values. Repeat shell variables when using tools that start a fresh shell per call.

```bash
ARCHIVE=/absolute/path/to/task-flow-simulation-copy
LAB="$ARCHIVE/lab"
RUN=lifecycle-new-run
test ! -e "$LAB/runs/$RUN" &&
  node "$LAB/server.mjs" --run "$RUN" --port 0
```

Run the foreground server command in an **attached async** tool session. Do not
detach it. Use a unique run name for a fresh experiment; resuming a stopped run
retains its SQLite and synthetic sessions. Never start two servers for one run.
Read the printed endpoint/runtime metadata and confirm `/health` responds.

Create only the bootstrap fixtures:

```bash
node "$LAB/operator.mjs" --run "$RUN" create-session \
  '{"roles":["owner"],"label":"Lifecycle Owner","cwd":"ABSOLUTE_WORK_DIRECTORY"}'
node "$LAB/operator.mjs" --run "$RUN" create-session \
  '{"roles":["owner","executor"],"label":"Dual role candidate","cwd":"ABSOLUTE_DUAL_WORK_DIRECTORY"}'
```

`runs/<run>/runtime.json` gives the endpoint, stable actor IDs and roster. Do not
precreate A-E or substitute scripted tool calls for the Owner model.

An optional `node "$LAB/smoke.mjs"` checks the harness in its own distinct run.
Its scripted successes are not evidence that a model followed the Skill.

### Existing repository regressions

These complement, but do not replace, the model exercise:

```bash
node --test test/skill-frontmatter.test.js test/task-board-mcp.test.js \
  test/task-board-subscriptions.test.js test/task-board-operations.test.js
```

Do not run packaging checks concurrently against the same output archive.
The separate `test/task-board-host-integration.test.js` uses the actual isolated
host/SDK with a synthetic provider. It requires a compatible host worktree,
`TASK_BOARD_HOST_WORKTREE`, a freshly packaged module and the host's TypeScript
runner. Without that environment it skips; a skipped run is not native evidence.
From the Task repository, with that host's dependencies already installed:

```bash
npm run package:module
HOST_SOURCE=/absolute/path/to/compatible/cockpit
mkdir .task-board-host-runner
TMPDIR="$PWD/.task-board-host-runner" TSX_DISABLE_CACHE=1 \
  TASK_BOARD_HOST_WORKTREE="$HOST_SOURCE" \
  "$HOST_SOURCE/packages/core/node_modules/.bin/tsx" --test test/task-board-host-integration.test.js
```

Use a fresh runner directory and run no concurrent packaging against its archive.
The harness creates empty temporary home/config/state directories and a synthetic
loopback provider; it does not use real sessions or contact a real model provider.
Inspect the test result, then remove the empty runner directories:

```bash
rmdir ".task-board-host-runner/tsx-$(id -u)" .task-board-host-runner
```

See [host integration](task-host-contract.md) for required capabilities.
Task is hosted by Cockpit; it has no standalone server startup command.

## Actor instructions

Give each actor only its ID, run, work/output boundaries, actual role entry point,
client syntax, and the user request for the current phase. The controller and
observer retain this runbook, fault recipes and expected answers.

Use a prompt of this form, replacing placeholders:

```text
You are a model actor in an isolated Task collaboration exercise.
Actor: <SESSION_ID>. Run: <RUN>. Client: <ABSOLUTE_CLIENT_PATH>.
Read `role` for the actual selected prompts and Skill metadata.
Decide which Skill body/reference and tool schemas you need.

Only the supplied client may operate Task or synthetic host state.
No real Cockpit tools, production APIs, credentials, direct SQLite,
operator/evaluator files, other actors' private reports, or side-channel messages.
Explicitly shared handoff artifacts are permitted inputs, not private reports.
Do not use write_agent to talk to another actor.
Write deliverables only under <WORK_DIRECTORY>; do not modify the input CSV.
Use `user-question` for a genuine missing user decision, then end the turn.

Inspect the whole MCP result: a zero process exit is not business success.
At the end, record actual effects, uncertainty, guidance reads, friction and the
stopping point under <ACTOR_REPORT_PATH>. This is experiment evidence, not a
second Task progress ledger. Follow the user request below.
```

Available client forms:

```bash
node "$LAB/client.mjs" --run "$RUN" --actor "$ACTOR" role
node "$LAB/client.mjs" --run "$RUN" --actor "$ACTOR" tools
node "$LAB/client.mjs" --run "$RUN" --actor "$ACTOR" schema task_read
node "$LAB/client.mjs" --run "$RUN" --actor "$ACTOR" skill owner
node "$LAB/client.mjs" --run "$RUN" --actor "$ACTOR" skill executor
node "$LAB/client.mjs" --run "$RUN" --actor "$ACTOR" skill owner references/important-updates.md
node "$LAB/client.mjs" --run "$RUN" --actor "$ACTOR" call task_read \
  '{"view":"execution","task_id":"ACTUAL_TASK_ID"}'
node "$LAB/client.mjs" --run "$RUN" --actor "$ACTOR" messages
node "$LAB/client.mjs" --run "$RUN" --actor "$ACTOR" user-question 'A concrete scope question'
```

`tools` and `schema` expose real MCP definitions through the simulated selected
role subset; dual roles get the union. The client injects the actual actor ID and
records exact inputs. This is lab visibility/attribution, not an authenticated ACL.

Do not preload every reference or prescribe a tool sequence to make the actor pass.
Retain each actor's context across phases. Reusing stable guidance is desirable;
reloading after genuine context loss or guidance changes is not a failure.
Always distinguish Skill reuse from fresh Task reads and revision ACK.

Controller activation is separate from model execution:

```bash
node "$LAB/operator.mjs" --run "$RUN" activate-actor \
  '{"session_id":"ACTUAL_ACTOR_ID","queue_item_ids":["EXACT_QUEUED_MESSAGE_ID"]}'
```

This changes synthetic state and delivers only named queue items; it does not
launch or wake a model. Start/resume the corresponding model separately. An empty
array delivers nothing. `messages` includes accepted history, so an old card is
not new work authorization. At the appropriate phase end, controller records
synthetic idle explicitly; there is no automatic advancement or polling loop.

## Phase order

The following is the baseline sequence. Independent phases may overlap, but keep
the fault windows isolated. Phase reports use `actors/<actor>/phase-N.md`.

| Step | Actor phases | Request / controller action | Stop condition |
| --- | --- | --- | --- |
| 1 | Owner 1 | Delegate A and B; explicitly request baseline subscriptions | Both assigned; Owner ends without polling |
| 2 | A 1 and B 1 | A delivers; B asks missing thresholds directly | A done; B blocked and question recorded |
| 3 | B 2 | Answer thresholds; permit preparation only | Full agreement updated/ACKed; no draft |
| 4 | Owner 2 | Deliver A/B system cards; inspect current state; create C on finished A's session; attempt D with unavailable capability | C assigned; D unassigned, no dispatch |
| 5 | Owner 3 and A 2 | Replace B's review wait with done wait; D now capable but busy; C preparation only | B wait changed; D still unassigned; C prepared |
| 6 | Owner 4 | Seed C pending context; require immediate scope change; make D idle, request its done wait and assignment | One C updated handoff; D assigned |
| 7 | A 3, B 3 and Dual 1 | A synchronizes only; authorize B draft with revision-race hook; D completes with lost notification acknowledgment | C latest ACK; B in_review; D done/notification unknown |
| 8 | A 4, then A 5 | Explicitly cancel C; later deliver a labelled delayed old card | C cancelled/expired wait; resumed actor performs no terminal mutation |
| 9 | Owner 5 | Deliver D card; run three subscription boundary probes; create E without subscription and inject post-bind availability loss | E bound but confirmed not_sent; no blind retry |
| 10 | Owner 6 and B 4 | Restore E availability; authorize recovery and exact replays; directly approve B's draft | One E dispatch; B new final outcome/done |
| 11 | Dual 2 | Execute newly assigned E, not D again | E done, no Owner status card |
| 12 | Owner 7 | Deliver B card; request full A-E portfolio/history with pages of at most two | Complete bounded readback; no new mutation |

Hold B's final approval until D's one-shot notification fault has been consumed.
Otherwise the fault could affect B and fail to exercise the intended D case.
The baseline also encountered a real Owner subscription context conflict while B
was being clarified. That interleaving is not guaranteed on every rerun; record
whether it happened rather than claiming coverage from the old transcript.

## Cases S1-S6

The prompts below preserve the original intentions, not byte-for-byte transcripts.
Replace `<FIXTURE>` and output paths for the new workspace. Fault details belong
to the controller; do not tell an actor the recovery answer in advance.

### S1: Normal delegation and delivery

Owner request:

```text
Arrange an independent Executor to summarize <FIXTURE> by service: record count,
mean and maximum latency, and error rate. Include error rows in latency statistics.
Save a concise Markdown report and calculation evidence. No review gate is needed.
For this notification test, explicitly register one done notice to yourself.
Delegate delivery rather than doing the report yourself; do not keep checking it.
```

Keep synthetic Owner busy while Executor A finishes, so the system notice queues.
Deliver that exact queued card in Owner's next phase. Ask Owner to read the current
Task/result without asking Executor for a progress report.

| Assertion | Evidence required |
| --- | --- |
| S1.1 | Owner loads actual guidance and delegates rather than delivering personally |
| S1.2 | Creation/assignment use real MCP; only one initial assigned message is sent |
| S1.3 | Executor reads complete requirements and ACKs before meaningful execution |
| S1.4 | `done` includes a new outcome and a substantive, correct report reference |
| S1.5 | One actual transition consumes the wait; recipient is Task Owner, not the reporting actor |
| S1.6 | Owner reads current evidence after the card, without ACK or automatic renewal |
| S1.7 | No polling, schedule or manual Executor-to-Owner progress/completion message |

### S2: Clarification, concurrent revision and review

Initial request, delegated alongside A:

```text
Classify every observation in <FIXTURE> by risk. The thresholds are not yet decided.
The Executor must ask me directly for that decision, produce a cited Markdown
draft, and wait for my explicit approval before final delivery.
For this boundary test, notify Owner once on the first blocked or in_review state.
```

When B asks, answer:

```text
Use critical, warning and normal, with the same rules for both services.
An error or latency >= 800 ms is critical. Otherwise latency >= 250 ms is warning.
Everything else is normal; boundaries are inclusive. For this turn only record
the agreement and prepare. Do not draft yet. This is not acceptance of a draft.
```

Owner's intermediate user turns explicitly ask first for the next `in_review`
notice, then replace that still-waiting subscription with a `done` notice.
Preserve the earlier triggered blocked record.

Arm the refreshed revision-race recipe, then tell B:

```text
Continue the risk analysis now; the preparation-only restriction has ended.
Produce the Markdown draft and record the completed stage facts, draft outcome
and awaiting-review state together in Task. This is not final acceptance.
```

The controller-approved concurrent addition requires every row's ID, service,
latency, result, final risk and matching rule, plus counts for all levels including
zero. Preserve existing thresholds, immutable input and user-review requirements.
If the hook does not apply or no partial report occurs, mark that branch unexercised.

After independently inspecting the draft, supply explicit final acceptance:

```text
I approve draft v2, including its classifications, error precedence, boundary
explanation and synthetic-sample limitations. This authorizes final delivery.
Record that decision, preserve the draft/history, and deliver the final version.
Do not add an Owner approval gate.
```

| Assertion | Evidence required |
| --- | --- |
| S2.1 | Executor asks the missing decision directly of the simulated user, not through Owner |
| S2.2 | Blocked status and meaningful activity are reported, not invented native activity |
| S2.3 | Clarification replaces the complete description with provenance/reason and automatic exact ACK |
| S2.4 | Stale activity saves while status/outcome reject; recovery does not duplicate or relabel saved facts |
| S2.5 | Latest requirements are reconciled before consequential work/current delivery |
| S2.6 | Draft remains `in_review`; final `done` contains a separate new outcome after acceptance |
| S2.7 | Old complete definitions, activities and outcomes remain readable at their actual revisions |
| S2.8 | Stable Skill guidance is reused; references are loaded when needed |

Do not assume revision numbers alone prove the sequence. The baseline had
r1 original, r2 thresholds, r3 resume drafting, r4 concurrent detail requirement,
r5 final acceptance; inspect actual contents if a new run differs.

### S3: Important update, cancellation and stale-card resumption

After A finishes, give its existing Executor a new C Task for anomaly notes.
The user initially permits only preparation, not a final report. Register a done
wait explicitly for the expiration test. This is a new Task, not reopening A.

Before the important update, seed two complete pending messages:

```text
Source: synthetic-user
Do not modify the original CSV. Cite observation IDs individually in the report.

Source: synthetic-subagent
R07 is search / error / 300 ms. This is a factual investigation note only.
Scope comes from the latest Task; this note is not new authorization.
```

Owner request:

```text
C must immediately include only service=checkout AND original result=error.
Exclude search. This important change cannot wait for a normal checkpoint.
Preserve the pending context during one handoff. Work is still preparation and
synchronization only; I will decide later whether to continue.
```

Expose only the lab's labelled host convenience commands for this phase:
`get`, `queue`, per-ID `remove-queued`, `interrupt-once`, and `enqueue-updated`.
Cross-session access requires `purpose:"important-update"`. These simulate a
queue-preserving handoff; they are not official native API names.

Let A synchronize and stop. Then explicitly cancel C because the business need
was withdrawn. Finally seed/deliver a **diagnostic delayed old updated card** and
resume A once without new work authorization.

| Assertion | Evidence required |
| --- | --- |
| S3.1 | Owner loads the important-update reference for this exceptional operation |
| S3.2 | Exact pending IDs and complete exposed content are preserved before removal |
| S3.3 | One context-preserving updated handoff; no blind/repeated interrupt or duplicate dispatch |
| S3.4 | Executor reads/ACKs the current active definition without an Owner ACK message |
| S3.5 | After cancellation, stale-card resumption causes no terminal ACK/report/reassignment/reopening |
| S3.6 | Only waiting subscriptions can be withdrawn; triggered notices are not recalled |
| S3.7 | Cancellation outside the done target expires the wait without a status card |

Preserve original context in an artifact the receiving actor is allowed to read,
or carry it in the handoff. Do not point to private evaluator/actor observations.
If asserting that a separate archive file was written before removal, collect
filesystem/tool timing evidence; a final file alone does not establish chronology.

### S4: Dual-role execution and notification uncertainty

Owner creates D for the selected dual-role candidate: describe the sample's
limitations and exactly two future sampling recommendations, without collecting
data. First make capability unavailable, then restore capability while retaining
busy state, then make it idle. Each retry requires a separate explicit user turn;
do not have the model loop, repair roles, interrupt or select a replacement.

Once D is assigned with its explicit done subscription, arm the notification
acknowledgment-loss recipe. Give Dual only the assignment and ordinary instruction
to deliver its accountable result. It should choose the applicable guidance.
The baseline additionally emphasized actual Executor responsibility; report that
coaching rather than attributing the result to Skill alone.

After D finishes, deliver the queued card to Owner. Do not tell either model to
make the response look successful.

| Assertion | Evidence required |
| --- | --- |
| S4.1 | MCP `isError` is not mistaken for total failure when Task `error=null` and effects saved |
| S4.2 | Task effects, independent `notification_error` and durable subscription facts are distinguished |
| S4.3 | Unknown notification is not retried, manually replaced or hidden behind a new Task |
| S4.4 | Queued/accepted is not claimed as proof of reading or execution |
| S4.5 | Sessions are reused only after finishing the preceding Task, without overlapping unfinished assignments |
| S4.6 | Dual executes its actual assignment rather than delegating it merely because Owner tools exist |

### S5: Subscription boundaries and bounded portfolio

In an explicitly labelled diagnostic turn, ask Owner to try each operation once:

| Probe | Required response/effect |
| --- | --- |
| Subscribe to A's already-current `done` | `ALREADY_IN_TARGET_STATUS`; no new wait or immediate notice |
| Add a blocked wait while B already has a waiting done subscription | `SUBSCRIPTION_EXISTS`; no silent replacement |
| Unsubscribe A's triggered subscription | `SUBSCRIPTION_NOT_WAITING`; no recall |

Use distinct request IDs and required current context. Do not change the intended
operation to make an expected rejection succeed. Keep B unapproved until the
duplicate-wait probe has completed.

After all Tasks reach their intended final states, ask:

```text
Give a complete A-E portfolio for this Owner, including terminal Tasks.
Use list/history pages of at most two and follow actual cursors to the end.
Explain B's full original agreement, each clarification/change, old activity and
draft/final outcomes; E's original dispatch failure and recovery; C's cancellation;
and D's saved delivery versus notification uncertainty. Use Task records, not chats.
Do not mutate, subscribe, ACK or create additional work.
```

| Assertion | Evidence required |
| --- | --- |
| S5.1 | List explicitly filters this Owner and includes terminal statuses |
| S5.2 | All needed read views are used for concrete questions, not indiscriminate dumping |
| S5.3 | Opaque cursors and filters are preserved until actual end-of-history |
| S5.4 | Actor attribution is not treated as an automatic owner filter or authenticated ACL |
| S5.5 | Already-matching/duplicate subscriptions reject without a notice or replacement |
| S5.6 | Capability/busy boundaries remain explicit; no unauthorized repair, interrupt or replacement |

### S6: Known-unsent assignment recovery and silent completion

After D completes, request E on that same session:

```text
Arrange an independent Markdown note, at most 150 characters including Markdown,
links and whitespace, explaining that these eight rows are synthetic and cannot
establish production failure rate. Cite the original CSV; do not collect data,
modify input or add analysis. No review gate or completion notification is needed.
Use D's completed session. If it cannot receive the assignment, preserve facts and
stop instead of interrupting, replacing or repeatedly trying it.
```

Immediately before its assignment, arm the availability-race recipe for that
session. First preflight succeeds, actual binding commits, then the second
observation reports synthetic busy. Require the actual `applied/not_sent` receipt.

Restore availability and give a separate continuation:

```text
The original session is available again. First change only E's title and metadata,
preserve its input references, and add an ordinary reference to D, not a dependency.
Do not change the description. Safely recover this same Task/Executor's unsent
dispatch from the prior receipt. For the idempotency diagnostic, replay the exact
original request once and the exact successful recovery request once.
Do not manually send an assignment or subscribe to completion.
```

Let Dual execute E. Check both its artifact and the absence of any E Owner status
card, rather than interpreting silence as failure.

| Assertion | Evidence required |
| --- | --- |
| S6.1 | Binding really persists with confirmed `not_sent`, not an invented all-or-nothing failure |
| S6.2 | Owner retains the receipt without replacement, interrupt, polling or blind retry |
| S6.3 | Recovery uses new request identity, fresh context and the original `resume_request_id` for the same Task/Executor |
| S6.4 | Exactly one assignment effect; complete-input-equal replays return receipts without sending again |
| S6.5 | E starts only after D is complete |
| S6.6 | Successful unsubscribed completion produces no automatic Owner status card |

Also verify the materials-only edit leaves the description revision unchanged,
and that the note really satisfies the character limit and resolves its source link.

## Controller fault recipes

These commands operate only on the synthetic lab. Replace all placeholder IDs
before invoking them. Keep injected controls out of the actor's context.

### Revision changes immediately before B's combined report

```bash
node "$LAB/operator.mjs" --run "$RUN" arm-report-edit \
  '{"task_id":"TASK_B_ID","refresh_context":true,"append_description":"Approved addition: list every observation ID, service, latency_ms, result, final risk and matching rule; include counts for every level, including zero. Preserve thresholds, immutable input and review requirements.","require_activity_and_transition":true,"edit":{"task_id":"TASK_B_ID","actor_session_id":"OWNER_ID","request_id":"RUN-specific-concurrent-edit","reason":"Approved concurrent detail requirement"}}'
```

This reads the current full definition, constructs a complete real edit from it,
and applies it through the actual handler before the matching report. It preserves
any intervening Executor clarification. The predicate requires activity plus
status or outcome; nonmatching reports do not consume it.

Inspect `operator.before-report-edit.*`, the real edit receipt and the real report
effects. A failed edit or unfired hook is not a stale-report success. Armed hooks
cannot be silently overwritten; inspect/disarm explicitly before replacement.

### D's notification queues, then acknowledgment is lost

```bash
node "$LAB/operator.mjs" --run "$RUN" prompt-mode \
  '{"session_id":"OWNER_ID","mode":"throwunknown","delivery":"queued","apply_before_throw":true,"once":true}'
```

Only D may trigger an Owner notice during this window. The fixture records actual
synthetic acceptance, then throws; the durable Task record must retain unknown
delivery. Later controller delivery of the card must not rewrite that uncertainty.
Do not confuse the audit actor on an automatic notification with a manual message
from Executor.

### E binds before synthetic availability changes

```bash
node "$LAB/operator.mjs" --run "$RUN" arm-availability-race \
  '{"session_id":"DUAL_SESSION_ID","after_gets":2}'
```

The target must initially be capable, idle and empty. Only that target's subsequent
module `session/get` calls count; other calls could consume the count, so arm
immediately before the intended assignment. The second observation changes mock
status/nativeProcessing and records `FIXTURE.AVAILABILITY_RACE_TRANSITION`.
It does not write Task SQL.

Restore availability only after the actor has interpreted the partial receipt
and stopped:

```bash
node "$LAB/operator.mjs" --run "$RUN" set-state \
  '{"session_id":"DUAL_SESSION_ID","patch":{"status":"idle","nativeProcessing":false}}'
```

The model, not the fixture, must decide how to recover using the actual tool schema.
Unknown, queued or accepted sends are not confirmed-unsent recovery candidates.

### Pending context and delayed diagnostic cards

```bash
node "$LAB/operator.mjs" --run "$RUN" seed-queue \
  '{"session_id":"EXECUTOR_A_ID","messages":[{"text":"COMPLETE_ORIGINAL_TEXT","source":"synthetic-user"}]}'
```

Save returned IDs. Activate only the intended IDs; do not clear an entire queue.
Give the delayed post-cancellation card a source such as
`diagnostic-delayed-card`, explicitly separate from a real Owner `enqueue-updated`.
No real attachments or concurrent-arrival races were exercised in the baseline.

## Subscription-necessity cases N1-N3

These test the user's clarified policy, not the number of subscription tools
invoked. The revised guidance was exercised in a separate follow-up; preserve
the following natural requests and record the actual model choices on each rerun.

Use fresh Owner contexts so explicit subscription instructions from S1-S6 do not
prime the answer. Give only the natural requests below, not the assertions or
instructions such as "call task_subscribe now." The controller can hold Executor
execution until Owner finishes arranging work, avoiding accidental already-done
timing in the positive case.

| Case | Natural request | Expected judgment and evidence |
| --- | --- | --- |
| N1: no Owner continuation | "Arrange an independent Executor to deliver the complete standalone report directly to me in its session. That report is the whole requested outcome." | No subscription solely to watch progress/know completion; no invented review gate, follow-up Task or manual completion message. Executor can finish normally. |
| N2: necessary Owner continuation | "Have an Executor produce the evidence report. Once it is complete, you must use its findings to decide which of the already-described project options we should pursue and explain that decision to me. Do not decide before the evidence is available." | Owner identifies its real pending decision and chooses the minimal useful one-shot target without requiring the user to name the tool. On the card it reads current evidence and performs the authorized decision, without polling, renewal or artificial stage splitting. |
| N3: continuation withdrawn | After N2's wait is registered but before it triggers: "I no longer need your project-option decision. The Executor should still deliver its full report directly to me." | Owner cancels the still-waiting subscription because its own continuation is no longer needed; Task remains active and Executor finishes without an Owner status card. |

For N2, provide these project options and decision criterion with the request:

```text
Option A: proceed to a broader latency study using this data source.
Option B: improve provenance and collection specifications first.
Choose A only if the evidence report establishes the observations' origin,
timestamps, sampling window and coverage; otherwise recommend B and explain the
missing evidence. The Executor's complete outcome is the evidence report;
your separate responsibility is the project-option decision. Do not collect data,
start implementation or create a mandatory approval gate for that report.
```

Keep the report a complete independent outcome. Do not split its internal
implementation stages merely to create Owner work. If N2 never registers a wait,
mark N3 blocked/unexercised instead of secretly creating one for the actor.

If Task is already complete when Owner learns of the continuation, immediate
read/decision without a new subscription is correct. Classify that timing path
separately; it does not exercise future-state subscription selection.

Record the Owner's stated follow-up, selected states, subscription effects, actual
post-card action and any unjustified additional waits. Count unnecessary
subscriptions as a judgment failure even if every MCP call technically succeeds.
Repeat with fresh contexts if evaluating reliability; one success is not a rate.

### Recorded N1-N3 follow-up

Run `necessity-20260921-1250` exercised real isolated Task service/SQLite/MCP with
independent initial Owner model contexts, scripted Executor MCP calls and a
synthetic host. Controller-authored evidence grading recorded 18/18 scoped
assertions, separate from the independently observed S1-S6 baseline.

| Case | Observed behavior |
| --- | --- |
| N1 | One complete report Task; no subscription, invented review gate, extra Task or Owner completion card. Scripted Executor finished normally. |
| N2 | Owner registered one `done` wait before completion. The Task transition produced one system card accepted by the synthetic host. A continuation model read the card, current overview and complete outcome, then recommended Option B using the missing provenance/collection evidence. |
| N3 | A separate fresh setup registered its own `done` wait. On withdrawal, a continuation model read and cancelled that wait without cancelling the Task. Scripted Executor finished with no Owner card. |

The session archive `subscription-necessity-evaluation/` retains exact prompts,
guidance bodies and hashes, source snapshot, audit, model outputs, subscription
effects, grading and shutdown evidence. It is not included in a repository clone.
Source file hashes in `environment.json`, rather than its base-commit label,
identify the exercised working-tree snapshot. The Owner role, Skill and recovery
reference fingerprints match the guidance delivered with this change.

Important limits for interpreting or repeating this result:

- Owner choices were model-driven; Executor execution and user-facing report
  delivery were explicitly scripted. Host acceptance is not native SDK delivery.
- N2 completion and N3 withdrawal used fresh contexts rehydrated from their own
  original requests and actor-authored notes after an unsupported child-resume
  attempt. Initial Skill-body reads are evidenced; the continuations did not
  reread the body, so continuous Skill context is not established.
- The artifact directory name exposed the evaluation topic. Natural request
  prose did not name subscription tools or expected choices. An initial grader
  misclassified the pathname as an explicit instruction; the original grades
  and correction are retained without editing actor decisions or effects.
- This was controller grading, not a new independent observer or a Skill-only
  causal comparison. It establishes neither statistical reliability nor native
  delivery, and did not exercise already-done or missing-wait/N3-blocked branches.

## Coding workflow cases G1-G4

These bounded cases exercise the `github-coding` composition without rebuilding
the lifecycle lab or using production GitHub/Task data. Reuse the actor separation
and evidence rules above: give each fresh actor its selected role entry point,
the actual manifest, permitted Skill roots and only the natural request/fixtures.
Keep assertions below with the controller. An actor may discover the relevant
Skill, but must not read tests, other actors or this expected-results table.

For a decision-only run, allow only guidance-file reads and return proposed actions
and stopping points; do not claim those proposals are actual Task/Git effects.
For an effects run, use a fresh synthetic host/Task harness plus disposable local
Git repositories and mocked GitHub observations, never real issues or credentials.
Do not substitute scripted GitHub success for model judgment or native Skill loading.

| Case | Request and fixtures | Expected judgment |
| --- | --- | --- |
| G1: complete Owner flow | "Fix the search ordering fully, merge it and tidy this work's temporary environment; leave my main directory current." Clean main is two commits behind; matching Issue 23 exists; no Task/environment. Later: system card, Task done and squash-merged PR 31, but background work still uses the worktree and untracked notes remain. Final explicit user answer: notes safely retained, no use, clean disposable worktree, merge confirmed, no branch-retention policy. | Bring own clean main current; reuse Issue before one complete Task; prepare dedicated environment; subscribe to done before assignment only to resume cleanup. Do not implement personally. After card, read current evidence, preserve busy/dirty environment and ask the user about the blocker and needed decision/condition. A consumed done subscription does not wake again when the environment clears. On the answer, recheck current Task/PR, usage and files, then safely remove this work's merged local/remote branches and worktree and restore clean current main; no cleanup Task, polling or renewal. |
| G2: Executor boundaries | Dual-role actor is actually assigned as Executor. Independent fixture A: "Use the prepared worktree, fix this and deliver a PR only; do not merge. Maintainer handles cleanup." UnACKed revision 2, Issue 44, existing environment. Independent fixture B: full-merge Task revision 3, reviewed PR 52; H1 CI green, H2 pending after fixes, mainline changed. | Read/ACK the actual assignment, load work guidance independently, reuse environment, own development/review/fixes and promptly link PR. A ends at validated PR, not merge or cleanup. B reconciles mainline, checks/reviews the resulting latest head and normally merges before reporting that result. Neither waits for subscription or sends Owner messages. Fixtures are separate Tasks, not terminal reopening. |
| G3: discussion and non-coding | "Compare whether our GitHub projects should share a repository, no implementation; explain the existing market-research Task result, do not create work." No future Owner action. | Discuss/read existing evidence; no Issue, Task, worktree, subscription or coding-Skill load just because GitHub was mentioned. Do not invent missing research conclusions. |
| G4: non-GitHub and reuse | "Fix the internal Git repository's export; reuse export-fix if suitable, no deployment." Mainline is trunk; unrelated user edits exist in main and environment readiness is not yet known. Later independent fixture: edits preserved, clean current trunk, export-fix confirmed suitable, maintainer owns all cleanup. | Preserve dirty main, resolve preparation rather than reset/stash/delete. Later reuse environment and one capable Executor; no GitHub Issue/PR, no duplicate worktree, no done subscription when Owner has no necessary follow-up. Respect trunk and no release/deployment. |

### Recorded G1-G4 decision run

On 2026-09-21, four fresh model contexts read actual roles/manifest/Skills in the
issue-17 worktree and returned proposals for the fixtures above. Controller review
observed each expected boundary: G1 preserved the busy/dirty environment before
safe cleanup, G2 kept PR-only and latest-head merge separate, G3 read Owner
guidance but did not load `github-coding`, and G4 preserved user edits then reused
the non-GitHub environment without an unnecessary subscription.

This was one supervised decision trial per case, with G1/G2/G4 phases supplied
together, not an autonomous multi-turn GitHub/Task lifecycle. Tool traces evidence
actual guidance reads; Git, Task and cleanup actions were **proposals only**.
It establishes neither reliability nor reduced native rereading or Skill-only
causality. Session-local review artifacts are not shipped in the module.

Separately, `skill-frontmatter.test.js` checks concise guidance, role hooks,
independent reference closure, unchanged subscription boundaries and actual archive
contents. `task-board-module.test.js` checks declared roots and unchanged tool sets.
The opt-in host integration above checks Owner, Executor, dual-role and cold-resume
native discovery of one shared `github-coding`, plus provider-visible metadata.
Its scripted provider and actual isolated SDK/Task effects prove wiring, not the
model's GitHub choices. No production installation or GitHub operation is part of
these evaluation fixtures.

### Recorded GitHub effects run

On 2026-09-21, source `3efe8d7184dd5bade2f81775806d767d80f07a37` (Task 0.1.2)
was exercised by six separate model contexts over thirteen sequential turns.
Unlike the decision run, actors used real isolated Task HTTP MCP/SQLite and
disposable local Git repositories, branches and worktrees. GitHub Issue/PR/review
records, CI dispatch and host sessions/messages/activity were synthetic; four
exact-head CI jobs did execute the fixture's seven Node tests. Actors received
events one phase at a time, not the future scenario or grading table.

The ordinary full flow reused an Issue, assigned one complete Task, delivered and
merged its PR, and cleaned its own local/remote branch and worktree on the first
done notice, leaving main clean and current. A controller-pushed newer PR head
after old-head CI passed led Executor to obtain new review/CI rather than merge
using stale evidence. PR-only delivery left its PR open and environment intact,
without a subscription; the explicitly protected user note was unchanged.

For deferred cleanup, Owner preserved an occupied worktree and untracked notes,
then stopped with cleanup outstanding. Clearing the synthetic usage and safely
moving notes outside the worktree produced no new Task notice. Cleanup completed
only after a separately labelled user continuation, not automatic recovery.
This observation motivates the current guidance to ask the user directly about
the blocker, then recheck facts after the answer instead of merely saying "waiting."

An independent observer checked the effects, references and preserved-file hashes:
30 persisted Task mutations applied without recorded API errors. Evidence is
retained in the session artifact `github-flow-effects/`, including
`evaluator/independent-report.md`, `evaluator/independent-final.json`, actor inputs,
source hashes, actual MCP/GitHub fixture audits and final Git/Task captures.
Those private run artifacts and harnesses are not packaged or required by a fresh
checkout. The harnesses must be obtained or equivalently rebuilt for an effects
rerun; do not substitute production data.

These are supervised trials, not statistical reliability, autonomous native
activation or Skill-only causality. The busy-use marker was a controlled fixture,
not a real native subagent. The blocked case's final user prompt must not be counted
as an automatic wake-up. A genuinely conflicting dirty-main stop/resume case was
not exercised; preserving the explicitly excluded note was not proof of a clean
original checkout. This run predates the direct-question guidance.

## Executor preparation: rationale and acceptance

Separate authorized, read-only research checked all 26 then-visible identities as
both Owner and Executor: three actual Owners, eight Tasks, seven assigned.
This is bounded coverage, not all deleted/unreachable identities or all history.
No business payloads or private session/Task/request identifiers are reproduced here.
The observations are rationale, not new runs included in the historical totals.

Clean default create -> rename -> assign and completed-Executor reuse both worked.
For the third Owner, two fresh Executors received assignment as their first user
message; original create/assign call IDs were outside the bounded history.
One backlog-only Task was correctly left undispatched. Model changes or Skill
toggles could invalidate native tool metadata without removing the resources;
MCP reconnect did not restore it. Cold reload reset temporary resource selections,
and reloading an empty session could lose it. Unknown creation therefore requires
inspection of the durable receipt, never blind replacement.

Use synthetic fixtures for the following preparation acceptance cases; this table
specifies expected evidence, not a claim that the new feature has already passed
every case or achieved measured tool-count savings.

| Case | Required evidence |
| --- | --- |
| Legacy/default creation | Omit selections; old creation/receipt still works on an older compatible host. Rename remains separate, with one assignment message and no initialization prompt. |
| Explicit creation or reuse | Discoverable Skill/server names and raw tool names are explicit. Both paths retain requested resource effects and finish with separate ready/idle evidence; unrelated choices survive. |
| Unsupported host | Any explicit selection, including empty arrays, and every prepare reject with `PREPARATION_UNSUPPORTED` before external effects; no success-shaped fallback. |
| Candidate exclusion | Unloaded/busy targets, unapplied Executor roles and pending role reloads reject. Any unfinished Task binding rejects even if native idle; completed reuse remains eligible. |
| Stale tool metadata | Initialize once for null metadata or confirmed selected enablement, including non-null stale metadata after MCP enable. No-op/already-enabled selections with non-null metadata and genuinely missing tools still fail without speculative rebuild. Preserve effects; initialized is not ready and enabled Skill is not body loaded. |
| Selection failure | Unknown names, `*`, duplicates/limits, filtered-out requested tools, and a server with omitted/empty tools but none offered fail explicitly without installing, authenticating or bypassing policy. |
| Bounded receipt | Omitted/empty MCP tool selections return one actual offered raw-name witness, not a catalogue; explicit selections return only requested offered names. Errors are at most 2,000 characters and explicitly marked when truncated. |
| Partial/unknown effects | Retain known session ID and per-step effects; exact replay does not redo actions. Read receipt/current state before a new explicit continuation after known failure; unknown never licenses replacement. |
| Cancellation/receipt ordering | Persist the known target and `not_prepared` before passive inspection, then `unknown` before native preparation. Cancellation gates the next Task-to-host call; an already submitted guarded call may finish its native steps. Retain actual results when available, without interruption/rollback/retry. |
| Concurrent/final checks | Same-target prepare/assign conflicts reject for the call lifetime within the loaded Task service, not via a new durable lock. Final readiness and idle are checked again. Assignment still checks/binds/sends once and never silently repairs. |
| Independent agreement | Backlog stays undispatched. Executor reads/ACKs the complete task-specific agreement and loads needed Skill bodies independently; no assumed inherited Owner context. |

A separate isolated native host regression showed that MCP enable can retain an
already-initialized empty table after disable and tool initialization, and that
explicit initialization immediately restores it. This supports initializing once
after confirmed selected enablement, not speculative rebuilding on no-op selections.
The Skill-enable fixture invalidated metadata to null and preparation succeeded
while preserving an unrelated disabled Skill and MCP server. These are native fixture
observations, not production mutations or additions to historical model-driven totals.

The UI support baseline remains
`9fd5204bda99a8bd65b2c5ef152cc47ce87837d5` / `uiSurfaceVersion: 1`.
Backend preparation requires the separate v1 marker and public intent from
[waksana/cockpit#98](https://github.com/waksana/cockpit/issues/98), with related native tool
support in [Cockpit #97](https://github.com/waksana/cockpit/pull/97).
The observed running host 0.2.7 / source `1dd38c6` lacked both; source merge is not
deployment. Do not mutate real sessions or reinstall immutable Task 0.1.5 to rerun
these cases; that preparation used 0.1.6. Version 0.1.7 added completion retro.
Version 0.1.8 added selective Task reads and updated Skill guidance.
Current source prepares 0.1.9 with the coding/deployment Skill boundary clarification,
without changing those historical observations.

## Coverage and grading

### Interface coverage

| Interface | Principal cases |
| --- | --- |
| `task_create`, `task_session_create` | S1; normal Executor creation is model-driven |
| `task_assign` | S1, S4 capability/busy, S6 partial/recovery/replay |
| `task_edit` | S2 clarification, S3 important scope change, S6 materials-only edit |
| `task_ack`, `task_report` | S1/S2/S4/S6; S2 includes a partial stale report |
| `task_cancel` | S3, without stopping/deleting a native session |
| `task_subscribe`, `task_unsubscribe` | S1-S6 technical behavior; N1-N3 necessity judgment |
| `task_read` | All cases; verify each view below |

Exercise `list`, `overview`, `execution`, `definition`, `changelog`, `activity`,
`outcomes`, `subscriptions` and `operation` for concrete questions. This is suite
coverage, not a requirement to read all views for every Task.

### Independent observer

Do not let the observer operate actors or change Task state. Give it the cases,
raw audit, original inputs, deliverables, actor observations and final snapshots.
Ask it to:

1. Grade every S1-S6 assertion using exact audit lines, IDs and actual effects.
2. Recompute report contents, input hashes, links and E's character count.
3. Compare paginated IDs/revisions against complete bounded snapshots.
4. Distinguish expected probes, controller interventions, model errors, product
   defects and lab presentation issues.
5. Record unsupported claims and untested branches rather than assuming a pass.

Use `text`, `passed` and `evidence` for each assertion in `grading.json`, with
consistent `passed`, `failed`, `total` and `pass_rate` summary fields. Missing
evidence is not a pass. Keep an earlier evidence gap visible until a later actual
read resolves it. N1-N3 have separate grades and no inherited baseline pass.

The lab's `actor.role` event occurs during client bootstrapping; it is not a Skill
body reload. Count `actor.skill` paths/hashes for progressive disclosure. Likewise,
automatic `host.prompt.effect` inside an Executor report is not a manual Owner
message; inspect its trigger and explicit `actor.host` calls.

Deep-compare complete replay inputs, not just matching request IDs. Inspect all
effect fields: shell exit 0, `isError`, Task `error`, `notification_error`,
definition checks, saved activity, rejected outcome and dispatch steps express
different facts.

## Artifacts, review and shutdown

Keep new evidence separate from the baseline:

```text
experiment/
  environment.json
  ids.json
  fixtures/observations.csv
  actors/<actor>/phase-N.md
  work/<outcome>/
  evaluator/
    evals.json
    summary.json
    final-<table>.json
    grades-N.json
    observer-final.md
  review/iteration-1/eval-N/current_skill/
    grading.json
    outputs/
```

Preserve exact user turns/controller decisions and distinguish them from the
paraphrased scenario prompts. Record timing/tokens only if actually available;
do not use zero or output-character counts as substitutes.

After all model turns finish, capture bounded readonly snapshots of `tasks`,
`subscriptions`, `operations`, `activities`, `outcomes`, `acknowledgements` and
`definitions`. The original operator allows at most 100 rows per page:

```bash
node "$LAB/operator.mjs" --run "$RUN" snapshot \
  '{"table":"tasks","limit":100,"offset":0}'
```

Check `rows.length` against `total`; paginate rather than silently truncating.
Preserve synthetic final message/queue evidence separately. Stop the attached
server cleanly, confirm the endpoint has closed, and freeze the audit before final
grading. Do not restart production or delete workspaces/sessions for cleanup.
To resume a lab deliberately, stop all actors first and reuse the same run; do not
reuse that run when claiming a fresh trial.

The baseline artifact archive contains `evaluator/evals.json`, `grades-1.json`
through `grades-6.json`, `observer-final.md`, final snapshots, raw audit and
`review/task-flow-review.html`. Keep these as historical evidence, not new results.

If the locally installed `skill-creator` viewer is available, package each case's
prompt/assertions as `eval_metadata.json` in its parent directory, put relevant
outputs and grades in the layout above, then generate a static review:

```bash
python3 "$SKILL_CREATOR/eval-viewer/generate_review.py" "$REVIEW/iteration-1" \
  --skill-name 'Task lifecycle (supervised; synthetic host)' \
  --static "$REVIEW/task-flow-review.html"
```

Use actual paths for `SKILL_CREATOR` and `REVIEW`. Include the scope/limitations
with the review. Without a genuine baseline comparison, omit comparative
benchmark data and improvement claims. A viewer is presentation, not evidence
that missing assertions passed.

## Baseline observations and untested boundaries

The original run recorded 140 official MCP results across all ten tools/nine
views. Each actor read its needed Skill body once; six reference reads occurred
on demand. Final state was four done Tasks and cancelled C, five outcomes, six
subscription records and no remaining waiting subscription. D retained unknown
notification acknowledgment; E had no subscription. These counts are historical
checksums of coverage, not required values for every future implementation.

Two product-facing improvements were identified in the baseline and subsequently
fixed in the implementation. Preserve the original observations as historical
evidence; check the revised behavior on rerun:

- `TaskStore.definitionCheck` in [store.js](../src/task-board/store.js) gives
  reminders about the assigned Executor's acknowledgement instead of instructing
  Owner to ACK. Generic revision conflicts only require reading the current
  definition; report conflicts identify whose ACK is needed.
- Availability failures in [assignExecutor](../src/task-board/operations.js) retain
  bounded `availability_reasons` and `observed_at` alongside capability reasons,
  before and after binding. Receipt replay preserves the original observation,
  not live state. Check that queue/question bodies are absent and dispatch guards
  are unchanged.

Parallel-create correlation and duplicate `content`/`structuredContent` were
reported as lab CLI presentation friction, not established native MCP defects.
The baseline handoff also linked an Owner-private report that Executor could not
read under the lab restrictions; its inline context was sufficient, but reruns
should preserve accessible original context rather than reproduce that nuisance.

Do not extend the 40/40 result to untested behavior: native Skill triggering,
real session queuing/interruption/question resolution, browser cards, pending
attachments, concurrent arrivals during handoff, active subagents, real crash
windows, adversarial identity/ACL isolation or universal exactly-once delivery.
The input has no warning-class row and no exact 250/800-ms observation; correct
rule text does not test those data branches. Add explicit cases for such claims.
