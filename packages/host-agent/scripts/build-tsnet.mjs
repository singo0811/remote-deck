import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostAgentDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(hostAgentDir, '../..');
const tsnetDir = path.join(hostAgentDir, 'tsnet');
const binDir = path.join(hostAgentDir, 'bin');
fs.mkdirSync(binDir, { recursive: true });

const goEnv = {
  ...process.env,
  GOPROXY: process.env.GOPROXY || 'https://goproxy.cn,https://proxy.golang.org,direct',
};

console.log('Tidying tsnet Go module...');
execFileSync('go', ['mod', 'tidy'], { cwd: tsnetDir, stdio: 'inherit', env: goEnv });

const hostExe = path.join(binDir, process.platform === 'win32' ? 'remote-tsnet.exe' : 'remote-tsnet');
console.log(`Building host tsnet mesh helper -> ${hostExe}`);
execFileSync('go', ['build', '-ldflags', '-s -w', '-o', hostExe, '.'], {
  cwd: tsnetDir,
  stdio: 'inherit',
  env: { ...goEnv, CGO_ENABLED: '0' },
});
console.log('Host tsnet helper built successfully.');

// Also build HarmonyOS arm64 c-shared library when the OpenHarmony NDK is present.
const devEcoDefault = 'D:\\Program Files\\Huawei\\DevEco Studio';
const sdkHome = process.env.DEVECO_SDK_HOME || path.join(process.env.DEVECO_STUDIO_HOME || devEcoDefault, 'sdk');
const ndkRoot = path.join(sdkHome, 'default', 'openharmony', 'native');
const clangExe = path.join(ndkRoot, 'llvm', 'bin', process.platform === 'win32' ? 'clang.exe' : 'clang');
const sysrootDir = path.join(ndkRoot, 'sysroot');

