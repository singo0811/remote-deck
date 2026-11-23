//go:build windows

package main

import (
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

var (
	advapi32                    = syscall.NewLazyDLL("advapi32.dll")
	procOpenProcessToken        = advapi32.NewProc("OpenProcessToken")
	procGetTokenInformation     = advapi32.NewProc("GetTokenInformation")
	procGetCurrentProcess       = kernel32.NewProc("GetCurrentProcess")
	procGetModuleHandleW        = kernel32.NewProc("GetModuleHandleW")
	procCloseHandle             = kernel32.NewProc("CloseHandle")
	procRegisterClassExW        = user32.NewProc("RegisterClassExW")
	procCreateWindowExW         = user32.NewProc("CreateWindowExW")
	procDestroyWindow           = user32.NewProc("DestroyWindow")
	procDefWindowProcW          = user32.NewProc("DefWindowProcW")
	procGetMessageW             = user32.NewProc("GetMessageW")
	procTranslateMessage        = user32.NewProc("TranslateMessage")
	procDispatchMessageW        = user32.NewProc("DispatchMessageW")
	procPostMessageW            = user32.NewProc("PostMessageW")
	procBeginPaint              = user32.NewProc("BeginPaint")
	procEndPaint                = user32.NewProc("EndPaint")
	procDrawTextW               = user32.NewProc("DrawTextW")
	procSetWindowDisplayAffinity = user32.NewProc("SetWindowDisplayAffinity")
	procCreateSolidBrush        = gdi32.NewProc("CreateSolidBrush")
	procSetTextColor            = gdi32.NewProc("SetTextColor")
	procSetBkMode               = gdi32.NewProc("SetBkMode")
)

const (
	tokenQuery             = 0x0008
	tokenElevationClass    = 20
	wdaExcludeFromCapture  = 0x00000011
	wsPopup                = 0x80000000
	wsVisible              = 0x10000000
	wsExTopmost            = 0x00000008
	wsExTransparent        = 0x00000020
	wsExToolWindow         = 0x00000080
	wsExNoActivate         = 0x08000000
	wmPaint                = 0x000F
	wmClose                = 0x0010
	wmDestroy              = 0x0002
	dtCenter               = 0x00000001
	dtVCenter              = 0x00000004
	dtSingleLine           = 0x00000020
)

type tokenElevation struct {
	TokenIsElevated uint32
}

func isProcessElevated() bool {
	hProc, _, _ := procGetCurrentProcess.Call()
	var hToken uintptr
	r, _, _ := procOpenProcessToken.Call(hProc, tokenQuery, uintptr(unsafe.Pointer(&hToken)))
	if r == 0 || hToken == 0 {
		return false
	}
	defer procCloseHandle.Call(hToken)

	var elev tokenElevation
	var retLen uint32
	r, _, _ = procGetTokenInformation.Call(
		hToken,
		tokenElevationClass,
		uintptr(unsafe.Pointer(&elev)),
		unsafe.Sizeof(elev),
		uintptr(unsafe.Pointer(&retLen)),
	)
	return r != 0 && elev.TokenIsElevated != 0
}

type wndClassExW struct {
	CbSize        uint32
	Style         uint32
	LpfnWndProc   uintptr
	CbClsExtra    int32
	CbWndExtra    int32
	HInstance     uintptr
	HIcon         uintptr
	HCursor       uintptr
	HbrBackground uintptr
	LpszMenuName  *uint16
	LpszClassName *uint16
	HIconSm       uintptr
}

type winMsg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      point
}

type paintStruct struct {
	Hdc         uintptr
	FErase      int32
	RcPaint     rect
	FRestore    int32
	FIncUpdate  int32
	RgbReserved [32]byte
}

var (
	privacyMu   sync.Mutex
	privacyHwnd uintptr
)

