//go:build windows

package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"
)

var (
	procCreatePseudoConsole                = kernel32.NewProc("CreatePseudoConsole")
	procResizePseudoConsole                = kernel32.NewProc("ResizePseudoConsole")
	procClosePseudoConsole                 = kernel32.NewProc("ClosePseudoConsole")
	procInitializeProcThreadAttributeList  = kernel32.NewProc("InitializeProcThreadAttributeList")
	procUpdateProcThreadAttribute          = kernel32.NewProc("UpdateProcThreadAttribute")
	procDeleteProcThreadAttributeList      = kernel32.NewProc("DeleteProcThreadAttributeList")
	procCreateProcessW                     = kernel32.NewProc("CreateProcessW")
	procWaitForSingleObject                = kernel32.NewProc("WaitForSingleObject")
	procGetExitCodeProcess                 = kernel32.NewProc("GetExitCodeProcess")
	procTerminateProcess                   = kernel32.NewProc("TerminateProcess")
)

const (
	procThreadAttributePseudoConsole = 0x00020016
	extendedStartupinfoPresent       = 0x00080000
	infiniteTimeout                  = 0xFFFFFFFF
)

type startupInfoExW struct {
	StartupInfo   syscall.StartupInfo
	AttributeList unsafe.Pointer
}

type ptySession struct {
	id         string
	mode       string
	hpc        uintptr
	hpcOnce    sync.Once
	inWriter   *os.File
	outReader  *os.File
	procHandle syscall.Handle
	cmd        *exec.Cmd
	closeOnce  sync.Once
}

func (s *ptySession) closeHpc() {
	s.hpcOnce.Do(func() {
		if s.hpc != 0 {
			procClosePseudoConsole.Call(s.hpc)
			s.hpc = 0
		}
	})
}

var (
	ptyMu   sync.Mutex
	ptyMap  = map[string]*ptySession{}
)

func packCoord(cols, rows int) uintptr {
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	return uintptr(uint32(uint16(cols)) | (uint32(uint16(rows)) << 16))
}

func resolveShellCommand(shell string) string {
	switch shell {
	case "cmd", "cmd.exe":
		return "cmd.exe"
	case "pwsh":
		if p, err := exec.LookPath("pwsh.exe"); err == nil {
			return p
		}
		return "powershell.exe"
	default:
		if p, err := exec.LookPath("powershell.exe"); err == nil {
			return p
		}
		return "cmd.exe"
	}
}

func emitPtyOutput(id string, data []byte) {
	if len(data) == 0 {
		return
	}
	idBytes := []byte(id)
	buf := make([]byte, 4+len(idBytes)+len(data))
	binary.BigEndian.PutUint32(buf[0:4], uint32(len(idBytes)))
	copy(buf[4:4+len(idBytes)], idBytes)
	copy(buf[4+len(idBytes):], data)
	_ = writeFrame(evtPtyOutput, buf)
}

func openPty(req ptyOpenReq) {
	if req.ID == "" {
		return
	}
	closePty(req.ID)

	cols := req.Cols
	rows := req.Rows
	if cols <= 0 {
		cols = 100
	}
	if rows <= 0 {
		rows = 30
	}
	cmdLine := resolveShellCommand(req.Shell)

	// Try Windows ConPTY first
	if sess, err := startConPtySession(req.ID, cmdLine, req.Cwd, cols, rows); err == nil {
		ptyMu.Lock()
		ptyMap[req.ID] = sess
		ptyMu.Unlock()
		writeJSONFrame(evtPtyOpened, map[string]any{"id": req.ID, "mode": sess.mode})
		go pumpPtySession(sess)
		return
	}

	// Fallback to pipe-based shell if ConPTY unavailable
	sess, err := startPipeShellSession(req.ID, cmdLine, req.Cwd)
	if err != nil {
		writeJSONFrame(evtJSON, map[string]any{"op": "pty_error", "id": req.ID, "error": err.Error()})
		return
	}
	ptyMu.Lock()
	ptyMap[req.ID] = sess
	ptyMu.Unlock()
	writeJSONFrame(evtPtyOpened, map[string]any{"id": req.ID, "mode": sess.mode})
	go pumpPipeSession(sess)
}

