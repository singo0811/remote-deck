//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

var (
	procSendInput        = user32.NewProc("SendInput")
	procOpenClipboard    = user32.NewProc("OpenClipboard")
	procCloseClipboard   = user32.NewProc("CloseClipboard")
	procEmptyClipboard   = user32.NewProc("EmptyClipboard")
	procGetClipboardData = user32.NewProc("GetClipboardData")
	procSetClipboardData = user32.NewProc("SetClipboardData")

	procGlobalAlloc  = kernel32.NewProc("GlobalAlloc")
	procGlobalLock   = kernel32.NewProc("GlobalLock")
	procGlobalUnlock = kernel32.NewProc("GlobalUnlock")
	procGlobalFree   = kernel32.NewProc("GlobalFree")
)

const (
	inputMouse    = 0
	inputKeyboard = 1

	mouseEventfMove        = 0x0001
	mouseEventfLeftDown    = 0x0002
	mouseEventfLeftUp      = 0x0004
	mouseEventfRightDown   = 0x0008
	mouseEventfRightUp     = 0x0010
	mouseEventfMiddleDown  = 0x0020
	mouseEventfMiddleUp    = 0x0040
	mouseEventfWheel       = 0x0800
	mouseEventfVirtualDesk = 0x4000
	mouseEventfAbsolute    = 0x8000

	keyEventfKeyUp   = 0x0002
	keyEventfUnicode = 0x0004

	vkShift   = 0x10
	vkControl = 0x11
	vkMenu    = 0x12
	vkLWin    = 0x5B

	cfUnicodeText = 13
	gmemMoveable  = 0x0002
)

// winInput matches Windows x64 INPUT struct (40 bytes total).
type winInput struct {
	Type uint32
	_    uint32
	Data [32]byte
}

type mouseInput struct {
	Dx          int32
	Dy          int32
	MouseData   uint32
	DwFlags     uint32
	Time        uint32
	DwExtraInfo uintptr
}

type keybdInput struct {
	WVk         uint16
	WScan       uint16
	DwFlags     uint32
	Time        uint32
	DwExtraInfo uintptr
}

func sendInputs(inputs []winInput) error {
	if len(inputs) == 0 {
		return nil
	}
	sent, _, err := procSendInput.Call(
		uintptr(len(inputs)),
		uintptr(unsafe.Pointer(&inputs[0])),
		unsafe.Sizeof(winInput{}),
	)
	if sent == 0 {
		return fmt.Errorf("SendInput failed: %v", err)
	}
	return nil
}

func makeMouseInput(dx, dy int32, data, flags uint32) winInput {
	var in winInput
	in.Type = inputMouse
	mi := (*mouseInput)(unsafe.Pointer(&in.Data[0]))
	mi.Dx = dx
	mi.Dy = dy
	mi.MouseData = data
	mi.DwFlags = flags
	return in
}

func makeKeyInput(vk, scan uint16, flags uint32) winInput {
	var in winInput
	in.Type = inputKeyboard
	ki := (*keybdInput)(unsafe.Pointer(&in.Data[0]))
	ki.WVk = vk
	ki.WScan = scan
	ki.DwFlags = flags
	return in
}

func normalizedToVirtual(disp displayInfo, nx, ny float64) (int32, int32) {
	if nx < 0 {
		nx = 0
	} else if nx > 1 {
		nx = 1
	}
	if ny < 0 {
		ny = 0
	} else if ny > 1 {
		ny = 1
	}
	vx, _, _ := procGetSystemMetrics.Call(smXVirtualScreen)
	vy, _, _ := procGetSystemMetrics.Call(smYVirtualScreen)
	vw, _, _ := procGetSystemMetrics.Call(smCXVirtualScreen)
	vh, _, _ := procGetSystemMetrics.Call(smCYVirtualScreen)
	vLeft := int32(vx)
	vTop := int32(vy)
	vWidth := int32(vw)
	vHeight := int32(vh)
	if vWidth <= 1 {
		vWidth = int32(disp.Width)
	}
	if vHeight <= 1 {
		vHeight = int32(disp.Height)
	}

	absX := int32(disp.Left) + int32(nx*float64(disp.Width))
	absY := int32(disp.Top) + int32(ny*float64(disp.Height))
	dx := int32((float64(absX-vLeft) * 65535.0) / float64(vWidth-1))
	dy := int32((float64(absY-vTop) * 65535.0) / float64(vHeight-1))
	return dx, dy
}

