import { EventEmitter } from 'node:events';

// Process table double for B3Runtime: spawn/inspect/kill share one view of
// "running" processes. Behaviour per run can be scripted (early exit, ignore SIGTERM).
export function createFakeB3Processes({ uid = 1000 } = {}) {
  const processes = new Map();
  let nextPid = 9100;
  const spawned = [];
  const behaviour = { exitDuringStartup: null, ignoreTerm: false };
  function finish(entry, code, signal) {
    if (!entry.alive) return;
    entry.alive = false;
    queueMicrotask(() => entry.child.emit('exit', code, signal));
  }
  return {
    processes, spawned, behaviour,
    spawn(file, args, options) {
      const child = new EventEmitter();
      child.pid = ++nextPid; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.unref = () => {};
      const entry = { child, alive: true, argv: [file, ...args], uid, startTime: `start-${child.pid}`, ignoreTerm: behaviour.ignoreTerm };
      child.kill = () => finish(entry, null, 'SIGTERM');
      processes.set(child.pid, entry);
      spawned.push({ file, args, options, pid: child.pid });
      queueMicrotask(() => {
        child.emit('spawn');
        child.stdout.emit('data', Buffer.from('www.bigbrotherbot.net (b3) v1.10.10\nrcon_password = should-not-leak\n'));
        if (behaviour.exitDuringStartup !== null) setTimeout(() => finish(entry, behaviour.exitDuringStartup, null), 5);
      });
      return child;
    },
    async inspect(pid) {
      const entry = processes.get(pid);
      return entry?.alive ? { alive: true, argv: entry.argv, uid: entry.uid, startTime: entry.startTime } : { alive: false };
    },
    kill(pid, signal) {
      const entry = processes.get(pid);
      if (!entry?.alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      if (signal === 'SIGTERM' && entry.ignoreTerm) return;
      finish(entry, null, signal);
    },
    crash(pid, code = 1) { finish(processes.get(pid), code, null); },
    vanish(pid) { const entry = processes.get(pid); entry.alive = false; },
    reuse(pid) { const entry = processes.get(pid); entry.startTime = 'reused-by-other-process'; },
  };
}
