//go:build !windows

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"image"
	"image/jpeg"
	_ "image/png"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type displayInfo struct {
	ID      int    `json:"id"`
	Name    string `json:"name"`
	Left    int    `json:"left"`
	Top     int    `json:"top"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Primary bool   `json:"primary"`
}

var (
	otherCursorMu      sync.Mutex
	otherCursorX       = 0.5
	otherCursorY       = 0.5
	otherVideoDisplay  = displayInfo{ID: 0, Name: "Primary", Left: 0, Top: 0, Width: 1920, Height: 1080, Primary: true}
	otherDisplaysCache []displayInfo
)

func initPlatform() {}

func listDisplaysFresh() ([]displayInfo, error) {
	displays, err := queryPlatformDisplays()
	if err != nil {
		return nil, err
	}
	otherCursorMu.Lock()
	otherDisplaysCache = append([]displayInfo(nil), displays...)
	otherCursorMu.Unlock()
	return displays, nil
}

func listDisplays() ([]displayInfo, error) {
	otherCursorMu.Lock()
	cached := append([]displayInfo(nil), otherDisplaysCache...)
	otherCursorMu.Unlock()
	if len(cached) > 0 {
		return cached, nil
	}
	return listDisplaysFresh()
}

func parseMacDisplaysJSON(raw []byte) []displayInfo {
	var parsed struct {
		SPDisplaysDataType []struct {
			Ndrvs []map[string]any `json:"spdisplays_ndrvs"`
		} `json:"SPDisplaysDataType"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil
	}
	var displays []displayInfo
	offsetX := 0
	for _, gpu := range parsed.SPDisplaysDataType {
		for _, drv := range gpu.Ndrvs {
			resStr, _ := drv["_spdisplays_pixels"].(string)
			if resStr == "" {
				resStr, _ = drv["_spdisplays_resolution"].(string)
			}
			w, h := parseDimensions(resStr)
			if w <= 0 || h <= 0 {
				continue
			}
			name, _ := drv["_name"].(string)
			if name == "" {
				name = fmt.Sprintf("Display %d", len(displays)+1)
			}
			mainFlag, _ := drv["spdisplays_main"].(string)
			primary := mainFlag == "spdisplays_yes"
			displays = append(displays, displayInfo{
				ID:      len(displays),
				Name:    name,
				Left:    offsetX,
				Top:     0,
				Width:   w,
				Height:  h,
				Primary: primary,
			})
			offsetX += w
		}
	}
	return displays
}

func parseDimensions(s string) (int, int) {
	fields := strings.Fields(strings.ReplaceAll(s, "x", " x "))
	for i := 1; i+1 < len(fields); i++ {
		if strings.EqualFold(fields[i], "x") {
			w, err1 := strconv.Atoi(fields[i-1])
			h, err2 := strconv.Atoi(fields[i+1])
			if err1 == nil && err2 == nil && w > 0 && h > 0 {
				return w, h
			}
		}
	}
	return 0, 0
}

func pickDisplay(displayID int) displayInfo {
	displays, _ := listDisplays()
	for _, d := range displays {
		if d.ID == displayID {
			return d
		}
	}
	if len(displays) > 0 {
		return displays[0]
	}
	return displayInfo{ID: 0, Name: "Primary", Left: 0, Top: 0, Width: 1920, Height: 1080, Primary: true}
}

func computeScaledSize(srcW, srcH int, scale float64, maxWidth int) (int, int) {
	if scale <= 0.1 || scale > 1.0 {
		scale = 0.75
	}
	outW := int(float64(srcW) * scale)
	outH := int(float64(srcH) * scale)
	if maxWidth > 0 && outW > maxWidth {
		outH = (outH * maxWidth) / outW
		outW = maxWidth
	}
	if outW < 64 {
		outW = 64
	}
	if outH < 64 {
		outH = 64
	}
	outW &^= 1
	outH &^= 1
	return outW, outH
}

