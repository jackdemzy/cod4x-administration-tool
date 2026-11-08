import fs from 'node:fs';
import path from 'node:path';
import { validRemoteInstanceId } from './remote-safety.mjs';

// Block 18b: remote and local instance ids share one pattern. Where both meet (credential vault,
// monitoring history, phone gateway) a remote id is written rmt_<id>; a local id never contains '_'.
const fail = code => { throw Object.assign(new Error(code), { code }); };
export const REMOTE_PREFIX = 'rmt_';
const SUBJECT = /^rmt_([a-z][a-z0-9-]{0,47})$/;

export const isRemoteSubject = value => typeof value === 'string' && SUBJECT.test(value);
export function remoteSubject(id) {
  if (!validRemoteInstanceId(id)) fail('REMOTE_INSTANCE_INVALID');
  return `${REMOTE_PREFIX}${id}`;
}
export function remoteIdOf(subject) {
  const match = SUBJECT.exec(typeof subject === 'string' ? subject : '');
  if (!match) fail('REMOTE_INSTANCE_INVALID');
  return match[1];
}

// The local side of a remote instance: a private directory on this PC for what the shared
// services keep per instance (B3 database settings, RCON history), keyed like a local instance.
export function createShadowStore({ instances, dataRoot }) {
  const root = path.join(path.resolve(dataRoot), 'remote-data');
  const get = id => {
    if (!validRemoteInstanceId(id)) fail('REMOTE_INSTANCE_INVALID');
    const instance = instances.get(id); // REMOTE_INSTANCE_NOT_FOUND
    const homePath = path.join(root, instance.id);
    fs.mkdirSync(homePath, { recursive: true, mode: 0o700 });
    return { id: instance.id, homePath, createdAt: instance.createdAt, port: instance.port, hostId: instance.hostId };
  };
  return { get, list: () => instances.list().map(instance => get(instance.id)) };
}

// resolveInstance for the vault: rmt_<id> is a subject of its own (the createdAt of the remote
// record is part of the vault key, so a re-created instance does not inherit old credentials).
export function remoteSubjectResolver(shadow) {
  return subject => {
    if (!isRemoteSubject(subject)) fail('INSTANCE_NOT_FOUND');
    const { homePath, createdAt } = shadow.get(remoteIdOf(subject));
    return { id: subject, homePath, createdAt };
  };
}

// The credential service as the remote services see it: same calls, the instance id becomes rmt_<id>.
const PER_INSTANCE = ['instanceStatus', 'set', 'remove', 'withRuntimeCredentials', 'resolve', 'setB3AuthPassword'];
export function prefixedCredentials(service) {
  const adapter = {};
  for (const name of PER_INSTANCE) adapter[name] = (id, ...rest) => service[name](remoteSubject(id), ...rest);
  adapter.status = (...args) => service.status(...args);
  adapter.lock = (...args) => service.lock(...args);
  return adapter;
}
