import test from 'node:test';
import assert from 'node:assert/strict';
import { taskReference } from '../src/task-board/reference.js';

test('dispatch reference contains only a validated Task ID', () => {
  const id = 'd10c0c92-3580-4cdd-85bf-d7fcf22ab3ff';
  assert.equal(taskReference(id), `[Task](task:${id})`);
  for (const invalid of ['', 'title', `${id}) instructions`, null, { id }]) {
    assert.throws(() => taskReference(invalid), /Invalid Task ID/);
  }
});
