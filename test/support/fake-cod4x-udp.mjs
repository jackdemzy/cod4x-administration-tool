import dgram from 'node:dgram';

// UDP test double of the CoD4x Dedicated connectionless handler, modelled on
// callofduty4x/CoD4x_Server src/sv_main.c (SVC_RemoteCommand, SVC_Info,
// SV_FlushRedirect with a 1024 byte redirect buffer, 100 ms deny rate limit).
// It is NOT the real core: native RCON against cod4x18_dedrun stays open.
const OOB = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const REDIRECT_BUFFER = 1024;

export async function startFakeCod4xServer({ port = 0, password = '', hostname = 'Fake CoD4x', mapname = 'mp_backlot', silent = false, plugins = [] } = {}) {
  const socket = dgram.createSocket('udp4');
  const state = { password, hostname, mapname, commands: [], denied: 0, lastDenyAt: 0, silent, rawPackets: [] };
  const send = (text, remote) => socket.send(Buffer.concat([OOB, Buffer.from(text, 'latin1')]), remote.port, remote.address);
  // Like Com_PrintMessage + SV_FlushRedirect: flush whenever the buffer would overflow.
  const print = (output, remote) => {
    let buffer = '';
    for (const line of output.split(/(?<=\n)/)) {
      if (buffer.length + line.length > REDIRECT_BUFFER - 1) { send(`print\n${buffer}`, remote); buffer = ''; }
      buffer += line;
    }
    send(`print\n${buffer}`, remote);
  };
  socket.on('message', (message, remote) => {
    state.rawPackets.push(Buffer.from(message));
    if (state.silent || message.length < 5 || !message.subarray(0, 4).equals(OOB)) return;
    const line = message.subarray(4).toString('latin1').split('\n')[0];
    const [verb, ...rest] = line.split(' ');
    if (verb === 'getinfo') {
      send(`infoResponse\n\\challenge\\${rest[0] || ''}\\hostname\\${state.hostname}\\mapname\\${state.mapname}\\clients\\0\\sv_maxclients\\18`, remote);
      return;
    }
    if (verb !== 'rcon') return;
    const supplied = rest[0] || '';
    if (supplied !== state.password) {
      if (Date.now() - state.lastDenyAt < 100) return; // one deny answer per 100 ms
      state.lastDenyAt = Date.now(); state.denied++;
      print('Bad rcon', remote);
      return;
    }
    if (state.password.length < 8) { print('No rconpassword set on server or password is shorter than 8 characters.\n', remote); return; }
    const command = rest.slice(1).join(' ');
    state.commands.push(command);
    if (command === 'status') {
      let output = `map: ${state.mapname}\nnum score ping guid                             name            lastmsg address               qport rate\n--- ----- ---- -------------------------------- --------------- ------- --------------------- ----- -----\n`;
      for (let index = 0; index < 24; index++) output += `${String(index).padStart(3)}     0   50 ${'0'.repeat(32)} Bot${index}           0 bot                   0     25000\n`;
      print(output, remote);
    } else if (command === 'serverinfo') print(`Server info settings:\nsv_hostname    ${state.hostname}\nmapname        ${state.mapname}\nsv_maxclients  18\n`, remote);
    else if (command === 'systeminfo') print('System info settings:\nsv_serverid    1\n', remote);
    else if (command.startsWith('map ')) { state.mapname = command.slice(4); print(`------ Server Initialization ------\nServer: ${state.mapname}\n`, remote); }
    else if (command === 'map_rotate') print('Rotating map\n', remote);
    // Shape of src/plugin_handler.c PHandler_PluginInfo_f.
    else if (command.startsWith('pluginInfo ')) {
      const name = command.slice(11);
      if (!plugins.some(value => value.toLowerCase() === name.toLowerCase())) print(`Plugin "${name}" is not loaded!\n`, remote);
      else print(`\n^2Plugin name:^7\n${name}\n\n^2Plugin version:^7\n1.0\n\n^2Full plugin name:^7\nFake ${name}\n\n`, remote);
    }
    else print(`Unknown command "${command}"\n`, remote);
  });
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(port, '127.0.0.1', resolve); });
  return {
    port: socket.address().port,
    state,
    close: () => new Promise(resolve => { try { socket.close(resolve); } catch { resolve(); } }),
  };
}

export async function freeUdpPort() {
  const socket = dgram.createSocket('udp4');
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}