func captureDisplay(req captureReq) (map[string]any, []byte, error) {
	disp := pickDisplay(req.DisplayID)
	otherCursorMu.Lock()
	cx, cy := otherCursorX, otherCursorY
	otherCursorMu.Unlock()

	if req.Video && videoEncoderAvailable() && (req.RoiW <= 0 || req.RoiH <= 0) {
		vidW, vidH := computeScaledSize(disp.Width, disp.Height, req.Scale, req.MaxWidth)
		otherCursorMu.Lock()
		needRestart := otherVideoDisplay.ID != disp.ID || otherVideoDisplay.Width != disp.Width || otherVideoDisplay.Height != disp.Height
		otherVideoDisplay = disp
		otherCursorMu.Unlock()
		if needRestart {
			stopVideoEncoder()
		}
		if err := startVideoEncoderIfNeeded(vidW, vidH, req.FPS, req.Quality); err == nil {
			return map[string]any{
				"reqId":        req.ReqID,
				"displayId":    disp.ID,
				"width":        vidW,
				"height":       vidH,
				"nativeWidth":  disp.Width,
				"nativeHeight": disp.Height,
				"seq":          req.Seq,
				"video":        true,
				"codec":        "h264",
				"cursorX":      cx,
				"cursorY":      cy,
				"backend":      runtime.GOOS,
			}, []byte{}, nil
		}
	} else {
		stopVideoEncoder()
	}

	var nativeRoi *image.Rectangle
	hasRoi := req.RoiW > 0.01 && req.RoiH > 0.01
	if hasRoi && disp.Width > 0 && disp.Height > 0 {
		rx0 := int(req.RoiX * float64(disp.Width))
		ry0 := int(req.RoiY * float64(disp.Height))
		rw := int(req.RoiW * float64(disp.Width))
		rh := int(req.RoiH * float64(disp.Height))
		if rw > 16 && rh > 16 {
			r := image.Rect(rx0, ry0, rx0+rw, ry0+rh).Intersect(image.Rect(0, 0, disp.Width, disp.Height))
			if !r.Empty() {
				nativeRoi = &r
			}
		}
	}

	pngBytes, err := captureRawScreenPng(disp, nativeRoi)
	if err != nil {
		return nil, nil, err
	}
	srcImg, _, err := image.Decode(bytes.NewReader(pngBytes))
	if err != nil {
		return nil, nil, err
	}
	b := srcImg.Bounds()
	cropRect := b
	if hasRoi && nativeRoi == nil {
		rx0 := b.Min.X + int(req.RoiX*float64(b.Dx()))
		ry0 := b.Min.Y + int(req.RoiY*float64(b.Dy()))
		rx1 := rx0 + int(req.RoiW*float64(b.Dx()))
		ry1 := ry0 + int(req.RoiH*float64(b.Dy()))
		cropRect = image.Rect(rx0, ry0, rx1, ry1).Intersect(b)
		if cropRect.Empty() {
			cropRect = b
			hasRoi = false
		}
	}
	srcW, srcH := cropRect.Dx(), cropRect.Dy()
	quality := req.Quality
	if quality < 15 || quality > 95 {
		quality = 70
	}
	outW, outH := computeScaledSize(srcW, srcH, req.Scale, req.MaxWidth)

	dst := image.NewRGBA(image.Rect(0, 0, outW, outH))
	for y := 0; y < outH; y++ {
		sy := cropRect.Min.Y + (y*srcH)/outH
		for x := 0; x < outW; x++ {
			sx := cropRect.Min.X + (x*srcW)/outW
			dst.Set(x, y, srcImg.At(sx, sy))
		}
	}

	h := fnv.New64a()
	for i := 0; i < len(dst.Pix); i += 64 {
		end := i + 16
		if end > len(dst.Pix) {
			end = len(dst.Pix)
		}
		_, _ = h.Write(dst.Pix[i:end])
	}
	frameHash := fmt.Sprintf("%x", h.Sum64())
	if req.LastHash != "" && req.LastHash == frameHash {
		return map[string]any{
			"reqId":        req.ReqID,
			"displayId":    disp.ID,
			"width":        outW,
			"height":       outH,
			"nativeWidth":  disp.Width,
			"nativeHeight": disp.Height,
			"seq":          req.Seq,
			"hash":         frameHash,
			"unchanged":    true,
			"cursorX":      cx,
			"cursorY":      cy,
		}, nil, nil
	}

	var jpegBuf bytes.Buffer
	if err := jpeg.Encode(&jpegBuf, dst, &jpeg.Options{Quality: quality}); err != nil {
		return nil, nil, err
	}
	meta := map[string]any{
		"reqId":        req.ReqID,
		"displayId":    disp.ID,
		"width":        outW,
		"height":       outH,
		"nativeWidth":  disp.Width,
		"nativeHeight": disp.Height,
		"seq":          req.Seq,
		"hash":         frameHash,
		"unchanged":    false,
		"cursorX":      cx,
		"cursorY":      cy,
		"backend":      runtime.GOOS,
	}
	if hasRoi {
		fullW, fullH := computeScaledSize(disp.Width, disp.Height, req.Scale, req.MaxWidth)
		meta["fullWidth"] = fullW
		meta["fullHeight"] = fullH
		meta["roi"] = map[string]float64{
			"x": req.RoiX,
			"y": req.RoiY,
			"w": req.RoiW,
			"h": req.RoiH,
		}
	}
	return meta, jpegBuf.Bytes(), nil
}

