import os from 'node:os';
import fsp from 'node:fs/promises';

// Block 24: host load next to the servers. CPU is the busy share between two
// samples (os.loadavg is always 0 on Windows); disk is the free space of the
// volume that holds each instance home.
const cpuTimes = cpus => cpus.reduce((total, cpu) => {
  const times = Object.values(cpu.times);
  total.all += times.reduce((sum, value) => sum + value, 0);
  total.idle += cpu.times.idle;
  return total;
}, { all: 0, idle: 0 });

export class MonitorHost {
  #os; #statfs; #previous = null;
  constructor({ osModule = os, statfs = target => fsp.statfs(target) } = {}) { this.#os = osModule; this.#statfs = statfs; }
  async sample(paths = []) {
    const times = cpuTimes(this.#os.cpus());
    const previous = this.#previous;
    this.#previous = times;
    const all = previous ? times.all - previous.all : 0;
    const cpuPercent = previous && all > 0 ? Math.round(1000 * (1 - (times.idle - previous.idle) / all)) / 10 : null;
    const total = this.#os.totalmem(), free = this.#os.freemem();
    const disks = [];
    for (const target of [...new Set(paths)]) {
      try {
        const stat = await this.#statfs(target);
        disks.push({ path: target, freeBytes: stat.bavail * stat.bsize, totalBytes: stat.blocks * stat.bsize });
      } catch { disks.push({ path: target, freeBytes: null, totalBytes: null }); }
    }
    return { cpuPercent, cpuCount: this.#os.cpus().length, memory: { totalBytes: total, freeBytes: free, usedPercent: total ? Math.round(1000 * (1 - free / total)) / 10 : null }, disks, uptimeSeconds: Math.round(this.#os.uptime()) };
  }
}
