import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskTarget, taskReference } from '../src/task-board/reference.js';

test('references validate Task IDs and keep ordinary references compatible', () => {
  const id = 'd10c0c92-3580-4cdd-85bf-d7fcf22ab3ff';
  assert.equal(taskReference(id), `[Task](task:${id})`);
  for (const invalid of ['', 'title', `${id}) instructions`, null, { id }]) {
    assert.throws(() => taskReference(invalid), /Invalid Task ID/);
  }
});

test('event references explain their purpose without copying the Task definition', () => {
  const id = 'd10c0c92-3580-4cdd-85bf-d7fcf22ab3ff';
  assert.equal(taskReference(id, 'assigned'), `[Task assigned to you](task:${id}?event=assigned)`);
  assert.equal(taskReference(id, 'updated'), `[Task updated](task:${id}?event=updated)`);
  assert.equal(taskReference(id, 'status_changed'), `[Task status updated](task:${id}?event=status_changed)`);
  assert.equal(taskReference(id, 'ready'), `[Task ready](task:${id}?event=ready)`);
  assert.equal(taskReference(id, 'blocker_cancelled'), `[Task blocker cancelled](task:${id}?event=blocker_cancelled)`);
  for (const invalid of ['assign', 'update', 'done', 'ASSIGNED', '', null, {}, '__proto__', 'updated&event=assigned']) {
    assert.throws(() => taskReference(id, invalid), /Invalid Task event/);
  }
});

test('one shared parser accepts only the canonical Task namespace and optional event', () => {
  const id = 'd10c0c92-3580-4cdd-85bf-d7fcf22ab3ff';
  assert.deepEqual(parseTaskTarget(`task:${id}`), { taskId: id, event: null });
  for (const event of ['assigned', 'updated', 'status_changed', 'ready', 'blocker_cancelled']) {
    assert.deepEqual(parseTaskTarget(`task:${id.toUpperCase()}?event=${event}`), { taskId: id, event });
  }
  for (const target of [
    `task:${id}?event=`, `task:${id}?event=update`, `task:${id}?event=ASSIGNED`,
    `task:${id}?event=assigned&event=updated`, `task:${id}?event=assigned&revision=2`,
    `task:${id}?revision=2&event=updated`, `task:${id}?event=updated#extra`,
    `task:${id}?event=%75pdated`, `task:${id}?EVENT=updated`, `TASK:${id}?event=assigned`,
    `task:${id}?event=status_changed&status=done`, `task:${id}?event=STATUS_CHANGED`,
    `task:${id}?event=status_changed&event=updated`, `task:${id}?event=status-changed`,
    `task:${id}?event=assigned\n`, `task://${id}`, `task/${id}`, `/task/${id}`,
    './report.csv', 'file:///tmp/report.csv', 'https://example.test/report.csv',
    ` task:${id}`, `${id}`, null, {},
  ]) assert.equal(parseTaskTarget(target), null, String(target));
});