func injectMouse(req mouseReq) error {
	disp := pickDisplay(req.DisplayID)
	otherCursorMu.Lock()
	if req.Action == "move_rel" {
		if disp.Width > 0 {
			otherCursorX += req.DX / float64(disp.Width)
		}
		if disp.Height > 0 {
			otherCursorY += req.DY / float64(disp.Height)
		}
		if otherCursorX < 0 {
			otherCursorX = 0
		} else if otherCursorX > 1 {
			otherCursorX = 1
		}
		if otherCursorY < 0 {
			otherCursorY = 0
		} else if otherCursorY > 1 {
			otherCursorY = 1
		}
	} else if req.X >= 0 && req.Y >= 0 {
		otherCursorX = req.X
		otherCursorY = req.Y
	}
	nx, ny := otherCursorX, otherCursorY
	otherCursorMu.Unlock()

	px := disp.Left + int(nx*float64(disp.Width))
	py := disp.Top + int(ny*float64(disp.Height))
	return injectMousePlatform(req, disp, px, py)
}

func injectKey(req keyReq) error {
	if req.VK <= 0 {
		return nil
	}
	return injectKeyPlatform(req)
}

func vkToXKeysym(vk int) string {
	if vk >= 65 && vk <= 90 {
		return strings.ToLower(string(rune(vk)))
	}
	if vk >= 48 && vk <= 57 {
		return string(rune(vk))
	}
	if vk >= 0x70 && vk <= 0x7b {
		return fmt.Sprintf("F%d", 1+(vk-0x70))
	}
	switch vk {
	case 0x0d:
		return "Return"
	case 0x1b:
		return "Escape"
	case 0x08:
		return "BackSpace"
	case 0x09:
		return "Tab"
	case 0x20:
		return "space"
	case 0x21:
		return "Prior"
	case 0x22:
		return "Next"
	case 0x23:
		return "End"
	case 0x24:
		return "Home"
	case 0x25:
		return "Left"
	case 0x26:
		return "Up"
	case 0x27:
		return "Right"
	case 0x28:
		return "Down"
	case 0x2d:
		return "Insert"
	case 0x2e:
		return "Delete"
	case 0x10:
		return "Shift_L"
	case 0x11:
		return "Control_L"
	case 0x12:
		return "Alt_L"
	case 0x5b:
		return "Super_L"
	case 0xba:
		return "semicolon"
	case 0xbb:
		return "equal"
	case 0xbc:
		return "comma"
	case 0xbd:
		return "minus"
	case 0xbe:
		return "period"
	case 0xbf:
		return "slash"
	case 0xc0:
		return "grave"
	case 0xdb:
		return "bracketleft"
	case 0xdc:
		return "backslash"
	case 0xdd:
		return "bracketright"
	case 0xde:
		return "apostrophe"
	}
	return ""
}

