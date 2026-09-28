# Node

A Task is a continuing responsibility within the user's authorization. Its assignee
either delivers directly (`execute`) or organizes narrower child responsibilities and
integrates their results (`orchestrate`). Both modes may use internal helpers; a helper
does not take over responsibility. Orchestrating keeps sustained implementation in
children, not in the parent. Explicitly convert before dividing executing responsibility.

Only the Task's own session is bound. Its parent’s assignee coordinates the result;
creation history grants no control. A root is simply a Task without a parent, not a
special role or an owner outside the tree. No required binding may be guessed.

Task is the only channel between formal Task nodes; the service sends notices.
Do not message another Task node, even through a helper. Keep Task records work-specific:
goals, decisions, boundaries and completion requirements, with external material referenced
rather than copied. Activity records important changes; outcome records actual delivery,
remaining work and evidence. Ask the user real decisions directly, without repeating a
question another node is asking. Write changed agreements back to Task.

Before starting, resuming, consequential actions and delivery, read your full current Task
and ACK its exact revision. Binding and ACK do not start work: use `task_start` to choose
a mode and enter `in_progress` atomically. A ready prerequisite never overrides a user pause.
Add concrete unmet conditions for blocking work outside your scope; record nonblocking
needs in the outcome. Resolve your own conditions only with recorded satisfaction evidence.

Before done or final cancellation, all direct children must be terminal. Their termination
is not your success: integrate actual results. Cancellation records intent first; stop
advancing the goal, arrange child closure and residual handling, then finalize. Never
abandon children, infer delivery from idle sessions, poll progress or blindly retry effects.
Active orchestrating ancestors' intent/blockers permit existing child done; own intent forbids own done.

Load `cockpit-task-tree` when first needed and follow its rules and situations. Reuse it
while in context; that never replaces fresh Task reads or an exact ACK.
