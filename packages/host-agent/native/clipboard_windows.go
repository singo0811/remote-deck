//go:build windows

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"image"
	"image/png"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

var (
	procGetClipboardSequenceNumber = user32.NewProc("GetClipboardSequenceNumber")
	procIsClipboardFormatAvailable = user32.NewProc("IsClipboardFormatAvailable")
)

const (
	cfDIB = 8
	// Base64 of this stays under ~8 MiB, keeping clipboard frames well inside the
	// 32 MiB WebSocket payload limit.
	maxClipboardPngBytes = 6 * 1024 * 1024
)

var (
	clipWatchMu      sync.Mutex
	clipWatching     atomic.Bool
	clipWatchStopCh  chan struct{}
	lastKnownClipSeq uint32
)

func getClipboardSequence() uint32 {
	r, _, _ := procGetClipboardSequenceNumber.Call()
	return uint32(r)
}

func getClipboardContent() (string, string, error) {
	txt, err := getClipboardText()
	if err == nil && txt != "" {
		return txt, "", nil
	}
	r, _, _ := procIsClipboardFormatAvailable.Call(cfDIB)
	if r != 0 {
		imgB64, imgErr := getClipboardPngBase64()
		if imgErr == nil && imgB64 != "" {
			return "", imgB64, nil
		}
	}
	return txt, "", err
}