func vkToMacKeyCode(vk int) (int, bool) {
	macLetters := map[int]int{
		'A': 0, 'S': 1, 'D': 2, 'F': 3, 'H': 4, 'G': 5, 'Z': 6, 'X': 7, 'C': 8, 'V': 9,
		'B': 11, 'Q': 12, 'W': 13, 'E': 14, 'R': 15, 'Y': 16, 'T': 17, '1': 18, '2': 19, '3': 20,
		'4': 21, '6': 22, '5': 23, '9': 25, '7': 26, '8': 28, '0': 29, 'O': 31, 'U': 32, 'I': 34,
		'P': 35, 'L': 37, 'J': 38, 'K': 40, 'N': 45, 'M': 46,
	}
	if c, ok := macLetters[vk]; ok {
		return c, true
	}
	macSpecial := map[int]int{
		0x0d: 36,  // Return
		0x09: 48,  // Tab
		0x20: 49,  // Space
		0x08: 51,  // Delete (Backspace)
		0x1b: 53,  // Escape
		0x2e: 117, // Forward Delete
		0x24: 115, // Home
		0x23: 119, // End
		0x21: 116, // Page Up
		0x22: 121, // Page Down
		0x25: 123, // Left
		0x27: 124, // Right
		0x28: 125, // Down
		0x26: 126, // Up
		0x70: 122, // F1
		0x71: 120, // F2
		0x72: 99,  // F3
		0x73: 118, // F4
		0x74: 96,  // F5
		0x75: 97,  // F6
		0x76: 98,  // F7
		0x77: 100, // F8
		0x78: 101, // F9
		0x79: 109, // F10
		0x7a: 103, // F11
		0x7b: 111, // F12
		0xba: 41,  // ;
		0xbb: 24,  // =
		0xbc: 43,  // ,
		0xbd: 27,  // -
		0xbe: 47,  // .
		0xbf: 44,  // /
		0xc0: 50,  // `
		0xdb: 33,  // [
		0xdc: 42,  // \
		0xdd: 30,  // ]
		0xde: 39,  // '
	}
	c, ok := macSpecial[vk]
	return c, ok
}

func injectText(text string) error {
	if text == "" {
		return nil
	}
	return injectTextPlatform(text)
}

func getClipboardContent() (string, string, error) {
	txt, err := getClipboardText()
	if txt != "" {
		return txt, "", err
	}
	if img := getClipboardImageBase64(); img != "" {
		return "", img, nil
	}
	return "", "", err
}

var (
	clipWatchMu     sync.Mutex
	clipWatchActive atomic.Bool
	clipWatchStop   chan struct{}
)

func setClipboardWatch(enabled bool) {
	clipWatchMu.Lock()
	defer clipWatchMu.Unlock()
	if enabled == clipWatchActive.Load() {
		return
	}
	if !enabled {
		clipWatchActive.Store(false)
		if clipWatchStop != nil {
			close(clipWatchStop)
			clipWatchStop = nil
		}
		return
	}
	clipWatchActive.Store(true)
	stopCh := make(chan struct{})
	clipWatchStop = stopCh
	go func() {
		last, _ := getClipboardText()
		ticker := time.NewTicker(900 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stopCh:
				return
			case <-ticker.C:
				cur, err := getClipboardText()
				if err == nil && cur != "" && cur != last {
					last = cur
					writeJSONFrame(evtClipboard, map[string]any{
						"op":   "changed",
						"text": cur,
					})
				}
			}
		}
	}()
}

var (
	otherAudioMu      sync.Mutex
	otherAudioRunning atomic.Bool
	otherAudioCmd     *exec.Cmd
	otherAudioStop    chan struct{}
)

func startAudioCapture(lowBandwidth bool) {
	startAudioCaptureWithOpts(lowBandwidth, true)
}

