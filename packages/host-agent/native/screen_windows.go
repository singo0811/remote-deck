//go:build windows

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"hash/fnv"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	procSetProcessDpiAwarenessContext = user32.NewProc("SetProcessDpiAwarenessContext")
	procSetProcessDPIAware            = user32.NewProc("SetProcessDPIAware")
	procEnumDisplayMonitors           = user32.NewProc("EnumDisplayMonitors")
	procGetMonitorInfoW               = user32.NewProc("GetMonitorInfoW")
	procGetDC                         = user32.NewProc("GetDC")
	procReleaseDC                     = user32.NewProc("ReleaseDC")
	procGetSystemMetrics              = user32.NewProc("GetSystemMetrics")
	procGetCursorPos                  = user32.NewProc("GetCursorPos")
	procGetCursorInfo                 = user32.NewProc("GetCursorInfo")
	procGetIconInfo                   = user32.NewProc("GetIconInfo")
	procDrawIconEx                    = user32.NewProc("DrawIconEx")

	procCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	procDeleteDC               = gdi32.NewProc("DeleteDC")
	procCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	procCreateDIBSection       = gdi32.NewProc("CreateDIBSection")
	procGdiFlush               = gdi32.NewProc("GdiFlush")
	procSelectObject           = gdi32.NewProc("SelectObject")
	procDeleteObject           = gdi32.NewProc("DeleteObject")
	procBitBlt                 = gdi32.NewProc("BitBlt")
	procStretchBlt             = gdi32.NewProc("StretchBlt")
	procSetStretchBltMode      = gdi32.NewProc("SetStretchBltMode")
	procSetBrushOrgEx          = gdi32.NewProc("SetBrushOrgEx")
	procGetDIBits              = gdi32.NewProc("GetDIBits")
)

const (
	smXVirtualScreen   = 76
	smYVirtualScreen   = 77
	smCXVirtualScreen  = 78
	smCYVirtualScreen  = 79
	srccopy            = 0x00CC0020
	captureblt         = 0x40000000
	halftoneStretch    = 4
	biRGB              = 0
	dibRGBColors       = 0
	monitorinfoPrimary = 1
	cursorShowing      = 0x00000001
	diNormal           = 0x0003
)

type rect struct {
	Left, Top, Right, Bottom int32
}

type point struct {
	X, Y int32
}

type monitorInfoExW struct {
	CbSize    uint32
	RcMonitor rect
	RcWork    rect
	DwFlags   uint32
	SzDevice  [32]uint16
}

type bitmapInfoHeader struct {
	BiSize          uint32
	BiWidth         int32
	BiHeight        int32
	BiPlanes        uint16
	BiBitCount      uint16
	BiCompression   uint32
	BiSizeImage     uint32
	BiXPelsPerMeter int32
	BiYPelsPerMeter int32
	BiClrUsed       uint32
	BiClrImportant  uint32
}