if (fs.existsSync(clangExe) && fs.existsSync(sysrootDir)) {
  const harmonyLibDir = path.join(repoRoot, 'apps/harmony/entry/libs/arm64-v8a');
  const harmonyCppDir = path.join(repoRoot, 'apps/harmony/entry/src/main/cpp');
  fs.mkdirSync(harmonyLibDir, { recursive: true });
  fs.mkdirSync(harmonyCppDir, { recursive: true });

  const soOut = path.join(harmonyLibDir, 'libtsnet_bridge.so');
  const wrapperPath = path.join(os.tmpdir(), process.platform === 'win32' ? 'remotedeck-ohos-cc.cmd' : 'remotedeck-ohos-cc.sh');
  if (process.platform === 'win32') {
    fs.writeFileSync(
      wrapperPath,
      `@echo off\r\n"${clangExe}" --target=aarch64-linux-ohos "--sysroot=${sysrootDir}" %*\r\n`,
      'ascii',
    );
  } else {
    fs.writeFileSync(
      wrapperPath,
      `#!/bin/sh\nexec "${clangExe}" --target=aarch64-linux-ohos "--sysroot=${sysrootDir}" "$@"\n`,
      'utf8',
    );
    fs.chmodSync(wrapperPath, 0o755);
  }

  /**
   * Standard linux/arm64 Go uses Initial-Exec TLS (R_AARCH64_TLS_TPREL64) for runtime.tls_g,
   * which OpenHarmony's ld-musl rejects inside dlopen()ed shared libraries.
   * Stage a lightweight GOROOT copy in tmpdir and route runtime.load_g/save_g via pthread keys
   * without mutating the system Go toolchain.
   */
  function prepareOhosGoroot() {
    const baseGoroot = execFileSync('go', ['env', 'GOROOT'], { cwd: tsnetDir, env: goEnv, encoding: 'utf8' }).trim();
    const stagedRoot = path.join(os.tmpdir(), 'remotedeck-ohos-goroot');
    fs.rmSync(stagedRoot, { recursive: true, force: true });
    fs.mkdirSync(stagedRoot, { recursive: true });

    const linkOrCopyDir = (src, dst) => {
      if (process.platform === 'win32') {
        execFileSync('cmd.exe', ['/c', 'mklink', '/J', dst, src], { stdio: 'ignore' });
      } else {
        fs.symlinkSync(src, dst, 'dir');
      }
    };

    for (const entry of fs.readdirSync(baseGoroot, { withFileTypes: true })) {
      const src = path.join(baseGoroot, entry.name);
      const dst = path.join(stagedRoot, entry.name);
      if (entry.name === 'src') {
        fs.mkdirSync(dst, { recursive: true });
        for (const srcEntry of fs.readdirSync(src, { withFileTypes: true })) {
          const sSrc = path.join(src, srcEntry.name);
          const sDst = path.join(dst, srcEntry.name);
          if (srcEntry.name === 'runtime') {
            fs.cpSync(sSrc, sDst, { recursive: true });
          } else if (srcEntry.isDirectory()) {
            linkOrCopyDir(sSrc, sDst);
          } else {
            fs.copyFileSync(sSrc, sDst);
          }
        }
      } else if (entry.isDirectory()) {
        linkOrCopyDir(src, dst);
      } else {
        fs.copyFileSync(src, dst);
      }
    }

    const runtimeDir = path.join(stagedRoot, 'src', 'runtime');
    const cgoDir = path.join(runtimeDir, 'cgo');

    fs.writeFileSync(
      path.join(cgoDir, 'gcc_ohos_arm64.c'),
      `//go:build ohoslib && linux && arm64
#include <pthread.h>
#include "libcgo.h"

static pthread_key_t remotedeck_g_key;
static pthread_once_t remotedeck_g_once = PTHREAD_ONCE_INIT;

static void init_ohos_g_key(void) {
    pthread_key_create(&remotedeck_g_key, NULL);
}

static void ohos_inittls(void **tlsg, void **tlsbase) {
    (void)tlsg;
    (void)tlsbase;
    pthread_once(&remotedeck_g_once, init_ohos_g_key);
    pthread_setspecific(remotedeck_g_key, NULL);
}

static void ohos_threadentry(void) {
    pthread_once(&remotedeck_g_once, init_ohos_g_key);
    pthread_setspecific(remotedeck_g_key, NULL);
}

void (*x_cgo_inittls)(void **tlsg, void **tlsbase) = ohos_inittls;
void (*x_cgo_threadentry_platform)(void) = ohos_threadentry;

void* x_cgo_ohos_get_g(void) {
    pthread_once(&remotedeck_g_once, init_ohos_g_key);
    return pthread_getspecific(remotedeck_g_key);
}

void x_cgo_ohos_set_g(void* g) {
    pthread_once(&remotedeck_g_once, init_ohos_g_key);
    pthread_setspecific(remotedeck_g_key, g);
}
`,
      'utf8',
    );

    fs.writeFileSync(
      path.join(cgoDir, 'ohos_tls_arm64.go'),
      `//go:build ohoslib && linux && arm64

package cgo

import _ "unsafe"

//go:cgo_import_static x_cgo_ohos_get_g
//go:linkname x_cgo_ohos_get_g x_cgo_ohos_get_g
//go:linkname _cgo_ohos_get_g _cgo_ohos_get_g
var x_cgo_ohos_get_g byte
var _cgo_ohos_get_g = &x_cgo_ohos_get_g

//go:cgo_import_static x_cgo_ohos_set_g
//go:linkname x_cgo_ohos_set_g x_cgo_ohos_set_g
//go:linkname _cgo_ohos_set_g _cgo_ohos_set_g
var x_cgo_ohos_set_g byte
var _cgo_ohos_set_g = &x_cgo_ohos_set_g
`,
      'utf8',
    );

    fs.writeFileSync(
      path.join(runtimeDir, 'ohos_tls_arm64.go'),
      `//go:build ohoslib && linux && arm64

package runtime

import "unsafe"

//go:linkname _cgo_ohos_get_g _cgo_ohos_get_g
var _cgo_ohos_get_g unsafe.Pointer

//go:linkname _cgo_ohos_set_g _cgo_ohos_set_g
var _cgo_ohos_set_g unsafe.Pointer
`,
      'utf8',
    );

    const tlsArm64Path = path.join(runtimeDir, 'tls_arm64.s');
    if (fs.existsSync(tlsArm64Path)) {
      fs.chmodSync(tlsArm64Path, 0o644);
    }
    fs.writeFileSync(
      tlsArm64Path,
      `#include "go_asm.h"
#include "go_tls.h"
#include "funcdata.h"
#include "textflag.h"
#include "tls_arm64.h"

TEXT runtime·load_g(SB),NOSPLIT|NOFRAME,$0
\tMOVB\truntime·iscgo(SB), R0
\tCBZ\tR0, nocgo
\tMOVD\t_cgo_ohos_get_g(SB), R27
\tCBZ\tR27, nocgo
\tSUB\t$(8*20), RSP
\tSTP\t(R1, R2), (8*0)(RSP)
\tSTP\t(R3, R4), (8*2)(RSP)
\tSTP\t(R5, R6), (8*4)(RSP)
\tSTP\t(R7, R8), (8*6)(RSP)
\tSTP\t(R9, R10), (8*8)(RSP)
\tSTP\t(R11, R12), (8*10)(RSP)
\tSTP\t(R13, R14), (8*12)(RSP)
\tSTP\t(R15, R16), (8*14)(RSP)
\tSTP\t(R17, R18_PLATFORM), (8*16)(RSP)
\tMOVD\tNZCV, R9
\tSTP\t(R9, R30), (8*18)(RSP)
\tBL\t(R27)
\tMOVD\tR0, g
\tLDP\t(8*18)(RSP), (R9, R30)
\tMOVD\tR9, NZCV
\tLDP\t(8*16)(RSP), (R17, R18_PLATFORM)
\tLDP\t(8*14)(RSP), (R15, R16)
\tLDP\t(8*12)(RSP), (R13, R14)
\tLDP\t(8*10)(RSP), (R11, R12)
\tLDP\t(8*8)(RSP), (R9, R10)
\tLDP\t(8*6)(RSP), (R7, R8)
\tLDP\t(8*4)(RSP), (R5, R6)
\tLDP\t(8*2)(RSP), (R3, R4)
\tLDP\t(8*0)(RSP), (R1, R2)
\tADD\t$(8*20), RSP
nocgo:
\tRET

TEXT runtime·save_g(SB),NOSPLIT|NOFRAME,$0
\tMOVB\truntime·iscgo(SB), R0
\tCBZ\tR0, nocgo
\tMOVD\t_cgo_ohos_set_g(SB), R27
\tCBZ\tR27, nocgo
\tSUB\t$(8*20), RSP
\tSTP\t(R1, R2), (8*0)(RSP)
\tSTP\t(R3, R4), (8*2)(RSP)
\tSTP\t(R5, R6), (8*4)(RSP)
\tSTP\t(R7, R8), (8*6)(RSP)
\tSTP\t(R9, R10), (8*8)(RSP)
\tSTP\t(R11, R12), (8*10)(RSP)
\tSTP\t(R13, R14), (8*12)(RSP)
\tSTP\t(R15, R16), (8*14)(RSP)
\tSTP\t(R17, R18_PLATFORM), (8*16)(RSP)
\tMOVD\tNZCV, R9
\tSTP\t(R9, R30), (8*18)(RSP)
\tMOVD\tg, R0
\tBL\t(R27)
\tLDP\t(8*18)(RSP), (R9, R30)
\tMOVD\tR9, NZCV
\tLDP\t(8*16)(RSP), (R17, R18_PLATFORM)
\tLDP\t(8*14)(RSP), (R15, R16)
\tLDP\t(8*12)(RSP), (R13, R14)
\tLDP\t(8*10)(RSP), (R11, R12)
\tLDP\t(8*8)(RSP), (R9, R10)
\tLDP\t(8*6)(RSP), (R7, R8)
\tLDP\t(8*4)(RSP), (R5, R6)
\tLDP\t(8*2)(RSP), (R3, R4)
\tLDP\t(8*0)(RSP), (R1, R2)
\tADD\t$(8*20), RSP
nocgo:
\tRET

GLOBL runtime·tls_g+0(SB), NOPTR, $8
`,
      'utf8',
    );

    return stagedRoot;
  }

  /**
   * OpenHarmony's ld-musl invokes `.init_array` entries with no arguments, so
   * Go's `_rt0_arm64_lib` picks up whatever happens to sit in x0/x1 (garbage).
   * The runtime then walks that as argv/environ, and getGodebugEarly()/sysargs()/
   * goenvs_unix() crash while scanning unmapped memory.
   *
   * Force argc=0/argv=nil in the lib entry and make the three argv consumers
   * tolerate the "loaded as a library" case (sysargs already has a
   * /proc/self/auxv fallback for exactly this situation).
   */
  function patchRuntimeForArgvlessInit(runtimeDir) {
    const patchFile = (relPath, replacements) => {
      const full = path.join(runtimeDir, relPath);
      fs.chmodSync(full, 0o644);
      let src = fs.readFileSync(full, 'utf8');
      for (const [anchor, replacement] of replacements) {
        if (!src.includes(anchor)) {
          throw new Error(`build-tsnet: argv-init patch anchor not found in ${relPath}: ${JSON.stringify(anchor.slice(0, 80))}`);
        }
        if (src.includes(replacement)) {
          throw new Error(`build-tsnet: argv-init patch already applied in ${relPath}`);
        }
        src = src.split(anchor).join(replacement);
      }
      fs.writeFileSync(full, src, 'utf8');
    };

    patchFile('asm_arm64.s', [
      [
        `\tMOVD\tR0, _rt0_arm64_lib_argc<>(SB)
\tMOVD\tR1, _rt0_arm64_lib_argv<>(SB)`,
        `\tMOVD\tZR, _rt0_arm64_lib_argc<>(SB)
\tMOVD\tZR, _rt0_arm64_lib_argv<>(SB)`,
      ],
    ]);

    patchFile('proc.go', [
      [
        `		n := int32(0)
		for argv_index(argv, argc+1+n) != nil {
			n++
		}

		for i := int32(0); i < n; i++ {
			p := argv_index(argv, argc+1+i)
			s := unsafe.String(p, findnull(p))`,
        `		n := int32(0)
		if argc > 0 && argv != nil {
			for argv_index(argv, argc+1+n) != nil {
				n++
			}
		}

		for i := int32(0); i < n; i++ {
			p := argv_index(argv, argc+1+i)
			s := unsafe.String(p, findnull(p))`,
      ],
    ]);

    patchFile('runtime1.go', [
      [
        `	n := int32(0)
	for argv_index(argv, argc+1+n) != nil {
		n++
	}

	envs = make([]string, n)`,
        `	n := int32(0)
	if argc > 0 && argv != nil {
		for argv_index(argv, argc+1+n) != nil {
			n++
		}
	}

	envs = make([]string, n)`,
      ],
    ]);

    patchFile('os_linux.go', [
      [
        `	n := argc + 1

	// skip over argv, envp to get to auxv
	for argv_index(argv, n) != nil {
		n++
	}

	// skip NULL separator
	n++

	// now argv+n is auxv
	auxvp := (*[1 << 28]uintptr)(add(unsafe.Pointer(argv), uintptr(n)*goarch.PtrSize))

	if pairs := sysauxv(auxvp[:]); pairs != 0 {
		auxv = auxvp[: pairs*2 : pairs*2]
		return
	}`,
        `	// When loaded as a library the ELF init hooks may be called without
	// arguments, leaving argc/argv unavailable. Fall through to /proc/self/auxv.
	haveArgv := argc > 0 && argv != nil
	n := argc + 1

	// skip over argv, envp to get to auxv
	if haveArgv {
		for argv_index(argv, n) != nil {
			n++
		}
	}

	// skip NULL separator
	n++

	// now argv+n is auxv
	if haveArgv {
		auxvp := (*[1 << 28]uintptr)(add(unsafe.Pointer(argv), uintptr(n)*goarch.PtrSize))

		if pairs := sysauxv(auxvp[:]); pairs != 0 {
			auxv = auxvp[: pairs*2 : pairs*2]
			return
		}
	}`,
      ],
    ]);
  }

  const ohosGoroot = process.env.OHOS_GOROOT || prepareOhosGoroot();
  if (!process.env.OHOS_GOROOT) {
    patchRuntimeForArgvlessInit(path.join(ohosGoroot, 'src', 'runtime'));
  }
  const ohosGoExe = path.join(ohosGoroot, 'bin', process.platform === 'win32' ? 'go.exe' : 'go');
  const ohosGoEnv = {
    ...goEnv,
    GOTOOLCHAIN: 'local',
    GOROOT: ohosGoroot,
    PATH: `${path.join(ohosGoroot, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
    GOOS: 'linux',
    GOARCH: 'arm64',
    CGO_ENABLED: '1',
    CC: wrapperPath,
    CGO_CFLAGS: '',
    CGO_LDFLAGS: '-Wl,-soname,libtsnet_bridge.so',
  };

  console.log(`Building HarmonyOS tsnet shared library -> ${soOut}`);
  const ohosLdflags = process.env.TSNET_KEEP_SYMBOLS ? '' : '-s -w';
  execFileSync(
    ohosGoExe,
    ['build', '-tags', 'ohoslib', '-buildmode=c-shared', '-ldflags', ohosLdflags, '-o', soOut, '.'],
    {
      cwd: tsnetDir,
      stdio: 'inherit',
      env: ohosGoEnv,
    },
  );

  // Move generated C header into HarmonyOS C++ folder so CMake can include it cleanly.
  const genHeader = path.join(harmonyLibDir, 'libtsnet_bridge.h');
  const dstHeader = path.join(harmonyCppDir, 'libtsnet_bridge.h');
  if (fs.existsSync(genHeader)) {
    fs.renameSync(genHeader, dstHeader);
  }
  console.log('HarmonyOS tsnet shared library built successfully.');
} else {
  console.log('OpenHarmony NDK not found; skipping HarmonyOS libtsnet_bridge.so build.');
}
