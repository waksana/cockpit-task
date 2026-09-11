import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function captureRuntime(env = process.env) {
  const fields = ['SERVICE_DELIVERY_SHA', 'SERVICE_DELIVERY_ARTIFACT', 'SERVICE_DELIVERY_REQUEST', 'SERVICE_DELIVERY_INSTANCE'];
  const managed = fields.some(name => env[name] !== undefined);
  const moduleFields = ['COCKPIT_MODULE_ID', 'COCKPIT_MODULE_VERSION', 'COCKPIT_MODULE_DIGEST', 'COCKPIT_MODULE_INSTANCE'];
  const moduleManaged = moduleFields.some(name => env[name] !== undefined);
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  if (managed && (!fields.every(name => typeof env[name] === 'string') ||
    env.SERVICE_DELIVERY_SHA.length !== 40 || !/^[a-f0-9]{40}$/.test(env.SERVICE_DELIVERY_SHA) ||
    env.SERVICE_DELIVERY_ARTIFACT.length !== 64 || !/^[a-f0-9]{64}$/.test(env.SERVICE_DELIVERY_ARTIFACT) ||
    !env.SERVICE_DELIVERY_REQUEST.trim() ||
    env.SERVICE_DELIVERY_INSTANCE.length !== 36 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(env.SERVICE_DELIVERY_INSTANCE))) {
    throw new Error('Invalid SERVICE_DELIVERY identity: supply all four fields with SHA40, artifact SHA256, nonempty request and UUID instance, or omit all four');
  }
  if (moduleManaged && (!moduleFields.every(name => typeof env[name] === 'string') ||
    env.COCKPIT_MODULE_ID !== 'task' || env.COCKPIT_MODULE_VERSION !== version ||
    env.COCKPIT_MODULE_DIGEST.length !== 64 || !/^[a-f0-9]{64}$/.test(env.COCKPIT_MODULE_DIGEST) ||
    env.COCKPIT_MODULE_INSTANCE.length !== 36 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(env.COCKPIT_MODULE_INSTANCE) ||
    (env.WORK_COCKPIT_MODULE_VERSION !== undefined && env.WORK_COCKPIT_MODULE_VERSION !== env.COCKPIT_MODULE_VERSION))) {
    throw new Error('Invalid COCKPIT_MODULE identity: supply task ID, actual package version, inventory SHA256 and UUID instance together, or omit all four; managed owner role version must agree');
  }
  if (managed && moduleManaged) throw new Error('Conflicting runtime identity authorities: SERVICE_DELIVERY and COCKPIT_MODULE launch identities cannot be combined');
  return Object.freeze({
    projectId: 'task',
    moduleApi: 1,
    version,
    moduleVersion: moduleManaged ? env.COCKPIT_MODULE_VERSION : null,
    moduleDigest: moduleManaged ? env.COCKPIT_MODULE_DIGEST : null,
    sha: managed ? env.SERVICE_DELIVERY_SHA : null,
    artifactSha256: managed ? env.SERVICE_DELIVERY_ARTIFACT : null,
    requestId: managed ? env.SERVICE_DELIVERY_REQUEST : null,
    instanceId: managed ? env.SERVICE_DELIVERY_INSTANCE : moduleManaged ? env.COCKPIT_MODULE_INSTANCE : randomUUID(),
    identitySource: managed ? 'delivery-environment' : moduleManaged ? 'module-environment' : 'unknown',
    authority: 'work-commander-runtime',
  });
}