func startConPtySession(id, cmdLine, cwd string, cols, rows int) (*ptySession, error) {
	if err := procCreatePseudoConsole.Find(); err != nil {
		return nil, err
	}

	var inRead, inWrite, outRead, outWrite syscall.Handle
	if err := syscall.CreatePipe(&inRead, &inWrite, nil, 0); err != nil {
		return nil, err
	}
	if err := syscall.CreatePipe(&outRead, &outWrite, nil, 0); err != nil {
		syscall.CloseHandle(inRead)
		syscall.CloseHandle(inWrite)
		return nil, err
	}

	var hpc uintptr
	r1, _, err := procCreatePseudoConsole.Call(
		packCoord(cols, rows),
		uintptr(inRead),
		uintptr(outWrite),
		0,
		uintptr(unsafe.Pointer(&hpc)),
	)
	syscall.CloseHandle(inRead)
	syscall.CloseHandle(outWrite)
	if r1 != 0 || hpc == 0 {
		syscall.CloseHandle(inWrite)
		syscall.CloseHandle(outRead)
		return nil, fmt.Errorf("CreatePseudoConsole failed hr=0x%x err=%v", r1, err)
	}

	var attrListSize uintptr
	procInitializeProcThreadAttributeList.Call(0, 1, 0, uintptr(unsafe.Pointer(&attrListSize)))
	if attrListSize == 0 {
		procClosePseudoConsole.Call(hpc)
		syscall.CloseHandle(inWrite)
		syscall.CloseHandle(outRead)
		return nil, fmt.Errorf("InitializeProcThreadAttributeList size=0")
	}
	attrBuf := make([]byte, attrListSize)
	attrList := unsafe.Pointer(&attrBuf[0])
	ok, _, err := procInitializeProcThreadAttributeList.Call(uintptr(attrList), 1, 0, uintptr(unsafe.Pointer(&attrListSize)))
	if ok == 0 {
		procClosePseudoConsole.Call(hpc)
		syscall.CloseHandle(inWrite)
		syscall.CloseHandle(outRead)
		return nil, fmt.Errorf("InitializeProcThreadAttributeList failed: %v", err)
	}
	defer procDeleteProcThreadAttributeList.Call(uintptr(attrList))

	ok, _, err = procUpdateProcThreadAttribute.Call(
		uintptr(attrList),
		0,
		procThreadAttributePseudoConsole,
		hpc,
		unsafe.Sizeof(hpc),
		0,
		0,
	)
	if ok == 0 {
		procClosePseudoConsole.Call(hpc)
		syscall.CloseHandle(inWrite)
		syscall.CloseHandle(outRead)
		return nil, fmt.Errorf("UpdateProcThreadAttribute failed: %v", err)
	}

	var siEx startupInfoExW
	siEx.StartupInfo.Cb = uint32(unsafe.Sizeof(siEx))
	siEx.StartupInfo.Flags = syscall.STARTF_USESTDHANDLES
	siEx.AttributeList = attrList

	var pi syscall.ProcessInformation
	cmdPtr, err := syscall.UTF16PtrFromString(cmdLine)
	if err != nil {
		procClosePseudoConsole.Call(hpc)
		syscall.CloseHandle(inWrite)
		syscall.CloseHandle(outRead)
		return nil, err
	}
	var cwdPtr *uint16
	if cwd != "" {
		cwdPtr, _ = syscall.UTF16PtrFromString(cwd)
	}

	ok, _, err = procCreateProcessW.Call(
		0,
		uintptr(unsafe.Pointer(cmdPtr)),
		0,
		0,
		0,
		extendedStartupinfoPresent,
		0,
		uintptr(unsafe.Pointer(cwdPtr)),
		uintptr(unsafe.Pointer(&siEx)),
		uintptr(unsafe.Pointer(&pi)),
	)
	if ok == 0 {
		procClosePseudoConsole.Call(hpc)
		syscall.CloseHandle(inWrite)
		syscall.CloseHandle(outRead)
		return nil, fmt.Errorf("CreateProcessW failed: %v", err)
	}
	syscall.CloseHandle(pi.Thread)

	return &ptySession{
		id:         id,
		mode:       "conpty",
		hpc:        hpc,
		inWriter:   os.NewFile(uintptr(inWrite), "pty-in"),
		outReader:  os.NewFile(uintptr(outRead), "pty-out"),
		procHandle: pi.Process,
	}, nil
}