func startAudioCaptureWithOpts(lowBandwidth bool, preferOpus bool) {
	otherAudioMu.Lock()
	defer otherAudioMu.Unlock()
	if otherAudioRunning.Load() {
		return
	}
	if !opusEncoderAvailable() {
		return
	}
	kbps := 96
	if lowBandwidth {
		kbps = 48
	}
	args := []string{"-hide_banner", "-loglevel", "error"}
	args = append(args, audioCaptureInputArgs()...)
	if preferOpus {
		args = append(args,
			"-ar", "48000", "-ac", "2",
			"-c:a", "libopus", "-application", "lowdelay",
			"-frame_duration", "20", "-b:a", fmt.Sprintf("%dk", kbps),
			"-page_duration", "20000", "-flush_packets", "1",
			"-f", "ogg", "pipe:1",
		)
	} else {
		args = append(args, "-ar", "48000", "-ac", "2", "-f", "s16le", "pipe:1")
	}

	cmd := exec.Command("ffmpeg", args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return
	}
	if err := cmd.Start(); err != nil {
		return
	}

	stopCh := make(chan struct{})
	otherAudioCmd = cmd
	otherAudioStop = stopCh
	otherAudioRunning.Store(true)

	go func() {
		defer otherAudioRunning.Store(false)
		if preferOpus {
			var sentHead bool
			parser := &opusPipe{}
			parser.readOggStream(stdout, func(pkt []byte, head []byte) {
				if !otherAudioRunning.Load() {
					return
				}
				meta := map[string]any{
					"codec":      "opus",
					"sampleRate": 48000,
					"channels":   2,
					"frames":     960,
				}
				if !sentHead && len(head) >= 19 {
					sentHead = true
					meta["head"] = base64.StdEncoding.EncodeToString(head)
				}
				metaBytes, _ := json.Marshal(meta)
				out := make([]byte, 4+len(metaBytes)+len(pkt))
				binary.BigEndian.PutUint32(out[0:4], uint32(len(metaBytes)))
				copy(out[4:4+len(metaBytes)], metaBytes)
				copy(out[4+len(metaBytes):], pkt)
				_ = writeFrame(evtAudioFrame, out)
			})
		} else {
			buf := make([]byte, 3840) // 20ms @ 48kHz stereo S16LE
			for otherAudioRunning.Load() {
				if _, err := io.ReadFull(stdout, buf); err != nil {
					break
				}
				metaBytes, _ := json.Marshal(map[string]any{
					"codec":      "pcm16",
					"sampleRate": 48000,
					"channels":   2,
					"frames":     960,
				})
				out := make([]byte, 4+len(metaBytes)+len(buf))
				binary.BigEndian.PutUint32(out[0:4], uint32(len(metaBytes)))
				copy(out[4:4+len(metaBytes)], metaBytes)
				copy(out[4+len(metaBytes):], buf)
				_ = writeFrame(evtAudioFrame, out)
			}
		}
		_ = cmd.Wait()
	}()
}

func stopAudioCapture() {
	otherAudioMu.Lock()
	defer otherAudioMu.Unlock()
	if !otherAudioRunning.Load() {
		return
	}
	otherAudioRunning.Store(false)
	if otherAudioStop != nil {
		close(otherAudioStop)
		otherAudioStop = nil
	}
	if otherAudioCmd != nil && otherAudioCmd.Process != nil {
		_ = otherAudioCmd.Process.Kill()
	}
	otherAudioCmd = nil
}

func setPrivacyScreen(enabled bool) error {
	return setPrivacyScreenPlatform(enabled)
}
func isProcessElevated() bool {
	return os.Geteuid() == 0
}

type ptySession struct {
	id        string
	cmd       *exec.Cmd
	inWriter  io.WriteCloser
	ctrlWrite io.WriteCloser
	once      sync.Once
}

var (
	ptyMu  sync.Mutex
	ptyMap = map[string]*ptySession{}
)

const unixPtyHelper = `
import os, pty, sys, fcntl, struct, termios, select, signal, json

shell = sys.argv[1]
cols = int(sys.argv[2])
rows = int(sys.argv[3])
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp(shell, [shell, "-l"])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
ctrl_fd = 3
while True:
    rfds = [fd, 0]
    try:
        os.fstat(ctrl_fd)
        rfds.append(ctrl_fd)
    except OSError:
        pass
    r, _, _ = select.select(rfds, [], [])
    if fd in r:
        try:
            d = os.read(fd, 8192)
        except OSError:
            break
        if not d:
            break
        os.write(1, d)
    if 0 in r:
        d = os.read(0, 4096)
        if not d:
            break
        os.write(fd, d)
    if ctrl_fd in r:
        line = os.read(ctrl_fd, 512)
        for part in line.splitlines():
            try:
                m = json.loads(part.decode("utf-8"))
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(m["rows"]), int(m["cols"]), 0, 0))
            except Exception:
                pass
`