func injectMouse(req mouseReq) error {
	// Follow the lock screen desktop too (SYSTEM + secure-desktop mode).
	if detach := attachInputDesktop(); detach != nil {
		defer detach()
	}
	var inputs []winInput

	if req.Action == "move_rel" {
		inputs = append(inputs, makeMouseInput(int32(req.DX), int32(req.DY), 0, mouseEventfMove))
		return sendInputs(inputs)
	}

	disp, err := resolveDisplay(req.DisplayID)
	if err != nil {
		return err
	}

	if req.Action == "wheel" {
		if req.X >= 0 && req.Y >= 0 {
			dx, dy := normalizedToVirtual(disp, req.X, req.Y)
			inputs = append(inputs, makeMouseInput(dx, dy, 0, mouseEventfMove|mouseEventfAbsolute|mouseEventfVirtualDesk))
		}
		wheelDelta := uint32(int32(req.DeltaY))
		inputs = append(inputs, makeMouseInput(0, 0, wheelDelta, mouseEventfWheel))
		return sendInputs(inputs)
	}

	var dx, dy int32
	hasPos := req.X >= 0 && req.Y >= 0
	if hasPos {
		dx, dy = normalizedToVirtual(disp, req.X, req.Y)
	}

	downFlag := uint32(mouseEventfLeftDown)
	upFlag := uint32(mouseEventfLeftUp)
	switch req.Button {
	case "right":
		downFlag = mouseEventfRightDown
		upFlag = mouseEventfRightUp
	case "middle":
		downFlag = mouseEventfMiddleDown
		upFlag = mouseEventfMiddleUp
	}

	switch req.Action {
	case "move":
		if hasPos {
			inputs = append(inputs, makeMouseInput(dx, dy, 0, mouseEventfMove|mouseEventfAbsolute|mouseEventfVirtualDesk))
		}
	case "down":
		if hasPos {
			inputs = append(inputs, makeMouseInput(dx, dy, 0, mouseEventfMove|mouseEventfAbsolute|mouseEventfVirtualDesk))
		}
		inputs = append(inputs, makeMouseInput(0, 0, 0, downFlag))
	case "up":
		if hasPos {
			inputs = append(inputs, makeMouseInput(dx, dy, 0, mouseEventfMove|mouseEventfAbsolute|mouseEventfVirtualDesk))
		}
		inputs = append(inputs, makeMouseInput(0, 0, 0, upFlag))
	case "click":
		if hasPos {
			inputs = append(inputs, makeMouseInput(dx, dy, 0, mouseEventfMove|mouseEventfAbsolute|mouseEventfVirtualDesk))
		}
		inputs = append(inputs, makeMouseInput(0, 0, 0, downFlag), makeMouseInput(0, 0, 0, upFlag))
	case "dblclick":
		if hasPos {
			inputs = append(inputs, makeMouseInput(dx, dy, 0, mouseEventfMove|mouseEventfAbsolute|mouseEventfVirtualDesk))
		}
		inputs = append(inputs,
			makeMouseInput(0, 0, 0, downFlag), makeMouseInput(0, 0, 0, upFlag),
			makeMouseInput(0, 0, 0, downFlag), makeMouseInput(0, 0, 0, upFlag),
		)
	}
	return sendInputs(inputs)
}

