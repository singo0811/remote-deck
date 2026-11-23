//go:build windows

// remote-deck-svc: a tiny LocalSystem watchdog that keeps the RemoteDeck host
// agent running inside the interactive console session.
//
// Why not a classic SCM service? The host agent needs the interactive desktop
// (GDI capture + SendInput), which a Session 0 service cannot touch. Instead we
// run at boot as SYSTEM through a scheduled task and launch the agent *into* the
// logged-on session via WTSQueryUserToken + CreateProcessAsUser, restarting it
// whenever it exits.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	advapi32 = syscall.NewLazyDLL("advapi32.dll")
	wtsapi32 = syscall.NewLazyDLL("wtsapi32.dll")
	userenv  = syscall.NewLazyDLL("userenv.dll")

	procWTSGetActiveConsoleSessionId = kernel32.NewProc("WTSGetActiveConsoleSessionId")
	procOpenProcessToken             = advapi32.NewProc("OpenProcessToken")
	procDuplicateTokenEx             = advapi32.NewProc("DuplicateTokenEx")
	procCreateProcessAsUserW         = advapi32.NewProc("CreateProcessAsUserW")
	procWTSQueryUserToken            = wtsapi32.NewProc("WTSQueryUserToken")
	procCreateEnvironmentBlock       = userenv.NewProc("CreateEnvironmentBlock")
	procDestroyEnvironmentBlock      = userenv.NewProc("DestroyEnvironmentBlock")
	procCloseHandle                  = kernel32.NewProc("CloseHandle")
	procWaitForSingleObject          = kernel32.NewProc("WaitForSingleObject")
	procGetExitCodeProcess           = kernel32.NewProc("GetExitCodeProcess")
	procCreateToolhelp32Snapshot     = kernel32.NewProc("CreateToolhelp32Snapshot")
	procProcess32FirstW              = kernel32.NewProc("Process32FirstW")
	procProcess32NextW               = kernel32.NewProc("Process32NextW")
)

const (
	tokenAssignPrimary   = 0x0001
	tokenDuplicate       = 0x0002
	tokenQuery           = 0x0008
	tokenAdjustDefault   = 0x0080
	tokenAdjustSessionID = 0x0100
	securityImpersonation = 2
	tokenPrimary          = 1
	startfUseShowWindow   = 0x00000001
	startfUseStdHandles   = 0x00000100
	createUnicodeEnv      = 0x00000400
	th32csSnapProcess     = 0x00000002
	invalidHandle         = ^uintptr(0)
	infinite              = 0xFFFFFFFF
)

type startupInfoW struct {
	Cb            uint32
	_             *uint16
	Desktop       *uint16
	Title         *uint16
	X, Y          int32
	XSize, YSize  int32
	XCountChars   int32
	YCountChars   int32
	FillAttribute uint32
	Flags         uint32
	ShowWindow    uint16
	_             uint16
	_             *byte
	StdInput      uintptr
	StdOutput     uintptr
	StdErr        uintptr
}

type processEntry32W struct {
	Size            uint32
	CntUsage        uint32
	ProcessID       uint32
	DefaultHeapID   uintptr
	ModuleID        uint32
	CntThreads      uint32
	ParentProcessID uint32
	PriClassBase    int32
	Flags           uint32
	ExeFile         [260]uint16
}

type launcherConfig struct {
	AppPath string   `json:"appPath"`
	Args    []string `json:"args"`
	Restart bool     `json:"restart"`
}

var (
	cfgPath string
	logFile *os.File
	logMu   sync.Mutex
)

