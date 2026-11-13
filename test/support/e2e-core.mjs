import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// Block 22 (E2E): a native stand-in for cod4x18_dedrun. Like buildFakeCore it is a real ELF
// process (so the runtime's process identity checks run for real), prints its arguments, reads
// +exec files from <fs_homepath>/main and prints "execing <file>". In addition it starts
// e2e-core-udp.mjs as its child, which answers getinfo/getstatus/rcon on net_port with the
// rcon_password the core read. SIGTERM/SIGINT stop both; the child also dies with the core.
// Linux only; needs gcc.
const run = promisify(execFile);
const responder = fileURLToPath(new URL('./e2e-core-udp.mjs', import.meta.url));
const cString = value => JSON.stringify(String(value));

const source = ({ node, script }) => `#define _GNU_SOURCE
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
static pid_t udp = 0;
static void stop(int sig) { (void)sig; if (udp > 0) { kill(udp, SIGTERM); waitpid(udp, NULL, 0); } _exit(0); }
static void quoted(const char *line, const char *key, char *out, size_t size) {
  size_t length = strlen(key);
  if (strncmp(line, key, length) || line[length] != '"') return;
  const char *start = line + length + 1, *end = strchr(start, '"');
  if (!end || (size_t)(end - start) >= size) return;
  memcpy(out, start, end - start); out[end - start] = 0;
}
int main(int argc, char **argv) {
  const char *home = "", *port = "28960", *ip = "127.0.0.1";
  char password[256] = "", hostname[256] = "E2E CoD4x", map[64] = "mp_backlot";
  signal(SIGTERM, stop); signal(SIGINT, stop);
  for (int i = 0; i < argc; i++) printf("%s\\n", argv[i]);
  for (int i = 0; i + 2 < argc; i++) if (!strcmp(argv[i], "+set")) {
    if (!strcmp(argv[i + 1], "fs_homepath")) home = argv[i + 2];
    else if (!strcmp(argv[i + 1], "net_port")) port = argv[i + 2];
    else if (!strcmp(argv[i + 1], "net_ip")) ip = argv[i + 2];
  }
  for (int i = 0; i + 1 < argc; i++) if (!strcmp(argv[i], "+map")) snprintf(map, sizeof map, "%s", argv[i + 1]);
  for (int i = 0; i + 1 < argc; i++) if (!strcmp(argv[i], "+exec")) {
    char file[4096], line[512];
    snprintf(file, sizeof file, "%s/main/%s", home, argv[i + 1]);
    FILE *handle = fopen(file, "r");
    if (!handle) { printf("couldn't exec %s\\n", argv[i + 1]); continue; }
    printf("execing %s\\n", argv[i + 1]);
    while (fgets(line, sizeof line, handle)) {
      quoted(line, "set rcon_password ", password, sizeof password);
      quoted(line, "set sv_hostname ", hostname, sizeof hostname);
    }
    fclose(handle);
  }
  fflush(stdout);
  /* No SIGTERM between fork and recording the child's PID; the child checks that the core is
     still its parent after arming PDEATHSIG, so it can never outlive a core that died early. */
  sigset_t block, previous;
  sigemptyset(&block); sigaddset(&block, SIGTERM); sigaddset(&block, SIGINT);
  sigprocmask(SIG_BLOCK, &block, &previous);
  pid_t core = getpid();
  udp = fork();
  if (udp == 0) {
    prctl(PR_SET_PDEATHSIG, SIGTERM);
    if (getppid() != core) _exit(0);
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL);
    sigprocmask(SIG_SETMASK, &previous, NULL);
    execl(${cString(node)}, "node", ${cString(script)}, "--port", port, "--ip", ip, "--password", password, "--hostname", hostname, "--map", map, (char *)NULL);
    _exit(127);
  }
  sigprocmask(SIG_SETMASK, &previous, NULL);
  for (;;) {
    int status;
    if (udp > 0 && waitpid(udp, &status, WNOHANG) == udp) { fprintf(stderr, "e2e udp responder exited\\n"); udp = 0; }
    usleep(100000);
  }
}
`;

export async function buildE2eCore(directory, name = 'cod4x18_dedrun') {
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${name}.c`);
  const executable = path.join(directory, name);
  await fs.writeFile(file, source({ node: process.execPath, script: responder }));
  await run('gcc', ['-O0', file, '-o', executable]);
  await fs.rm(file);
  await fs.chmod(executable, 0o755);
  return executable;
}

export async function e2eCoreAvailable() {
  if (process.platform !== 'linux') return 'E2E core needs Linux';
  try { await run('gcc', ['--version']); return null; } catch { return 'E2E core needs gcc'; }
}
