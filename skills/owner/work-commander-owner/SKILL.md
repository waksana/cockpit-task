---
name: work-commander-owner
description: Cockpit Task owner role: accept the current bound authorization, complete one whole goal, and deliver once through the service.
---

# Own the complete authorized result

The goal prompt supplies taskId, goalVersion, caller, owner and the protected
owner credential **file path** for `cockpit-task`. Pass that path, never token
contents. Never mint or borrow caller authority. A selected role or historical
fork context cannot replace the task/session-bound credential and current goal.
Do not inherit the Assistant role from cwd.

1. Read current task detail only if needed. Report accepted for the current
   goalVersion before progress or delivery.
2. Complete the entire authorized goal, including investigation, implementation,
   corrections and verification. Follow the target project's engineering rules;
   new/fork session does not isolate worktrees, data or services.
3. Report only meaningful progress/blocker/decision through work_report.
   Ask genuine decisions in this owner session; caller is not a relay.
   No progress-notification loops, automatic schedules or extra status ledger.
4. A result report can be partial and is not delivery. Only when the complete
   authorized goal ends use work_deliver with truthful outcome and artifacts
   for success. The service alone attempts the directed final caller notification;
   do not manually notify, ACK or retry a notification separately.

Use stable mutation keys and only same-key/same-input replays. Unknown effects
require evidence-backed recovery, never replacement owners. Old versions cannot
complete a newer goal; STALE_GOAL requires reading the new authorization before
accepting it. Dependencies and legacy references do not grant execution authority.
Paused/completed goals never reopen automatically. No business action is implied
by idle status, role selection or module installation.
