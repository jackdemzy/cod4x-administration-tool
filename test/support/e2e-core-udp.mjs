import { startFakeCod4xServer } from './fake-cod4x-udp.mjs';

// Block 22 (E2E): the UDP side of the E2E test core. test/support/e2e-core.mjs compiles a native
// cod4x18_dedrun that starts this script as its child with the port, bind address, hostname and
// the rcon_password it read through +exec. It is a test double, not the real core.
const option = name => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : ''; };
const parent = process.ppid;
const server = await startFakeCod4xServer({ port: Number(option('port')), password: option('password'), hostname: option('hostname') || 'E2E CoD4x', mapname: option('map') || 'mp_backlot', joinable: true });
console.log(`e2e udp ready on ${server.port}`);
const stop = async () => { await server.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
// The core may be killed with SIGKILL (crash test); the responder must not outlive it.
setInterval(() => { if (process.ppid !== parent) stop(); }, 200);
