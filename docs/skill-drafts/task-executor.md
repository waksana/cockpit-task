# Executor: historical design entry

The principle-based Executor design has been incorporated into the active
[cockpit-task-executor Skill](../../skills/cockpit-task-executor/cockpit-task-executor/SKILL.md).
Its self-contained references are the current operational guidance; this historical
path is not a second Skill, discovery root or alternate set of instructions.

The old executing owner maps to this Executor. Its lifetime goal binding and
terminal continuation mechanisms are not restored: one unfinished Task at a time,
with no reassignment or terminal reopening.
See the [collaboration documentation](../task-tools-skills.md) for the concise
legacy mapping and publication boundaries.

Source inclusion and packaging do not imply installation into an existing session
or a production deployment.