func logf(format string, a ...any) {
	logMu.Lock()
	defer logMu.Unlock()
	line := fmt.Sprintf("%s %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, a...))
	if logFile != nil {
		_, _ = logFile.WriteString(line)
	}
	fmt.Print(line)
}

func sysLogPath() string {
	base := os.Getenv("ProgramData")
	if base == "" {
		base = filepath.Join(os.Getenv("SystemDrive") + `\`, "ProgramData")
	}
	dir := filepath.Join(base, "RemoteDeck")
	_ = os.MkdirAll(dir, 0o755)
	return filepath.Join(dir, "svc.log")
}

func loadConfig() (launcherConfig, error) {
	var cfg launcherConfig
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return cfg, err
	}
	if cfg.AppPath == "" {
		return cfg, fmt.Errorf("appPath is empty in %s", cfgPath)
	}
	return cfg, nil
}

func activeConsoleSession() uint32 {
	r, _, _ := procWTSGetActiveConsoleSessionId.Call()
	return uint32(r)
}

func enableTcbPrivilege() {
	// LocalSystem already holds SeTcbPrivilege; this is a no-op safety net for
	// runs started by a privileged task.
	type luid struct{ Low, High uint32 }
	type tokenPrivileges struct {
		Count uint32
		_     uint32
		Priv  [1]struct {
			Luid       luid
			Attributes uint32
		}
	}
	proc := advapi32.NewProc("LookupPrivilegeValueW")
	procAdjust := advapi32.NewProc("AdjustTokenPrivileges")
	procOpen := advapi32.NewProc("OpenProcessToken")
	procGetCurrent := kernel32.NewProc("GetCurrentProcess")
	var name, _ = syscall.UTF16PtrFromString("SeTcbPrivilege")
	var l luid
	if r, _, _ := proc.Call(0, uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&l))); r == 0 {
		return
	}
	hProc, _, _ := procGetCurrent.Call()
	var tok uintptr
	if r, _, _ := procOpen.Call(hProc, tokenAdjustDefault|tokenQuery, uintptr(unsafe.Pointer(&tok))); r == 0 {
		return
	}
	defer procCloseHandle.Call(tok)
	tp := tokenPrivileges{Count: 1}
	tp.Priv[0].Luid = l
	tp.Priv[0].Attributes = 0x00000002 // SE_PRIVILEGE_ENABLED
	procAdjust.Call(tok, 0, uintptr(unsafe.Pointer(&tp)), 0, 0, 0)
}

// sessionToken prefers the logged-on user's token; falls back to winlogon's
// SYSTEM token (needed when nobody is logged on but the session still exists).
func sessionToken(sessionID uint32, system bool) (uintptr, error) {
	if system {
		if tok, err := winlogonToken(sessionID); err == nil && tok != 0 {
			return tok, nil
		}
	}
	var tok uintptr
	r, _, err := procWTSQueryUserToken.Call(uintptr(sessionID), uintptr(unsafe.Pointer(&tok)))
	if r == 0 || tok == 0 {
		if sysTok, sysErr := winlogonToken(sessionID); sysErr == nil && sysTok != 0 {
			return sysTok, nil
		}
		return 0, fmt.Errorf("WTSQueryUserToken failed: %v", err)
	}
	var dup uintptr
	r, _, err = procDuplicateTokenEx.Call(
		tok, tokenAssignPrimary|tokenDuplicate|tokenQuery|tokenAdjustDefault|tokenAdjustSessionID,
		0, securityImpersonation, tokenPrimary, uintptr(unsafe.Pointer(&dup)),
	)
	procCloseHandle.Call(tok)
	if r == 0 || dup == 0 {
		return 0, fmt.Errorf("DuplicateTokenEx failed: %v", err)
	}
	return dup, nil
}

// winlogonToken duplicates the SYSTEM token of the winlogon.exe process living
// in the target session, which can access the secure (lock) desktop.
func winlogonToken(sessionID uint32) (uintptr, error) {
	hSnap, _, _ := procCreateToolhelp32Snapshot.Call(th32csSnapProcess, 0)
	if hSnap == invalidHandle || hSnap == 0 {
		return 0, fmt.Errorf("CreateToolhelp32Snapshot failed")
	}
	defer procCloseHandle.Call(hSnap)

	var pe processEntry32W
	pe.Size = uint32(unsafe.Sizeof(pe))
	r, _, _ := procProcess32FirstW.Call(hSnap, uintptr(unsafe.Pointer(&pe)))
	for r != 0 {
		name := syscall.UTF16ToString(pe.ExeFile[:])
		if name == "winlogon.exe" {
			if sid := processSession(pe.ProcessID); sid == sessionID {
				if tok, err := duplicateProcessToken(pe.ProcessID); err == nil {
					return tok, nil
				}
			}
		}
		pe.Size = uint32(unsafe.Sizeof(pe))
		r, _, _ = procProcess32NextW.Call(hSnap, uintptr(unsafe.Pointer(&pe)))
	}
	return 0, fmt.Errorf("no winlogon.exe found in session %d", sessionID)
}

func processSession(pid uint32) uint32 {
	proc := kernel32.NewProc("ProcessIdToSessionId")
	var sid uint32
	r, _, _ := proc.Call(uintptr(pid), uintptr(unsafe.Pointer(&sid)))
	if r == 0 {
		return 0
	}
	return sid
}

func duplicateProcessToken(pid uint32) (uintptr, error) {
	procOpen := kernel32.NewProc("OpenProcess")
	const processQueryLimited = 0x1000
	hProc, _, err := procOpen.Call(processQueryLimited, 0, uintptr(pid))
	if hProc == 0 {
		return 0, err
	}
	defer procCloseHandle.Call(hProc)

	var tok uintptr
	if r, _, err := procOpenProcessToken.Call(hProc, tokenDuplicate|tokenQuery|tokenAssignPrimary|tokenAdjustDefault|tokenAdjustSessionID, uintptr(unsafe.Pointer(&tok))); r == 0 {
		return 0, err
	}
	defer procCloseHandle.Call(tok)

	var dup uintptr
	r, _, err := procDuplicateTokenEx.Call(
		tok, tokenAssignPrimary|tokenDuplicate|tokenQuery|tokenAdjustDefault|tokenAdjustSessionID,
		0, securityImpersonation, tokenPrimary, uintptr(unsafe.Pointer(&dup)),
	)
	if r == 0 {
		return 0, err
	}
	return dup, nil
}

func launchInSession(cfg launcherConfig, sessionID uint32, asSystem bool) (uintptr, uintptr, error) {
	tok, err := sessionToken(sessionID, asSystem)
	if err != nil {
		return 0, 0, err
	}

	var envBlock uintptr
	procCreateEnvironmentBlock.Call(uintptr(unsafe.Pointer(&envBlock)), tok, 0)

	cmdline := syscall.EscapeArg(cfg.AppPath)
	for _, a := range cfg.Args {
		cmdline += " " + syscall.EscapeArg(a)
	}
	cmdPtr, _ := syscall.UTF16PtrFromString(cmdline)
	desktop, _ := syscall.UTF16PtrFromString("winsta0\\default")

	var si startupInfoW
	si.Cb = uint32(unsafe.Sizeof(si))
	si.Desktop = desktop
	si.Flags = startfUseShowWindow
	si.ShowWindow = 1

	var pi struct {
		Process   uintptr
		Thread    uintptr
		ProcessID uint32
		ThreadID  uint32
	}
	createFlags := uintptr(createUnicodeEnv)
	r, _, callErr := procCreateProcessAsUserW.Call(
		tok,
		0,
		uintptr(unsafe.Pointer(cmdPtr)),
		0, 0,
		0,
		createFlags,
		envBlock,
		0,
		uintptr(unsafe.Pointer(&si)),
		uintptr(unsafe.Pointer(&pi)),
	)
	if envBlock != 0 {
		procDestroyEnvironmentBlock.Call(envBlock)
	}
	procCloseHandle.Call(tok)
	if r == 0 {
		return 0, 0, fmt.Errorf("CreateProcessAsUser failed: %v", callErr)
	}
	procCloseHandle.Call(pi.Thread)
	return pi.Process, uintptr(pi.ProcessID), nil
}

func watch(cfg launcherConfig, asSystem bool) {
	logf("watchdog start: app=%s args=%v sessionAware=%v", cfg.AppPath, cfg.Args, true)
	enableTcbPrivilege()

	var proc uintptr
	failures := 0
	for {
		sid := activeConsoleSession()
		if sid == 0xFFFFFFFF {
			time.Sleep(5 * time.Second)
			continue
		}
		if proc == 0 {
			h, pid, err := launchInSession(cfg, sid, asSystem)
			if err != nil {
				failures++
				logf("launch failed (session %d, attempt %d): %v", sid, failures, err)
				time.Sleep(10 * time.Second)
				continue
			}
			proc = h
			failures = 0
			logf("agent started in session %d (pid %d)", sid, pid)
		}

		// Wait up to 5s for the child to exit, then re-check the session.
		r, _, _ := procWaitForSingleObject.Call(proc, 5000)
		if r == 0 { // WAIT_OBJECT_0 -> exited
			var code uint32
			procGetExitCodeProcess.Call(proc, uintptr(unsafe.Pointer(&code)))
			procCloseHandle.Call(proc)
			proc = 0
			logf("agent exited with code %d, restarting", code)
			if !cfg.Restart {
				logf("restart disabled; watchdog idle")
				return
			}
			time.Sleep(2 * time.Second)
		}
	}
}

func main() {
	cfgFile := flag.String("config", "", "path to launcher config json")
	selfTest := flag.Bool("selftest", false, "print environment facts and exit")
	systemMode := flag.Bool("system-session", false, "launch using the SYSTEM token of the session (lock-screen capable)")
	flag.Parse()

	logFile, _ = os.OpenFile(sysLogPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)

	cfgPath = *cfgFile
	if cfgPath == "" {
		cfgPath = filepath.Join(filepath.Dir(os.Args[0]), "svc-config.json")
	}

	if *selfTest {
		sid := activeConsoleSession()
		logf("selftest: elevated=%v activeConsoleSession=%d", isElevated(), sid)
		if cfg, err := loadConfig(); err == nil {
			logf("selftest: config ok app=%s", cfg.AppPath)
		} else {
			logf("selftest: config error: %v", err)
		}
		if tok, err := sessionToken(sid, *systemMode); err == nil {
			procCloseHandle.Call(tok)
			logf("selftest: session token acquired for session %d", sid)
		} else {
			logf("selftest: session token unavailable: %v", err)
		}
		return
	}

	cfg, err := loadConfig()
	if err != nil {
		logf("fatal: %v", err)
		os.Exit(1)
	}
	watch(cfg, *systemMode)
}

func isElevated() bool {
	hProc, _, _ := kernel32.NewProc("GetCurrentProcess").Call()
	var tok uintptr
	if r, _, _ := procOpenProcessToken.Call(hProc, tokenQuery, uintptr(unsafe.Pointer(&tok))); r == 0 {
		return false
	}
	defer procCloseHandle.Call(tok)
	type tokenElevation struct{ Elevated uint32 }
	var e tokenElevation
	var n uint32
	r, _, _ := advapi32.NewProc("GetTokenInformation").Call(tok, 20, uintptr(unsafe.Pointer(&e)), unsafe.Sizeof(e), uintptr(unsafe.Pointer(&n)))
	return r != 0 && e.Elevated != 0
}