func getClipboardPngBase64() (string, error) {
	ok, _, err := procOpenClipboard.Call(0)
	if ok == 0 {
		return "", fmt.Errorf("OpenClipboard failed: %v", err)
	}
	defer procCloseClipboard.Call()

	hData, _, _ := procGetClipboardData.Call(cfDIB)
	if hData == 0 {
		return "", nil
	}
	ptr, _, err := procGlobalLock.Call(hData)
	if ptr == 0 {
		return "", fmt.Errorf("GlobalLock failed: %v", err)
	}
	defer procGlobalUnlock.Call(hData)

	hdr := (*bitmapInfoHeader)(unsafe.Pointer(ptr))
	w := int(hdr.BiWidth)
	rawH := int(hdr.BiHeight)
	topDown := rawH < 0
	h := rawH
	if h < 0 {
		h = -h
	}
	if w <= 0 || h <= 0 || w > 4096 || h > 4096 {
		return "", fmt.Errorf("unsupported clipboard image size %dx%d", w, h)
	}
	bpp := int(hdr.BiBitCount)
	if bpp != 24 && bpp != 32 {
		return "", fmt.Errorf("unsupported clipboard bpp %d", bpp)
	}
	offset := uintptr(hdr.BiSize)
	if hdr.BiCompression == 3 { // BI_BITFIELDS
		offset += 12
	}
	stride := ((w*bpp + 31) / 32) * 4
	pixBase := ptr + offset
	pixSlice := unsafe.Slice((*byte)(unsafe.Pointer(pixBase)), stride*h)

	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		srcY := y
		if !topDown {
			srcY = h - 1 - y
		}
		srcRow := srcY * stride
		dstRow := y * w * 4
		for x := 0; x < w; x++ {
			si := srcRow + x*(bpp/8)
			di := dstRow + x*4
			img.Pix[di+0] = pixSlice[si+2]
			img.Pix[di+1] = pixSlice[si+1]
			img.Pix[di+2] = pixSlice[si+0]
			if bpp == 32 && pixSlice[si+3] != 0 {
				img.Pix[di+3] = pixSlice[si+3]
			} else {
				img.Pix[di+3] = 255
			}
		}
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return "", err
	}
	// Large screenshots would blow past the WebSocket frame budget, so skip them.
	if buf.Len() > maxClipboardPngBytes {
		return "", fmt.Errorf("clipboard image too large (%d bytes PNG)", buf.Len())
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

func setClipboardImageBase64(b64 string) error {
	clean := b64
	if idx := strings.Index(clean, ","); idx >= 0 && strings.HasPrefix(clean, "data:") {
		clean = clean[idx+1:]
	}
	rawPng, err := base64.StdEncoding.DecodeString(clean)
	if err != nil {
		return err
	}
	img, err := png.Decode(bytes.NewReader(rawPng))
	if err != nil {
		return err
	}
	bounds := img.Bounds()
	w := bounds.Dx()
	h := bounds.Dy()
	if w <= 0 || h <= 0 || w > 4096 || h > 4096 {
		return fmt.Errorf("invalid image bounds %dx%d", w, h)
	}

	hdrSize := 40
	stride := w * 4
	totalSize := hdrSize + stride*h
	hMem, _, err := procGlobalAlloc.Call(gmemMoveable, uintptr(totalSize))
	if hMem == 0 {
		return fmt.Errorf("GlobalAlloc failed: %v", err)
	}
	ptr, _, err := procGlobalLock.Call(hMem)
	if ptr == 0 {
		procGlobalFree.Call(hMem)
		return fmt.Errorf("GlobalLock failed: %v", err)
	}

	dst := unsafe.Slice((*byte)(unsafe.Pointer(ptr)), totalSize)
	binary.LittleEndian.PutUint32(dst[0:4], 40)
	binary.LittleEndian.PutUint32(dst[4:8], uint32(int32(w)))
	binary.LittleEndian.PutUint32(dst[8:12], uint32(int32(h))) // bottom-up DIB
	binary.LittleEndian.PutUint16(dst[12:14], 1)
	binary.LittleEndian.PutUint16(dst[14:16], 32)
	binary.LittleEndian.PutUint32(dst[16:20], biRGB)
	binary.LittleEndian.PutUint32(dst[20:24], uint32(stride*h))

	for y := 0; y < h; y++ {
		srcY := bounds.Min.Y + (h - 1 - y)
		rowOff := hdrSize + y*stride
		for x := 0; x < w; x++ {
			r, g, b, a := img.At(bounds.Min.X+x, srcY).RGBA()
			di := rowOff + x*4
			dst[di+0] = byte(b >> 8)
			dst[di+1] = byte(g >> 8)
			dst[di+2] = byte(r >> 8)
			dst[di+3] = byte(a >> 8)
		}
	}
	procGlobalUnlock.Call(hMem)

	ok, _, err := procOpenClipboard.Call(0)
	if ok == 0 {
		procGlobalFree.Call(hMem)
		return fmt.Errorf("OpenClipboard failed: %v", err)
	}
	procEmptyClipboard.Call()
	r, _, err := procSetClipboardData.Call(cfDIB, hMem)
	procCloseClipboard.Call()
	if r == 0 {
		procGlobalFree.Call(hMem)
		return fmt.Errorf("SetClipboardData failed: %v", err)
	}
	clipWatchMu.Lock()
	lastKnownClipSeq = getClipboardSequence()
	clipWatchMu.Unlock()
	return nil
}

func setClipboardWatch(enabled bool) {
	clipWatchMu.Lock()
	defer clipWatchMu.Unlock()
	if enabled == clipWatching.Load() {
		return
	}
	if !enabled {
		clipWatching.Store(false)
		if clipWatchStopCh != nil {
			close(clipWatchStopCh)
			clipWatchStopCh = nil
		}
		return
	}
	lastKnownClipSeq = getClipboardSequence()
	stopCh := make(chan struct{})
	clipWatchStopCh = stopCh
	clipWatching.Store(true)
	go func() {
		ticker := time.NewTicker(450 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stopCh:
				return
			case <-ticker.C:
				seq := getClipboardSequence()
				clipWatchMu.Lock()
				prev := lastKnownClipSeq
				if seq != 0 && seq != prev {
					lastKnownClipSeq = seq
					clipWatchMu.Unlock()
					txt, imgB64, err := getClipboardContent()
					if err == nil && (txt != "" || imgB64 != "") {
						writeJSONFrame(evtClipboard, map[string]any{
							"op":          "changed",
							"text":        txt,
							"imageBase64": imgB64,
						})
					}
				} else {
					clipWatchMu.Unlock()
				}
			}
		}
	}()
}
