import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function captureRuntime(env = process.env) {
  const fields = ['SERVICE_DELIVERY_SHA', 'SERVICE_DELIVERY_ARTIFACT', 'SERVICE_DELIVERY_REQUEST', 'SERVICE_DELIVERY_INSTANCE'];
  const managed = fields.some(name => env[name] !== undefined);
  if (managed && (!fields.every(name => typeof env[name] === 'string') ||
    env.SERVICE_DELIVERY_SHA.length !== 40 || !/^[a-f0-9]{40}$/.test(env.SERVICE_DELIVERY_SHA) ||
    env.SERVICE_DELIVERY_ARTIFACT.length !== 64 || !/^[a-f0-9]{64}$/.test(env.SERVICE_DELIVERY_ARTIFACT) ||
    !env.SERVICE_DELIVERY_REQUEST.trim() ||
    env.SERVICE_DELIVERY_INSTANCE.length !== 36 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(env.SERVICE_DELIVERY_INSTANCE))) {
    throw new Error('Invalid SERVICE_DELIVERY identity: supply all four fields with SHA40, artifact SHA256, nonempty request and UUID instance, or omit all four');
  }
  return Object.freeze({
    projectId: 'task',
    moduleApi: 1,
    version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
    sha: managed ? env.SERVICE_DELIVERY_SHA : null,
    artifactSha256: managed ? env.SERVICE_DELIVERY_ARTIFACT : null,
    requestId: managed ? env.SERVICE_DELIVERY_REQUEST : null,
    instanceId: managed ? env.SERVICE_DELIVERY_INSTANCE : randomUUID(),
    identitySource: managed ? 'delivery-environment' : 'unknown',
    authority: 'work-commander-runtime',
  });
}
