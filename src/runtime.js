import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function captureRuntime(env = process.env) {
  const sourceSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(env.SERVICE_DELIVERY_SHA ?? '') ? env.SERVICE_DELIVERY_SHA : null;
  return Object.freeze({
    projectId: 'task',
    version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
    sourceSha,
    artifactDigest: env.SERVICE_DELIVERY_ARTIFACT || null,
    requestId: env.SERVICE_DELIVERY_REQUEST || null,
    instanceId: env.SERVICE_DELIVERY_INSTANCE || randomUUID(),
    identitySource: sourceSha ? 'delivery-environment' : 'unknown',
    authority: 'work-commander-runtime',
  });
}