func injectKey(req keyReq) error {
	if detach := attachInputDesktop(); detach != nil {
		defer detach()
	}
	vk := uint16(req.VK)
	if vk == 0 {
		return nil
	}
	var inputs []winInput

	if req.Action == "down" {
		inputs = append(inputs, makeKeyInput(vk, 0, 0))
		return sendInputs(inputs)
	}
	if req.Action == "up" {
		inputs = append(inputs, makeKeyInput(vk, 0, keyEventfKeyUp))
		return sendInputs(inputs)
	}

	// tap with modifiers
	var modVKs []uint16
	if req.Mods.Ctrl {
		modVKs = append(modVKs, vkControl)
	}
	if req.Mods.Alt {
		modVKs = append(modVKs, vkMenu)
	}
	if req.Mods.Shift {
		modVKs = append(modVKs, vkShift)
	}
	if req.Mods.Meta {
		modVKs = append(modVKs, vkLWin)
	}

	for _, m := range modVKs {
		inputs = append(inputs, makeKeyInput(m, 0, 0))
	}
	inputs = append(inputs, makeKeyInput(vk, 0, 0))
	inputs = append(inputs, makeKeyInput(vk, 0, keyEventfKeyUp))
	for i := len(modVKs) - 1; i >= 0; i-- {
		inputs = append(inputs, makeKeyInput(modVKs[i], 0, keyEventfKeyUp))
	}
	return sendInputs(inputs)
}

func injectText(text string) error {
	if text == "" {
		return nil
	}
	units := utf16.Encode([]rune(text))
	inputs := make([]winInput, 0, len(units)*2)
	for _, u := range units {
		if u == '\n' {
			inputs = append(inputs, makeKeyInput(0x0D, 0, 0), makeKeyInput(0x0D, 0, keyEventfKeyUp))
			continue
		}
		inputs = append(inputs,
			makeKeyInput(0, u, keyEventfUnicode),
			makeKeyInput(0, u, keyEventfUnicode|keyEventfKeyUp),
		)
	}
	return sendInputs(inputs)
}

func getClipboardText() (string, error) {
	ok, _, err := procOpenClipboard.Call(0)
	if ok == 0 {
		return "", fmt.Errorf("OpenClipboard failed: %v", err)
	}
	defer procCloseClipboard.Call()

	hData, _, _ := procGetClipboardData.Call(cfUnicodeText)
	if hData == 0 {
		return "", nil
	}
	ptr, _, err := procGlobalLock.Call(hData)
	if ptr == 0 {
		return "", fmt.Errorf("GlobalLock failed: %v", err)
	}
	defer procGlobalUnlock.Call(hData)

	// Read null-terminated UTF-16 string safely
	var units []uint16
	const maxChars = 1024 * 512
	for i := 0; i < maxChars; i++ {
		ch := *(*uint16)(unsafe.Pointer(ptr + uintptr(i)*2))
		if ch == 0 {
			break
		}
		units = append(units, ch)
	}
	return string(utf16.Decode(units)), nil
}

func setClipboardText(text string) error {
	units := utf16.Encode([]rune(text))
	units = append(units, 0)
	byteLen := len(units) * 2

	hMem, _, err := procGlobalAlloc.Call(gmemMoveable, uintptr(byteLen))
	if hMem == 0 {
		return fmt.Errorf("GlobalAlloc failed: %v", err)
	}
	ptr, _, err := procGlobalLock.Call(hMem)
	if ptr == 0 {
		procGlobalFree.Call(hMem)
		return fmt.Errorf("GlobalLock failed: %v", err)
	}
	dst := unsafe.Slice((*uint16)(unsafe.Pointer(ptr)), len(units))
	copy(dst, units)
	procGlobalUnlock.Call(hMem)

	ok, _, err := procOpenClipboard.Call(0)
	if ok == 0 {
		procGlobalFree.Call(hMem)
		return fmt.Errorf("OpenClipboard failed: %v", err)
	}
	defer procCloseClipboard.Call()

	procEmptyClipboard.Call()
	r, _, err := procSetClipboardData.Call(cfUnicodeText, hMem)
	if r == 0 {
		procGlobalFree.Call(hMem)
		return fmt.Errorf("SetClipboardData failed: %v", err)
	}
	clipWatchMu.Lock()
	lastKnownClipSeq = getClipboardSequence()
	clipWatchMu.Unlock()
	return nil
}

var _ = syscall.Handle(0)
