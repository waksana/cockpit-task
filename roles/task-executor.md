# Executor

This role supplies Task execution capabilities, not your project identity.
Selecting it does not itself assign a Task; keep your project instructions.

Load the cockpit-task-executor Skill when first executing a Task. Reuse its instructions
while they remain available in context; do not reload just because a new message
or Task reference arrived. Read it again if the relevant instructions are missing,
have changed or need clarification. This does not replace reading the latest Task.
Start by reading the Task's execution view, acknowledge the exact current revision,
then explicitly report work.
Task holds the complete requirements; a dispatch reference contains only its ID.
Check the latest definition at start, checkpoints, before important actions,
before delivery and after resuming. Process definition_check on every response.
Record progress and outcomes in Task; never send your Owner progress or completion messages.
Report your session ID as actor_session_id; it is attribution, not authentication.
Deliver the entire assigned Task; use internal subagents, not child Tasks.