func startPipeShellSession(id, cmdLine, cwd string) (*ptySession, error) {
	cmd := exec.Command(cmdLine)
	if cwd != "" {
		cmd.Dir = cwd
	}
	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	sess := &ptySession{
		id:   id,
		mode: "pipe",
		cmd:  cmd,
	}
	go func() {
		buf := make([]byte, 8192)
		for {
			n, err := stdoutPipe.Read(buf)
			if n > 0 {
				emitPtyOutput(id, buf[:n])
			}
			if err != nil {
				break
			}
		}
	}()
	// wrap stdinPipe via os.Pipe? Store in custom goroutine? Better: use write closure? Let's keep it simple:
	pr, pw, err := os.Pipe()
	if err == nil {
		sess.inWriter = pw
		go func() {
			_, _ = io.Copy(stdinPipe, pr)
			_ = stdinPipe.Close()
			_ = pr.Close()
		}()
	}
	return sess, nil
}

func pumpPtySession(sess *ptySession) {
	exitCh := make(chan uint32, 1)
	go func() {
		procWaitForSingleObject.Call(uintptr(sess.procHandle), infiniteTimeout)
		var exitCode uint32
		procGetExitCodeProcess.Call(uintptr(sess.procHandle), uintptr(unsafe.Pointer(&exitCode)))
		sess.closeHpc()
		exitCh <- exitCode
	}()

	buf := make([]byte, 8192)
	for {
		n, err := sess.outReader.Read(buf)
		if n > 0 {
			emitPtyOutput(sess.id, buf[:n])
		}
		if err != nil {
			break
		}
	}
	exitCode := <-exitCh
	closePty(sess.id)
	writeJSONFrame(evtPtyExit, map[string]any{"id": sess.id, "code": int(exitCode)})
}

func pumpPipeSession(sess *ptySession) {
	err := sess.cmd.Wait()
	code := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		} else {
			code = 1
		}
	}
	closePty(sess.id)
	writeJSONFrame(evtPtyExit, map[string]any{"id": sess.id, "code": code})
}

func writePty(id string, data []byte) {
	ptyMu.Lock()
	sess := ptyMap[id]
	ptyMu.Unlock()
	if sess != nil && sess.inWriter != nil {
		_, _ = sess.inWriter.Write(data)
	}
}

func resizePty(id string, cols, rows int) {
	ptyMu.Lock()
	sess := ptyMap[id]
	ptyMu.Unlock()
	if sess != nil && sess.hpc != 0 {
		procResizePseudoConsole.Call(sess.hpc, packCoord(cols, rows))
	}
}

func closePty(id string) {
	ptyMu.Lock()
	sess, ok := ptyMap[id]
	if ok {
		delete(ptyMap, id)
	}
	ptyMu.Unlock()
	if sess == nil {
		return
	}
	sess.closeOnce.Do(func() {
		if sess.inWriter != nil {
			_ = sess.inWriter.Close()
		}
		sess.closeHpc()
		if sess.outReader != nil {
			_ = sess.outReader.Close()
		}
		if sess.procHandle != 0 {
			procTerminateProcess.Call(uintptr(sess.procHandle), 0)
			syscall.CloseHandle(sess.procHandle)
		}
		if sess.cmd != nil && sess.cmd.Process != nil {
			_ = sess.cmd.Process.Kill()
		}
	})
}

func closeAllPtys() {
	ptyMu.Lock()
	ids := make([]string, 0, len(ptyMap))
	for id := range ptyMap {
		ids = append(ids, id)
	}
	ptyMu.Unlock()
	for _, id := range ids {
		closePty(id)
	}
}
