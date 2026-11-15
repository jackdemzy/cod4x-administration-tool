'use strict';
// A log file that stays bounded while it is written (4.18.31 review): when a write would take the file
// past maxBytes, the file is moved to <file>.1 (replacing an older one) and a new file is started.
// So the log plus its one rotation never take more than about twice maxBytes, however long the writer
// runs. Writes are synchronous and errors are swallowed: logging must never take the app down.
const fs = require('fs');
const path = require('path');

function openCappedLog(file, { maxBytes = 2 * 1024 * 1024 } = {}) {
  let fd = null, size = 0;
  const open = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fd = fs.openSync(file, 'a', 0o600);
      size = fs.fstatSync(fd).size;
    } catch { fd = null; size = 0; }
  };
  const close = () => { if (fd !== null) { try { fs.closeSync(fd); } catch {} fd = null; } };
  const rotate = () => {
    close();
    try { fs.renameSync(file, `${file}.1`); } catch {}
    open();
    // The move failed (no rights, or on Windows another program holds backend.log.1): start the file
    // over instead of letting it grow (review on #65). The older lines are lost, the limit holds.
    if (fd !== null && size > 0) { try { fs.ftruncateSync(fd, 0); size = 0; } catch { close(); } }
  };
  open();
  if (size > maxBytes) rotate();
  return {
    write(chunk) {
      if (fd === null) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      // A single chunk larger than the limit keeps only its tail.
      const part = data.length > maxBytes ? data.subarray(data.length - maxBytes) : data;
      if (size > 0 && size + part.length > maxBytes) rotate();
      if (fd === null) return;
      try { fs.writeSync(fd, part); size += part.length; } catch {}
    },
    close,
    get size() { return size; },
  };
}

module.exports = { openCappedLog };