func openPty(req ptyOpenReq) {
	if req.ID == "" {
		return
	}
	closePty(req.ID)
	shell := "/bin/sh"
	if runtime.GOOS == "darwin" {
		if _, err := os.Stat("/bin/zsh"); err == nil {
			shell = "/bin/zsh"
		}
	} else if _, err := os.Stat("/bin/bash"); err == nil {
		shell = "/bin/bash"
	}

	cols := req.Cols
	if cols <= 0 {
		cols = 100
	}
	rows := req.Rows
	if rows <= 0 {
		rows = 30
	}

	var cmd *exec.Cmd
	var ctrlRead *os.File
	var ctrlWrite *os.File
	mode := "pipe"

	if py, err := exec.LookPath("python3"); err == nil {
		rPipe, wPipe, pErr := os.Pipe()
		if pErr == nil {
			ctrlRead = rPipe
			ctrlWrite = wPipe
			cmd = exec.Command(py, "-u", "-c", unixPtyHelper, shell, strconv.Itoa(cols), strconv.Itoa(rows))
			cmd.ExtraFiles = []*os.File{ctrlRead}
			mode = "pty"
		}
	}
	if cmd == nil {
		cmd = exec.Command(shell)
	}
	if req.Cwd != "" {
		cmd.Dir = req.Cwd
	}
	inPipe, err := cmd.StdinPipe()
	if err != nil {
		if ctrlRead != nil {
			_ = ctrlRead.Close()
		}
		if ctrlWrite != nil {
			_ = ctrlWrite.Close()
		}
		return
	}
	outPipe, err := cmd.StdoutPipe()
	if err != nil {
		_ = inPipe.Close()
		if ctrlRead != nil {
			_ = ctrlRead.Close()
		}
		if ctrlWrite != nil {
			_ = ctrlWrite.Close()
		}
		return
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		if ctrlRead != nil {
			_ = ctrlRead.Close()
		}
		if ctrlWrite != nil {
			_ = ctrlWrite.Close()
		}
		return
	}
	if ctrlRead != nil {
		_ = ctrlRead.Close()
	}

	sess := &ptySession{id: req.ID, cmd: cmd, inWriter: inPipe, ctrlWrite: ctrlWrite}
	ptyMu.Lock()
	ptyMap[req.ID] = sess
	ptyMu.Unlock()
	writeJSONFrame(evtPtyOpened, map[string]any{"id": req.ID, "mode": mode})

	go func() {
		buf := make([]byte, 8192)
		idBytes := []byte(req.ID)
		for {
			n, err := outPipe.Read(buf)
			if n > 0 {
				out := make([]byte, 4+len(idBytes)+n)
				binary.BigEndian.PutUint32(out[0:4], uint32(len(idBytes)))
				copy(out[4:4+len(idBytes)], idBytes)
				copy(out[4+len(idBytes):], buf[:n])
				_ = writeFrame(evtPtyOutput, out)
			}
			if err != nil {
				break
			}
		}
		_ = cmd.Wait()
		closePty(req.ID)
		writeJSONFrame(evtPtyExit, map[string]any{"id": req.ID, "code": 0})
	}()
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
	if sess != nil && sess.ctrlWrite != nil && cols > 0 && rows > 0 {
		line, _ := json.Marshal(map[string]int{"cols": cols, "rows": rows})
		_, _ = sess.ctrlWrite.Write(append(line, '\n'))
	}
}

func closePty(id string) {
	ptyMu.Lock()
	sess := ptyMap[id]
	delete(ptyMap, id)
	ptyMu.Unlock()
	if sess != nil {
		sess.once.Do(func() {
			if sess.inWriter != nil {
				_ = sess.inWriter.Close()
			}
			if sess.ctrlWrite != nil {
				_ = sess.ctrlWrite.Close()
			}
			if sess.cmd != nil && sess.cmd.Process != nil {
				_ = sess.cmd.Process.Kill()
			}
		})
	}
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
