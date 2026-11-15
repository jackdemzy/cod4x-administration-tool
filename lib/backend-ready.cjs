'use strict';
// Audit 4.18.31 (S-1): the backend prints this line on its own stdout once it listens on its port.
// The desktop app waits for it on the pipe of the child it started, so another program answering on
// 127.0.0.1:8787 is never mistaken for CONTROL's backend (and never gets the saved login).
const BACKEND_READY_LINE = 'COD4X_CONTROL_BACKEND_READY';

// Feeds stdout chunks; returns true once a whole line equals the ready line.
function createReadyWatcher() {
  let pending = '', ready = false;
  return chunk => {
    if (ready) return true;
    pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop().slice(-256);
    ready = lines.some(line => line.trim() === BACKEND_READY_LINE);
    return ready;
  };
}

module.exports = { BACKEND_READY_LINE, createReadyWatcher };
