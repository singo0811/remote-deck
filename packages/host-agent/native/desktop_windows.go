//go:build windows

package main

import (
	"os"
	"strings"
	"unsafe"
)

// Secure-desktop support: when the workstation is locked, the visible desktop is
// "Winlogon" inside winsta0. A process attached to the normal "Default" desktop
// captures a black screen and its input goes nowhere. If RemoteDeck is running
// with SYSTEM privileges inside the interactive session (see remote-deck-svc),
// it can re-attach its own thread to the *input* desktop and reach the lock UI.
//
// Off by default because it only works in that privileged setup; enable with
// REMOTEDECK_SECURE_DESKTOP=1 on a host started by the watchdog in
// --system-session mode.

var (
	procOpenInputDesktop  = user32.NewProc("OpenInputDesktop")
	procSetThreadDesktop  = user32.NewProc("SetThreadDesktop")
	procGetThreadDesktop  = user32.NewProc("GetThreadDesktop")
	procCloseDesktop      = user32.NewProc("CloseDesktop")
	procGetCurrentThreadId = kernel32.NewProc("GetCurrentThreadId")
)

const desktopAllAccess = 0x01FF

func secureDesktopRequested() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("REMOTEDECK_SECURE_DESKTOP"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// attachInputDesktop moves the calling thread onto the currently visible desktop
// (Winlogon when locked, Default otherwise). Returns a detach func or nil when
// nothing changed / not permitted.
func attachInputDesktop() func() {
	if !secureDesktopRequested() || !isProcessElevated() {
		return nil
	}

	hDesk, _, _ := procOpenInputDesktop.Call(0, 0, desktopAllAccess)
	if hDesk == 0 {
		return nil
	}

	tid, _, _ := procGetCurrentThreadId.Call()
	prev, _, _ := procGetThreadDesktop.Call(tid)

	if r, _, _ := procSetThreadDesktop.Call(hDesk); r == 0 {
		procCloseDesktop.Call(hDesk)
		return nil
	}

	return func() {
		if prev != 0 {
			procSetThreadDesktop.Call(prev)
		}
		procCloseDesktop.Call(hDesk)
	}
}

var _ = unsafe.Pointer(nil)
