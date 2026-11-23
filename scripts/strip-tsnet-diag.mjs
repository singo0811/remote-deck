// One-shot maintenance helper: removes the temporary OHOS crash-dump
// instrumentation from the generated gcc_ohos_arm64.c template inside
// scripts/build-tsnet.mjs, keeping the pthread-key TLS shim intact.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '..', 'packages', 'host-agent', 'scripts', 'build-tsnet.mjs');
let src = fs.readFileSync(file, 'utf8');
const original = src.length;

const diagStart = src.indexOf('/* ---- OHOS TLS diagnostics');
const diagEnd = src.indexOf('static void ohos_inittls(void **tlsg, void **tlsbase) {');
if (diagStart < 0 || diagEnd < 0 || diagEnd <= diagStart) {
  throw new Error('diagnostics block markers not found');
}
src = `${src.slice(0, diagStart)}${src.slice(diagEnd)}`;

// The diagnostic installer ran inside inittls; drop that call.
src = src.replace(
  `    pthread_setspecific(remotedeck_g_key, NULL);
    rd_install();
}`,
  `    pthread_setspecific(remotedeck_g_key, NULL);
}`,
);

// Drop the diagnostics includes from the C template.
src = src.replace(
  `#include <pthread.h>
#include <stdint.h>
#include <stddef.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <ucontext.h>
#include <sys/mman.h>
#include <dlfcn.h>
#include "libcgo.h"`,
  `#include <pthread.h>
#include "libcgo.h"`,
);

// Restore the plain pthread-key get/set.
src = src.replace(
  `void* x_cgo_ohos_get_g(void) {
    void *g;
    pthread_once(&remotedeck_g_once, init_ohos_g_key);
    g = pthread_getspecific(remotedeck_g_key);
    rd_get_calls++;
    rd_last_get = (unsigned long long)(uintptr_t)g;
    if (g == NULL) { rd_get_null++; }
    return g;
}`,
  `void* x_cgo_ohos_get_g(void) {
    pthread_once(&remotedeck_g_once, init_ohos_g_key);
    return pthread_getspecific(remotedeck_g_key);
}`,
);
src = src.replace(
  `void x_cgo_ohos_set_g(void* g) {
    pthread_once(&remotedeck_g_once, init_ohos_g_key);
    pthread_setspecific(remotedeck_g_key, g);
    rd_set_calls++;
    rd_last_set = (unsigned long long)(uintptr_t)g;
}`,
  `void x_cgo_ohos_set_g(void* g) {
    pthread_once(&remotedeck_g_once, init_ohos_g_key);
    pthread_setspecific(remotedeck_g_key, g);
}`,
);

for (const leftover of ['rd_buf', 'rd_crash', 'rd_install', 'rd_scan_stack', 'rd_get_calls', 'mincore', 'ucontext_t']) {
  if (src.includes(leftover)) throw new Error(`leftover diagnostic reference: ${leftover}`);
}

fs.writeFileSync(file, src, 'utf8');
console.log(`build-tsnet.mjs: ${original} -> ${src.length} bytes (diagnostics removed)`);
