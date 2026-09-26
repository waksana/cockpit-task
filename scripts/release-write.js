import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// One invocation issues exactly one write request and never follows a redirect or retries.
export function writeGithub(hostname, path, body, contentType, {
  token = process.env.GH_TOKEN,
  request = httpsRequest,
  method = 'POST',
} = {}) {
  assert.ok(token, 'GH_TOKEN is required for Release writes');
  return new Promise((resolveWrite, reject) => {
    const req = request({
      hostname,
      path,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'cockpit-task-release',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': contentType,
        'Content-Length': body.length,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('GitHub write response aborted')));
      response.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GitHub write HTTP ${response.statusCode}: ${responseBody.toString('utf8')}`));
        } else {
          resolveWrite(responseBody);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error('GitHub write timed out')));
    req.end(body);
  });
}

function checkRepository(repository) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  return repository;
}

function checkId(id) {
  assert.match(id, /^[1-9]\d*$/, 'GitHub object ID is invalid');
  return id;
}

export async function releaseWrite(command, args, {
  repository = process.env.GITHUB_REPOSITORY,
  write = writeGithub,
} = {}) {
  const base = `repos/${checkRepository(repository)}/releases`;
  if (command === 'create') {
    const [tag, sha, ...extra] = args;
    assert.ok(tag && sha && !extra.length, 'Usage: release-write.js create TAG SOURCE_SHA');
    assert.match(tag, /^v\d+\.\d+\.\d+$/);
    assert.match(sha, /^[a-f0-9]{40}$/);
    const body = Buffer.from(JSON.stringify({
      tag_name: tag,
      target_commitish: sha,
      draft: true,
      prerelease: false,
      name: `Cockpit Task ${tag}`,
      body: await readFile(new URL('../docs/release-notes.md', import.meta.url), 'utf8'),
      generate_release_notes: true,
    }));
    return write('api.github.com', `/${base}`, body, 'application/json');
  }
  if (command === 'upload') {
    const [releaseId, file, ...extra] = args;
    assert.ok(releaseId && file && !extra.length, 'Usage: release-write.js upload RELEASE_ID FILE');
    const bytes = await readFile(resolve(file));
    assert.ok(bytes.length > 0, 'Release asset is empty');
    return write(
      'uploads.github.com',
      `/${base}/${checkId(releaseId)}/assets?name=${encodeURIComponent(basename(file))}`,
      bytes,
      'application/octet-stream',
    );
  }
  if (command === 'publish') {
    const [releaseId, ...extra] = args;
    assert.ok(releaseId && !extra.length, 'Usage: release-write.js publish RELEASE_ID');
    return write(
      'api.github.com',
      `/${base}/${checkId(releaseId)}`,
      Buffer.from(JSON.stringify({ draft: false, prerelease: false, make_latest: 'true' })),
      'application/json',
      { method: 'PATCH' },
    );
  }
  throw new Error('Usage: release-write.js create|upload|publish ...');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  process.stdout.write(await releaseWrite(command, args));
}