func setPrivacyScreen(enabled bool) error {
	privacyMu.Lock()
	if !enabled {
		hwnd := privacyHwnd
		privacyHwnd = 0
		privacyMu.Unlock()
		if hwnd != 0 {
			procPostMessageW.Call(hwnd, wmClose, 0, 0)
		}
		return nil
	}
	if privacyHwnd != 0 {
		privacyMu.Unlock()
		return nil
	}

	errCh := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		hInst, _, _ := procGetModuleHandleW.Call(0)
		className, _ := syscall.UTF16PtrFromString("RemoteDeckPrivacyOverlay")
		bgBrush, _, _ := procCreateSolidBrush.Call(0x00000000)
		if bgBrush != 0 {
			defer procDeleteObject.Call(bgBrush)
		}
		noticeText, _ := syscall.UTF16FromString("RemoteDeck 隐私防窥保护已开启 — 仅控制端可见桌面")

		wndProc := syscall.NewCallback(func(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
			switch msg {
			case wmPaint:
				var ps paintStruct
				hdc, _, _ := procBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
				if hdc != 0 {
					procSetBkMode.Call(hdc, 1) // TRANSPARENT
					procSetTextColor.Call(hdc, 0x0094A3B8)
					rc := ps.RcPaint
					procDrawTextW.Call(hdc, uintptr(unsafe.Pointer(&noticeText[0])), uintptr(len(noticeText)-1), uintptr(unsafe.Pointer(&rc)), dtCenter|dtVCenter|dtSingleLine)
					procEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
				}
				return 0
			case wmClose:
				procDestroyWindow.Call(hwnd)
				return 0
			case wmDestroy:
				return 0
			}
			r, _, _ := procDefWindowProcW.Call(hwnd, uintptr(msg), wParam, lParam)
			return r
		})

		wc := wndClassExW{
			CbSize:        uint32(unsafe.Sizeof(wndClassExW{})),
			LpfnWndProc:   wndProc,
			HInstance:     hInst,
			HbrBackground: bgBrush,
			LpszClassName: className,
		}
		procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

		vx, _, _ := procGetSystemMetrics.Call(smXVirtualScreen)
		vy, _, _ := procGetSystemMetrics.Call(smYVirtualScreen)
		vw, _, _ := procGetSystemMetrics.Call(smCXVirtualScreen)
		vh, _, _ := procGetSystemMetrics.Call(smCYVirtualScreen)
		if int32(vw) <= 0 {
			vw = 1920
		}
		if int32(vh) <= 0 {
			vh = 1080
		}

		exStyle := uintptr(wsExTopmost | wsExTransparent | wsExToolWindow | wsExNoActivate)
		style := uintptr(wsPopup | wsVisible)
		title, _ := syscall.UTF16PtrFromString("RemoteDeck Privacy")

		hwnd, _, err := procCreateWindowExW.Call(
			exStyle,
			uintptr(unsafe.Pointer(className)),
			uintptr(unsafe.Pointer(title)),
			style,
			vx, vy, vw, vh,
			0, 0, hInst, 0,
		)
		if hwnd == 0 {
			privacyMu.Unlock()
			errCh <- fmt.Errorf("CreateWindowExW failed: %v", err)
			return
		}

		// Exclude privacy window from BitBlt/screen capture (Windows 10 2004+)
		ok, _, affErr := procSetWindowDisplayAffinity.Call(hwnd, wdaExcludeFromCapture)
		if ok == 0 {
			procDestroyWindow.Call(hwnd)
			privacyMu.Unlock()
			errCh <- fmt.Errorf("当前系统不支持防窥黑屏 (SetWindowDisplayAffinity: %v)", affErr)
			return
		}

		privacyHwnd = hwnd
		privacyMu.Unlock()
		errCh <- nil

		var m winMsg
		for {
			ret, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), hwnd, 0, 0)
			if int32(ret) <= 0 {
				break
			}
			procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
			procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
			privacyMu.Lock()
			stillAlive := privacyHwnd == hwnd
			privacyMu.Unlock()
			if !stillAlive {
				break
			}
		}
	}()

	return <-errCh
}
