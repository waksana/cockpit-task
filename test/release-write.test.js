import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { writeGithub } from '../scripts/release-write.js';

for (const outcome of ['lost response', 'HTTP 500', 'HTTP 307', 'timeout', 'aborted response']) {
  test(`Release write transport does not retry ${outcome}`, async () => {
    let attempts = 0;
    let accepted = 0;
    const request = (options, onResponse) => {
      attempts++;
      assert.equal(options.hostname, 'uploads.github.com');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Length'], 9);
      const req = new EventEmitter();
      req.destroy = error => req.emit('error', error);
      let timeout;
      req.setTimeout = (_, callback) => { timeout = callback; };
      req.end = body => {
        accepted++;
        assert.deepEqual(body, Buffer.from('synthetic'));
        if (outcome === 'lost response') req.emit('error', new Error('ECONNRESET after acceptance'));
        else if (outcome === 'timeout') timeout();
        else {
          const response = new EventEmitter();
          response.statusCode = outcome === 'HTTP 500' ? 500 : 307;
          onResponse(response);
          if (outcome === 'aborted response') response.emit('aborted');
          else response.emit('end');
        }
      };
      return req;
    };
    await assert.rejects(writeGithub(
      'uploads.github.com',
      '/synthetic',
      Buffer.from('synthetic'),
      'application/octet-stream',
      { token: 'synthetic-token', request },
    ));
    assert.equal(attempts, 1);
    assert.equal(accepted, 1);
  });
}

test('Release workflow uses only the single-request helper for writes', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /gh release create|gh api --method (?:POST|PATCH)/);
  assert.match(workflow, /release-write\.js create/);
  assert.match(workflow, /release-write\.js upload/);
  assert.match(workflow, /release-write\.js publish/);
});