type displayInfo struct {
	ID      int    `json:"id"`
	Name    string `json:"name"`
	Left    int    `json:"left"`
	Top     int    `json:"top"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Primary bool   `json:"primary"`
}

func initPlatform() {
	// Per-Monitor DPI Aware v2 = -4
	dpiCtx := ^uintptr(3)
	r, _, _ := procSetProcessDpiAwarenessContext.Call(dpiCtx)
	if r == 0 {
		procSetProcessDPIAware.Call()
	}
}

type cursorInfo struct {
	CbSize      uint32
	Flags       uint32
	HCursor     uintptr
	PtScreenPos point
}

type iconInfo struct {
	FIcon    int32
	XHotspot uint32
	YHotspot uint32
	HbmMask  uintptr
	HbmColor uintptr
}

var (
	dispCacheMu    sync.RWMutex
	dispCache      []displayInfo
	dispCacheAt    time.Time
	captureMu      sync.Mutex
	captureRawBuf  []byte
	prevRawBuf     []byte
	roiVideoBuf    []byte
	prevVideoRoiKey string
	prevRawW       int
	prevRawH       int
	prevRawDispID  int
	captureRGBA    *image.RGBA
	captureJpegBuf bytes.Buffer
	// Reused across frames: allocating tens of MB per frame caused GC spikes
	// (capture p95 was 69ms with a 129ms tail).
	subPixBuf     []byte
	stripPixBufs  [][]byte
	stripJpegBufs []bytes.Buffer

	cachedMemDC   uintptr
	cachedDibBmp  uintptr
	cachedOldObj  uintptr
	cachedDibPtr  uintptr
	cachedDibW    int
	cachedDibH    int
)

func listDisplaysFresh() ([]displayInfo, error) {
	displays, err := listDisplaysRaw()
	if err != nil {
		return nil, err
	}
	dispCacheMu.Lock()
	dispCache = displays
	dispCacheAt = time.Now()
	dispCacheMu.Unlock()
	return displays, nil
}

func listDisplaysCached() ([]displayInfo, error) {
	dispCacheMu.RLock()
	if len(dispCache) > 0 && time.Since(dispCacheAt) < 2*time.Second {
		out := dispCache
		dispCacheMu.RUnlock()
		return out, nil
	}
	dispCacheMu.RUnlock()
	return listDisplaysFresh()
}

func listDisplays() ([]displayInfo, error) {
	return listDisplaysFresh()
}

func listDisplaysRaw() ([]displayInfo, error) {
	var displays []displayInfo
	cb := syscall.NewCallback(func(hMonitor uintptr, hdcMonitor uintptr, lprcMonitor *rect, dwData uintptr) uintptr {
		var mi monitorInfoExW
		mi.CbSize = uint32(unsafe.Sizeof(mi))
		ret, _, _ := procGetMonitorInfoW.Call(hMonitor, uintptr(unsafe.Pointer(&mi)))
		if ret != 0 {
			name := syscall.UTF16ToString(mi.SzDevice[:])
			if name == "" {
				name = fmt.Sprintf("Display %d", len(displays)+1)
			}
			displays = append(displays, displayInfo{
				ID:      len(displays),
				Name:    name,
				Left:    int(mi.RcMonitor.Left),
				Top:     int(mi.RcMonitor.Top),
				Width:   int(mi.RcMonitor.Right - mi.RcMonitor.Left),
				Height:  int(mi.RcMonitor.Bottom - mi.RcMonitor.Top),
				Primary: (mi.DwFlags & monitorinfoPrimary) != 0,
			})
		}
		return 1
	})

	ret, _, err := procEnumDisplayMonitors.Call(0, 0, cb, 0)
	if ret == 0 && len(displays) == 0 {
		return nil, fmt.Errorf("EnumDisplayMonitors failed: %v", err)
	}
	if len(displays) == 0 {
		w, _, _ := procGetSystemMetrics.Call(smCXVirtualScreen)
		h, _, _ := procGetSystemMetrics.Call(smCYVirtualScreen)
		l, _, _ := procGetSystemMetrics.Call(smXVirtualScreen)
		t, _, _ := procGetSystemMetrics.Call(smYVirtualScreen)
		displays = append(displays, displayInfo{
			ID:      0,
			Name:    "Primary",
			Left:    int(int32(l)),
			Top:     int(int32(t)),
			Width:   int(int32(w)),
			Height:  int(int32(h)),
			Primary: true,
		})
	}
	return displays, nil
}

func resolveDisplay(displayID int) (displayInfo, error) {
	displays, err := listDisplaysCached()
	if err != nil {
		return displayInfo{}, err
	}
	if displayID >= 0 && displayID < len(displays) {
		return displays[displayID], nil
	}
	for _, d := range displays {
		if d.Primary {
			return d, nil
		}
	}
	return displays[0], nil
}

// Go-side pacing: the node/Electron main loop cannot fire timers on time while it
// drains frame pipes, so the producer enforces the cadence itself. Callers may
// simply request frames back-to-back; each call returns at the next slot.
var (
	paceMu       sync.Mutex
	paceNextSlot time.Time
)

func waitForSlot(paceMS int) {
	if paceMS <= 0 {
		return
	}
	paceMu.Lock()
	now := time.Now()
	if paceNextSlot.IsZero() || paceNextSlot.Before(now.Add(-time.Duration(paceMS)*2*time.Millisecond)) {
		paceNextSlot = now
	}
	slot := paceNextSlot
	paceMu.Unlock()

	if wait := time.Until(slot); wait > 0 {
		time.Sleep(wait)
	}
	paceMu.Lock()
	paceNextSlot = paceNextSlot.Add(time.Duration(paceMS) * time.Millisecond)
	paceMu.Unlock()
}

func captureDisplay(req captureReq) (map[string]any, []byte, error) {
	waitForSlot(req.PaceMS)
	startedAt := time.Now()
	captureMu.Lock()
	defer captureMu.Unlock()

	// When running as SYSTEM in the interactive session, follow the visible
	// desktop so a locked workstation still yields real pixels.
	if detach := attachInputDesktop(); detach != nil {
		defer detach()
	}

	disp, err := resolveDisplay(req.DisplayID)
	if err != nil {
		return nil, nil, err
	}
	if disp.Width <= 0 || disp.Height <= 0 {
		return nil, nil, fmt.Errorf("invalid display size %dx%d", disp.Width, disp.Height)
	}

	scale := req.Scale
	if scale <= 0.1 || scale > 1.0 {
		scale = 0.75
	}
	quality := req.Quality
	if quality < 15 || quality > 95 {
		quality = 70
	}

	outW := int(float64(disp.Width) * scale)
	outH := int(float64(disp.Height) * scale)
	if req.MaxWidth > 0 && outW > req.MaxWidth && disp.Width > 0 {
		outW = req.MaxWidth
		outH = int(float64(disp.Height) * float64(req.MaxWidth) / float64(disp.Width))
	}
	if req.Video {
		// yuv420p encoders require even width and height.
		outW &^= 1
		outH &^= 1
	}
	if outW < 64 {
		outW = 64
	}
	if outH < 64 {
		outH = 64
	}

	hdcScreen, _, err := procGetDC.Call(0)
	if hdcScreen == 0 {
		return nil, nil, fmt.Errorf("GetDC failed: %v", err)
	}
	defer procReleaseDC.Call(0, hdcScreen)

	if err := ensureCaptureSurface(hdcScreen, outW, outH); err != nil {
		return nil, nil, err
	}
	hdcMem := cachedMemDC
	needRaw := outW * outH * 4
	raw := unsafe.Slice((*byte)(unsafe.Pointer(cachedDibPtr)), needRaw)

	captureBackend := "dxgi"
	capBackendStart := time.Now()
	usedDxgi, desktopChanged, dxgiErr := dxgiState.captureToBuffer(disp, raw, outW, outH)
	backendMs := float64(time.Since(capBackendStart).Microseconds()) / 1000
	if !usedDxgi || dxgiErr != nil {
		captureBackend = "gdi"
		if outW == disp.Width && outH == disp.Height {
			ok, _, err := procBitBlt.Call(
				hdcMem, 0, 0, uintptr(outW), uintptr(outH),
				hdcScreen, uintptr(disp.Left), uintptr(disp.Top),
				srccopy|captureblt,
			)
			if ok == 0 {
				return nil, nil, fmt.Errorf("BitBlt failed: %v", err)
			}
		} else {
			procSetStretchBltMode.Call(hdcMem, halftoneStretch)
			procSetBrushOrgEx.Call(hdcMem, 0, 0, 0)
			ok, _, err := procStretchBlt.Call(
				hdcMem, 0, 0, uintptr(outW), uintptr(outH),
				hdcScreen, uintptr(disp.Left), uintptr(disp.Top), uintptr(disp.Width), uintptr(disp.Height),
				srccopy|captureblt,
			)
			if ok == 0 {
				return nil, nil, fmt.Errorf("StretchBlt failed: %v", err)
			}
		}
	}

	_ = desktopChanged
	if !req.SeparateCursor {
		drawSystemCursor(hdcMem, disp, outW, outH)
	}
	procGdiFlush.Call()

	// Compute sampled FNV-1a hash + cursor position to skip unchanged frames quickly
	h := fnv.New64a()
	step := 64
	for i := 0; i < len(raw); i += step {
		end := i + 16
		if end > len(raw) {
			end = len(raw)
		}
		_, _ = h.Write(raw[i:end])
	}
	cursor := readNormalizedCursor(disp)
	if !req.SeparateCursor {
		var curBuf [8]byte
		binary.LittleEndian.PutUint32(curBuf[0:4], uint32(cursor.px))
		binary.LittleEndian.PutUint32(curBuf[4:8], uint32(cursor.py))
		_, _ = h.Write(curBuf[:])
	}
	frameHash := fmt.Sprintf("%x", h.Sum64())
	var cursorShapeOut map[string]any
	if req.SeparateCursor {
		if shape := captureCursorShape(); shape != nil && shape.ID != req.CursorShapeID {
			cursorShapeOut = map[string]any{
				"id":  shape.ID,
				"w":   shape.W,
				"h":   shape.H,
				"hx":  shape.HotX,
				"hy":  shape.HotY,
				"png": shape.PngB64,
			}
		}
	}

	// H.264 mode: pipe the raw BGRA frame (or ROI crop) straight into ffmpeg (no JPEG encode).
	if req.Video {
		roiKey := ""
		var roiMeta *videoRoiMeta
		vidBuf := raw
		vidW := outW
		vidH := outH
		if req.RoiW > 0.01 && req.RoiH > 0.01 {
			cx := int(req.RoiX * float64(outW))
			cy := int(req.RoiY * float64(outH))
			cw := int(req.RoiW * float64(outW))
			ch := int(req.RoiH * float64(outH))
			if cx < 0 { cx = 0 }
			if cy < 0 { cy = 0 }
			cw &^= 1
			ch &^= 1
			if cw < 64 { cw = 64 }
			if ch < 64 { ch = 64 }
			if cx+cw > outW { cx = outW - cw }
			if cy+ch > outH { cy = outH - ch }
			if cx < 0 { cx = 0; cw = outW &^ 1 }
			if cy < 0 { cy = 0; ch = outH &^ 1 }
			roiKey = fmt.Sprintf("%d:%d:%d:%d:%d:%d", cx, cy, cw, ch, outW, outH)
			needCrop := cw * ch * 4
			if len(roiVideoBuf) < needCrop {
				roiVideoBuf = make([]byte, needCrop)
			}
			cropBuf := roiVideoBuf[:needCrop]
			rowBytes := cw * 4
			srcStride := outW * 4
			for row := 0; row < ch; row++ {
				srcOff := (cy+row)*srcStride + cx*4
				dstOff := row * rowBytes
				copy(cropBuf[dstOff:dstOff+rowBytes], raw[srcOff:srcOff+rowBytes])
			}
			vidBuf = cropBuf
			vidW = cw
			vidH = ch
			roiMeta = &videoRoiMeta{
				X:          float64(cx) / float64(outW),
				Y:          float64(cy) / float64(outH),
				W:          float64(cw) / float64(outW),
				H:          float64(ch) / float64(outH),
				FullWidth:  outW,
				FullHeight: outH,
			}
		}
		if !req.ForceKey && req.LastHash != "" && req.LastHash == frameHash && prevVideoRoiKey == roiKey && videoRunning.Load() {
			resp := map[string]any{
				"reqId":        req.ReqID,
				"displayId":    disp.ID,
				"width":        vidW,
				"height":       vidH,
				"nativeWidth":  disp.Width,
				"nativeHeight": disp.Height,
				"seq":          req.Seq,
				"hash":         frameHash,
				"unchanged":    true,
				"cursorX":      cursor.nx,
				"cursorY":      cursor.ny,
				"video":        true,
				"backend":      captureBackend,
				"bt":           backendMs,
				"gdi":          !usedDxgi,
			}
			if cursorShapeOut != nil {
				resp["cursorShape"] = cursorShapeOut
			}
			return resp, nil, nil
		}
		if req.ForceKey {
			stopVideoEncoder()
		}
		prevVideoRoiKey = roiKey
		setVideoRoiMeta(roiMeta)
		if err := startVideoEncoderIfNeeded(vidW, vidH, req.FPS, req.Quality); err != nil {
			return nil, nil, err
		}
		if err := feedVideoFrame(vidBuf, vidW, vidH); err != nil {
			return nil, nil, err
		}
		resp := map[string]any{
			"reqId":        req.ReqID,
			"displayId":    disp.ID,
			"width":        vidW,
			"height":       vidH,
			"nativeWidth":  disp.Width,
			"nativeHeight": disp.Height,
			"seq":          req.Seq,
			"hash":         frameHash,
			"unchanged":    false,
			"cursorX":      cursor.nx,
			"cursorY":      cursor.ny,
			"video":        true,
			"backend":      captureBackend,
			"bt":           backendMs,
			"gdi":          !usedDxgi,
		}
		if roiMeta != nil {
			resp["fullWidth"] = outW
			resp["fullHeight"] = outH
			resp["roi"] = map[string]float64{"x": roiMeta.X, "y": roiMeta.Y, "w": roiMeta.W, "h": roiMeta.H}
		}
		if cursorShapeOut != nil {
			resp["cursorShape"] = cursorShapeOut
		}
		return resp, nil, nil
	}

	if req.LastHash != "" && req.LastHash == frameHash {
		resp := map[string]any{
			"reqId":        req.ReqID,
			"displayId":    disp.ID,
			"width":        outW,
			"height":       outH,
			"nativeWidth":  disp.Width,
			"nativeHeight": disp.Height,
			"seq":          req.Seq,
			"hash":         frameHash,
			"unchanged":    true,
			"cursorX":      cursor.nx,
			"cursorY":      cursor.ny,
		}
		if cursorShapeOut != nil {
			resp["cursorShape"] = cursorShapeOut
		}
		return resp, nil, nil
	}

	// Detect dirty regions when the previous frame buffer matches dimensions.
	// Several independent rectangles are kept (typing + clock + cursor), instead
	// of one big bounding box that re-encodes half the screen.
	useDirty := false
	var rects []dirtyRect
	if req.AllowDirty && req.LastHash != "" && prevRawW == outW && prevRawH == outH && prevRawDispID == disp.ID && len(prevRawBuf) == needRaw {
		rects = computeDirtyRects(prevRawBuf, raw, outW, outH, maxDirtyRects)
		if len(rects) == 0 {
			resp := map[string]any{
				"reqId":        req.ReqID,
				"displayId":    disp.ID,
				"width":        outW,
				"height":       outH,
				"nativeWidth":  disp.Width,
				"nativeHeight": disp.Height,
				"seq":          req.Seq,
				"hash":         frameHash,
				"unchanged":    true,
				"cursorX":      cursor.nx,
				"cursorY":      cursor.ny,
			}
			if cursorShapeOut != nil {
				resp["cursorShape"] = cursorShapeOut
			}
			return resp, nil, nil
		}
		total := 0
		for _, r := range rects {
			total += r.W * r.H
		}
		if total > 0 && total*100 < outW*outH*45 {
			useDirty = true
		}
	}

	if cap(prevRawBuf) < needRaw {
		prevRawBuf = make([]byte, needRaw)
	}
	prevRawBuf = prevRawBuf[:needRaw]
	copy(prevRawBuf, raw)
	prevRawW = outW
	prevRawH = outH
	prevRawDispID = disp.ID

	baseMeta := func() map[string]any {
		m := map[string]any{
			"reqId":        req.ReqID,
			"displayId":    disp.ID,
			"width":        outW,
			"height":       outH,
			"nativeWidth":  disp.Width,
			"nativeHeight": disp.Height,
			"seq":          req.Seq,
			"hash":         frameHash,
			"unchanged":    false,
			"cursorX":      cursor.nx,
			"cursorY":      cursor.ny,
			"backend":      captureBackend,
			"bt":           backendMs,
			"gdi":          !usedDxgi,
			"t":            float64(time.Since(startedAt).Microseconds()) / 1000,
		}
		if cursorShapeOut != nil {
			m["cursorShape"] = cursorShapeOut
		}
		return m
	}

	encodeRect := func(r dirtyRect, buf *bytes.Buffer) ([]byte, error) {
		need := r.W * r.H * 4
		if cap(subPixBuf) < need {
			subPixBuf = make([]byte, need)
		}
		subImg := &image.RGBA{Pix: subPixBuf[:need], Stride: r.W * 4, Rect: image.Rect(0, 0, r.W, r.H)}
		bgraSubToRgba(raw, subImg.Pix, outW, r.X, r.Y, r.W, r.H)
		if err := jpeg.Encode(buf, subImg, &jpeg.Options{Quality: quality}); err != nil {
			return nil, err
		}
		out := make([]byte, buf.Len())
		copy(out, buf.Bytes())
		return out, nil
	}

	if useDirty {
		// First rectangle goes back to the caller, the rest are emitted directly.
		first := rects[0]
		captureJpegBuf.Reset()
		jpegBytes, err := encodeRect(first, &captureJpegBuf)
		if err != nil {
			return nil, nil, err
		}
		for _, r := range rects[1:] {
			captureJpegBuf.Reset()
			extra, encErr := encodeRect(r, &captureJpegBuf)
			if encErr != nil {
				continue
			}
			m := baseMeta()
			m["dirty"] = map[string]int{"x": r.X, "y": r.Y, "w": r.W, "h": r.H}
			writeScreenFrame(m, extra)
		}
		meta := baseMeta()
		meta["dirty"] = map[string]int{"x": first.X, "y": first.Y, "w": first.W, "h": first.H}
		return meta, jpegBytes, nil
	}

	// Region-of-interest: encode only the requested sub-rectangle, at 1:1 pixels.
	if req.RoiW > 0.01 && req.RoiH > 0.01 {
		cx := int(req.RoiX * float64(outW))
		cy := int(req.RoiY * float64(outH))
		cw := int(req.RoiW * float64(outW))
		ch := int(req.RoiH * float64(outH))
		if cx < 0 { cx = 0 }
		if cy < 0 { cy = 0 }
		if cx+cw > outW { cw = outW - cx }
		if cy+ch > outH { ch = outH - cy }
		if cw > 8 && ch > 8 {
			need := cw * ch * 4
			if cap(subPixBuf) < need {
				subPixBuf = make([]byte, need)
			}
			sub := &image.RGBA{Pix: subPixBuf[:need], Stride: cw * 4, Rect: image.Rect(0, 0, cw, ch)}
			bgraSubToRgba(raw, sub.Pix, outW, cx, cy, cw, ch)
			captureJpegBuf.Reset()
			if err := jpeg.Encode(&captureJpegBuf, sub, &jpeg.Options{Quality: quality}); err != nil {
				return nil, nil, err
			}
			out := make([]byte, captureJpegBuf.Len())
			copy(out, captureJpegBuf.Bytes())
			m := baseMeta()
			m["width"] = cw
			m["height"] = ch
			m["fullWidth"] = outW
			m["fullHeight"] = outH
			m["roi"] = map[string]float64{"x": req.RoiX, "y": req.RoiY, "w": req.RoiW, "h": req.RoiH}
			return m, out, nil
		}
	}

	if captureRGBA == nil || captureRGBA.Bounds().Dx() != outW || captureRGBA.Bounds().Dy() != outH {
		captureRGBA = image.NewRGBA(image.Rect(0, 0, outW, outH))
	}
	rgba := captureRGBA
	bgraToRgbaParallel(raw, rgba.Pix, outW, outH)

	// Split the full frame into horizontal strips encoded in parallel: JPEG is
	// single-threaded, and on a 3440x1440 desktop that was the fps ceiling.
	// Each strip is a valid JPEG, sent as an independent dirty rectangle, which
	// the client already knows how to composite.
	//
	// Never split the "keyframe" (lastHash == "" means the client lost its
	// baseline, e.g. after a scale/zoom change): it must arrive as ONE plain
	// frame so the client can resize its canvas before patches land.
	keyFrame := req.LastHash == ""
	if req.AllowDirty && !req.SingleFrame && !keyFrame && outW >= 1800 && outH >= 240 && quality >= 50 {
		stripCount := runtime.NumCPU()
		if stripCount > 6 {
			stripCount = 6
		}
		if stripCount > 1 {
			stripH := (outH + stripCount - 1) / stripCount
			type stripResult struct {
				idx  int
				y0   int
				h    int
				data []byte
				err  error
			}
			results := make([]stripResult, stripCount)
			for len(stripPixBufs) < stripCount {
				stripPixBufs = append(stripPixBufs, nil)
			}
			for len(stripJpegBufs) < stripCount {
				var nb bytes.Buffer
				stripJpegBufs = append(stripJpegBufs, nb)
			}
			var wg sync.WaitGroup
			for i := 0; i < stripCount; i++ {
				y0 := i * stripH
				y1 := y0 + stripH
				if y1 > outH {
					y1 = outH
				}
				if y0 >= y1 {
					break
				}
				wg.Add(1)
				go func(idx, top, bottom int) {
					defer wg.Done()
					sh := bottom - top
					need := outW * sh * 4
					if cap(stripPixBufs[idx]) < need {
						stripPixBufs[idx] = make([]byte, need)
					}
					sub := &image.RGBA{Pix: stripPixBufs[idx][:need], Stride: outW * 4, Rect: image.Rect(0, 0, outW, sh)}
					bgraSubToRgba(raw, sub.Pix, outW, 0, top, outW, sh)
					buf := &stripJpegBufs[idx]
					buf.Reset()
					if err := jpeg.Encode(buf, sub, &jpeg.Options{Quality: quality}); err != nil {
						results[idx] = stripResult{idx: idx, err: err}
						return
					}
					out := make([]byte, buf.Len())
					copy(out, buf.Bytes())
					results[idx] = stripResult{idx: idx, y0: top, h: bottom - top, data: out}
				}(i, y0, y1)
			}
			wg.Wait()

			var first []byte
			firstY, firstH := 0, 0
			for i := 0; i < stripCount; i++ {
				r := results[i]
				if r.err != nil || r.data == nil {
					continue
				}
				m := baseMeta()
				m["dirty"] = map[string]int{"x": 0, "y": r.y0, "w": outW, "h": r.h}
				if first == nil {
					first, firstY, firstH = r.data, r.y0, r.h
					continue
				}
				writeScreenFrame(m, r.data)
			}
			if first != nil {
				meta := baseMeta()
				meta["dirty"] = map[string]int{"x": 0, "y": firstY, "w": outW, "h": firstH}
				return meta, first, nil
			}
		}
	}

	captureJpegBuf.Reset()
	if err := jpeg.Encode(&captureJpegBuf, rgba, &jpeg.Options{Quality: quality}); err != nil {
		return nil, nil, err
	}
	jpegCopy := make([]byte, captureJpegBuf.Len())
	copy(jpegCopy, captureJpegBuf.Bytes())
	return baseMeta(), jpegCopy, nil
}

func ensureCaptureSurface(hdcScreen uintptr, w, h int) error {
	if cachedMemDC != 0 && cachedDibBmp != 0 && cachedDibPtr != 0 && cachedDibW == w && cachedDibH == h {
		return nil
	}
	if cachedMemDC != 0 {
		if cachedOldObj != 0 {
			procSelectObject.Call(cachedMemDC, cachedOldObj)
			cachedOldObj = 0
		}
		if cachedDibBmp != 0 {
			procDeleteObject.Call(cachedDibBmp)
			cachedDibBmp = 0
		}
		procDeleteDC.Call(cachedMemDC)
		cachedMemDC = 0
		cachedDibPtr = 0
	}

	hdcMem, _, err := procCreateCompatibleDC.Call(hdcScreen)
	if hdcMem == 0 {
		return fmt.Errorf("CreateCompatibleDC failed: %v", err)
	}
	var bmi bitmapInfoHeader
	bmi.BiSize = uint32(unsafe.Sizeof(bmi))
	bmi.BiWidth = int32(w)
	bmi.BiHeight = -int32(h)
	bmi.BiPlanes = 1
	bmi.BiBitCount = 32
	bmi.BiCompression = biRGB

	var bitsPtr uintptr
	hBmp, _, err := procCreateDIBSection.Call(
		hdcMem,
		uintptr(unsafe.Pointer(&bmi)),
		dibRGBColors,
		uintptr(unsafe.Pointer(&bitsPtr)),
		0,
		0,
	)
	if hBmp == 0 || bitsPtr == 0 {
		procDeleteDC.Call(hdcMem)
		return fmt.Errorf("CreateDIBSection failed: %v", err)
	}
	oldObj, _, _ := procSelectObject.Call(hdcMem, hBmp)
	cachedMemDC = hdcMem
	cachedDibBmp = hBmp
	cachedOldObj = oldObj
	cachedDibPtr = bitsPtr
	cachedDibW = w
	cachedDibH = h
	return nil
}

func drawSystemCursor(hdcMem uintptr, disp displayInfo, outW, outH int) {
	var ci cursorInfo
	ci.CbSize = uint32(unsafe.Sizeof(ci))
	r, _, _ := procGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci)))
	if r == 0 || (ci.Flags&cursorShowing) == 0 || ci.HCursor == 0 {
		return
	}
	if ci.PtScreenPos.X < int32(disp.Left)-64 || ci.PtScreenPos.X > int32(disp.Left+disp.Width)+64 ||
		ci.PtScreenPos.Y < int32(disp.Top)-64 || ci.PtScreenPos.Y > int32(disp.Top+disp.Height)+64 {
		return
	}
	var ii iconInfo
	var hotX, hotY int32
	ok, _, _ := procGetIconInfo.Call(ci.HCursor, uintptr(unsafe.Pointer(&ii)))
	if ok != 0 {
		hotX = int32(ii.XHotspot)
		hotY = int32(ii.YHotspot)
		if ii.HbmMask != 0 {
			procDeleteObject.Call(ii.HbmMask)
		}
		if ii.HbmColor != 0 {
			procDeleteObject.Call(ii.HbmColor)
		}
	}
	scaleX := float64(outW) / float64(disp.Width)
	scaleY := float64(outH) / float64(disp.Height)
	drawX := int(float64(ci.PtScreenPos.X-int32(disp.Left)-hotX) * scaleX)
	drawY := int(float64(ci.PtScreenPos.Y-int32(disp.Top)-hotY) * scaleY)
	cw := int(32 * scaleX)
	ch := int(32 * scaleY)
	if cw < 16 {
		cw = 16
	}
	if ch < 16 {
		ch = 16
	}
	procDrawIconEx.Call(hdcMem, uintptr(drawX), uintptr(drawY), ci.HCursor, uintptr(cw), uintptr(ch), 0, 0, diNormal)
}

type cachedCursorShape struct {
	ID     uint64
	Handle uintptr
	W      int
	H      int
	HotX   int
	HotY   int
	PngB64 string
}

var (
	cursorShapeMu     sync.Mutex
	cursorShapeSeq    uint64
	cursorShapeCached *cachedCursorShape
)

func renderIconDib(hdcRef uintptr, hCursor uintptr, w, h int, fillByte byte) ([]byte, bool) {
	hdcMem, _, _ := procCreateCompatibleDC.Call(hdcRef)
	if hdcMem == 0 {
		return nil, false
	}
	defer procDeleteDC.Call(hdcMem)
	var bmi bitmapInfoHeader
	bmi.BiSize = uint32(unsafe.Sizeof(bmi))
	bmi.BiWidth = int32(w)
	bmi.BiHeight = -int32(h)
	bmi.BiPlanes = 1
	bmi.BiBitCount = 32
	bmi.BiCompression = biRGB
	var bitsPtr uintptr
	hBmp, _, _ := procCreateDIBSection.Call(hdcMem, uintptr(unsafe.Pointer(&bmi)), dibRGBColors, uintptr(unsafe.Pointer(&bitsPtr)), 0, 0)
	if hBmp == 0 || bitsPtr == 0 {
		return nil, false
	}
	defer procDeleteObject.Call(hBmp)
	oldObj, _, _ := procSelectObject.Call(hdcMem, hBmp)
	defer procSelectObject.Call(hdcMem, oldObj)

	pix := unsafe.Slice((*byte)(unsafe.Pointer(bitsPtr)), w*h*4)
	for i := range pix {
		pix[i] = fillByte
	}
	procDrawIconEx.Call(hdcMem, 0, 0, hCursor, uintptr(w), uintptr(h), 0, 0, diNormal)
	procGdiFlush.Call()
	out := make([]byte, len(pix))
	copy(out, pix)
	return out, true
}

func captureCursorShape() *cachedCursorShape {
	var ci cursorInfo
	ci.CbSize = uint32(unsafe.Sizeof(ci))
	r, _, _ := procGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci)))
	if r == 0 || (ci.Flags&cursorShowing) == 0 || ci.HCursor == 0 {
		return nil
	}
	cursorShapeMu.Lock()
	defer cursorShapeMu.Unlock()
	if cursorShapeCached != nil && cursorShapeCached.Handle == ci.HCursor {
		return cursorShapeCached
	}
	var ii iconInfo
	var hotX, hotY int
	if ok, _, _ := procGetIconInfo.Call(ci.HCursor, uintptr(unsafe.Pointer(&ii))); ok != 0 {
		hotX = int(ii.XHotspot)
		hotY = int(ii.YHotspot)
		if ii.HbmMask != 0 {
			procDeleteObject.Call(ii.HbmMask)
		}
		if ii.HbmColor != 0 {
			procDeleteObject.Call(ii.HbmColor)
		}
	}
	const cw, ch = 32, 32
	hdcScreen, _, _ := procGetDC.Call(0)
	if hdcScreen == 0 {
		return nil
	}
	defer procReleaseDC.Call(0, hdcScreen)
	blackPix, okB := renderIconDib(hdcScreen, ci.HCursor, cw, ch, 0x00)
	whitePix, okW := renderIconDib(hdcScreen, ci.HCursor, cw, ch, 0xFF)
	if !okB || !okW {
		return nil
	}
	img := image.NewNRGBA(image.Rect(0, 0, cw, ch))
	for y := 0; y < ch; y++ {
		for x := 0; x < cw; x++ {
			off := (y*cw + x) * 4
			bB, gB, rB := int(blackPix[off+0]), int(blackPix[off+1]), int(blackPix[off+2])
			bW, gW, rW := int(whitePix[off+0]), int(whitePix[off+1]), int(whitePix[off+2])
			if rW < rB && gW < gB && bW < bB {
				// XOR-inverted monochrome cursor pixels (e.g. text I-beam): render crisp dark outline.
				img.SetNRGBA(x, y, color.NRGBA{R: 20, G: 24, B: 32, A: 240})
				continue
			}
			aR := 255 - (rW - rB)
			aG := 255 - (gW - gB)
			aB := 255 - (bW - bB)
			a := (aR + aG + aB) / 3
			if a <= 4 {
				img.SetNRGBA(x, y, color.NRGBA{0, 0, 0, 0})
				continue
			}
			if a > 255 {
				a = 255
			}
			rr := (rB * 255) / a
			gg := (gB * 255) / a
			bb := (bB * 255) / a
			if rr > 255 { rr = 255 }
			if gg > 255 { gg = 255 }
			if bb > 255 { bb = 255 }
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(rr), G: uint8(gg), B: uint8(bb), A: uint8(a)})
		}
	}
	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, img); err != nil {
		return nil
	}
	cursorShapeSeq++
	cursorShapeCached = &cachedCursorShape{
		ID:     cursorShapeSeq,
		Handle: ci.HCursor,
		W:      cw,
		H:      ch,
		HotX:   hotX,
		HotY:   hotY,
		PngB64: base64.StdEncoding.EncodeToString(pngBuf.Bytes()),
	}
	return cursorShapeCached
}

type dirtyRect struct{ X, Y, W, H int }

const maxDirtyRects = 4

// computeDirtyRects returns up to maxRects tight rectangles covering changed
// pixels. Neighbouring row bands are merged until the budget is met.
func computeDirtyRects(prev, cur []byte, w, h, maxRects int) []dirtyRect {
	if w <= 0 || h <= 0 || maxRects < 1 {
		return nil
	}
	stride := w * 4
	rows := make([]int, 0, h/4+1)
	for y := 0; y < h; y++ {
		off := y * stride
		if !bytes.Equal(prev[off:off+stride], cur[off:off+stride]) {
			rows = append(rows, y)
		}
	}
	if len(rows) == 0 {
		return nil
	}

	type band struct{ y0, y1 int }
	bands := make([]band, 0, len(rows)/2+1)
	start, prevY := rows[0], rows[0]
	for _, y := range rows[1:] {
		if y == prevY+1 {
			prevY = y
			continue
		}
		bands = append(bands, band{start, prevY})
		start, prevY = y, y
	}
	bands = append(bands, band{start, prevY})

	for len(bands) > maxRects {
		best, bestGap := 0, 1<<30
		for i := 0; i+1 < len(bands); i++ {
			gap := bands[i+1].y0 - bands[i].y1
			if gap < bestGap {
				bestGap, best = gap, i
			}
		}
		bands[best] = band{bands[best].y0, bands[best+1].y1}
		bands = append(bands[:best+1], bands[best+2:]...)
	}

	const pad = 8
	out := make([]dirtyRect, 0, len(bands))
	for _, b := range bands {
		minX, maxX := w, -1
		for y := b.y0; y <= b.y1; y++ {
			row := y * stride
			for x := 0; x < minX; x++ {
				i := row + x*4
				if prev[i] != cur[i] || prev[i+1] != cur[i+1] || prev[i+2] != cur[i+2] {
					minX = x
					break
				}
			}
			for x := w - 1; x > maxX; x-- {
				i := row + x*4
				if prev[i] != cur[i] || prev[i+1] != cur[i+1] || prev[i+2] != cur[i+2] {
					maxX = x
					break
				}
			}
			if minX == 0 && maxX == w-1 {
				break
			}
		}
		if maxX < minX {
			continue
		}
		x0, y0 := minX-pad, b.y0-pad
		if x0 < 0 {
			x0 = 0
		}
		if y0 < 0 {
			y0 = 0
		}
		x1, y1 := maxX+1+pad, b.y1+1+pad
		if x1 > w {
			x1 = w
		}
		if y1 > h {
			y1 = h
		}
		if x1 <= x0 || y1 <= y0 {
			continue
		}
		out = append(out, dirtyRect{X: x0, Y: y0, W: x1 - x0, H: y1 - y0})
	}
	return out
}

func computeDirtyBounds(prev, cur []byte, w, h int) (bool, int, int, int, int) {
	stride := w * 4
	minY := h
	maxY := -1
	for y := 0; y < h; y++ {
		off := y * stride
		if !bytes.Equal(prev[off:off+stride], cur[off:off+stride]) {
			if y < minY {
				minY = y
			}
			maxY = y
		}
	}
	if maxY < minY {
		return false, 0, 0, 0, 0
	}
	minX := w
	maxX := -1
	for y := minY; y <= maxY; y++ {
		row := y * stride
		// Find first differing pixel in row from left
		for x := 0; x < minX; x++ {
			i := row + x*4
			if prev[i] != cur[i] || prev[i+1] != cur[i+1] || prev[i+2] != cur[i+2] {
				minX = x
				break
			}
		}
		// Find last differing pixel in row from right
		for x := w - 1; x > maxX; x-- {
			i := row + x*4
			if prev[i] != cur[i] || prev[i+1] != cur[i+1] || prev[i+2] != cur[i+2] {
				maxX = x
				break
			}
		}
		if minX == 0 && maxX == w-1 {
			break
		}
	}
	if maxX < minX {
		return false, 0, 0, 0, 0
	}
	pad := 8
	x0 := minX - pad
	if x0 < 0 {
		x0 = 0
	}
	y0 := minY - pad
	if y0 < 0 {
		y0 = 0
	}
	x1 := maxX + 1 + pad
	if x1 > w {
		x1 = w
	}
	y1 := maxY + 1 + pad
	if y1 > h {
		y1 = h
	}
	return true, x0, y0, x1, y1
}

func bgraSubToRgba(raw, dst []byte, fullW, x0, y0, dw, dh int) {
	fullStride := fullW * 4
	dstStride := dw * 4
	for y := 0; y < dh; y++ {
		srcRow := (y0+y)*fullStride + x0*4
		dstRow := y * dstStride
		for x := 0; x < dw; x++ {
			si := srcRow + x*4
			di := dstRow + x*4
			dst[di+0] = raw[si+2]
			dst[di+1] = raw[si+1]
			dst[di+2] = raw[si+0]
			dst[di+3] = 255
		}
	}
}

func bgraToRgbaParallel(raw []byte, dst []byte, w, h int) {
	workers := runtime.NumCPU()
	if workers > 8 {
		workers = 8
	}
	if workers < 2 || h < 64 {
		bgraToRgbaRows(raw, dst, w, 0, h)
		return
	}
	var wg sync.WaitGroup
	rowsPer := (h + workers - 1) / workers
	for wi := 0; wi < workers; wi++ {
		y0 := wi * rowsPer
		y1 := y0 + rowsPer
		if y1 > h {
			y1 = h
		}
		if y0 >= y1 {
			break
		}
		wg.Add(1)
		go func(startY, endY int) {
			defer wg.Done()
			bgraToRgbaRows(raw, dst, w, startY, endY)
		}(y0, y1)
	}
	wg.Wait()
}

func bgraToRgbaRows(raw []byte, dst []byte, w, startY, endY int) {
	stride := w * 4
	for y := startY; y < endY; y++ {
		base := y * stride
		end := base + stride
		for i := base; i < end; i += 4 {
			dst[i+0] = raw[i+2]
			dst[i+1] = raw[i+1]
			dst[i+2] = raw[i+0]
			dst[i+3] = 255
		}
	}
}

type ptNorm struct {
	px int32
	py int32
	nx float64
	ny float64
}

func readNormalizedCursor(disp displayInfo) ptNorm {
	var pt point
	r, _, _ := procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	if r == 0 || disp.Width <= 0 || disp.Height <= 0 {
		return ptNorm{}
	}
	nx := float64(pt.X-int32(disp.Left)) / float64(disp.Width)
	ny := float64(pt.Y-int32(disp.Top)) / float64(disp.Height)
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
	return ptNorm{px: pt.X, py: pt.Y, nx: nx, ny: ny}
}
