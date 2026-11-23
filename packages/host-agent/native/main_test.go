//go:build windows

package main

import (
	"bytes"
	"testing"
	"time"
	"unsafe"
)

func TestWinInputStructSize(t *testing.T) {
	if got := unsafe.Sizeof(winInput{}); got != 40 {
		t.Fatalf("expected winInput size 40 on amd64, got %d", got)
	}
}

func TestListDisplaysAndCapture(t *testing.T) {
	initPlatform()
	displays, err := listDisplays()
	if err != nil {
		t.Fatalf("listDisplays failed: %v", err)
	}
	if len(displays) == 0 {
		t.Fatalf("expected at least 1 display")
	}
	meta, jpegBytes, err := captureDisplay(captureReq{
		ReqID:     "t1",
		DisplayID: 0,
		Scale:     0.25,
		Quality:   50,
		Seq:       1,
	})
	if err != nil {
		t.Fatalf("captureDisplay failed: %v", err)
	}
	if len(jpegBytes) < 100 || jpegBytes[0] != 0xFF || jpegBytes[1] != 0xD8 {
		t.Fatalf("expected valid JPEG bytes, got len=%d", len(jpegBytes))
	}
	if meta["width"].(int) < 64 || meta["height"].(int) < 64 {
		t.Fatalf("unexpected captured dimensions: %+v", meta)
	}
	t.Logf("capture #1 backend=%v %dx%d bytes=%d", meta["backend"], meta["width"], meta["height"], len(jpegBytes))

	meta2, jpeg2, err := captureDisplay(captureReq{
		ReqID:      "t2",
		DisplayID:  0,
		Scale:      0.25,
		Quality:    50,
		LastHash:   meta["hash"].(string),
		Seq:        2,
		AllowDirty: true,
	})
	if err != nil {
		t.Fatalf("second captureDisplay failed: %v", err)
	}
	t.Logf("capture #2 backend=%v unchanged=%v dirty=%v bytes=%d", meta2["backend"], meta2["unchanged"], meta2["dirty"], len(jpeg2))
}

func TestComputeDirtyRects(t *testing.T) {
	const w, h = 400, 300
	prev := make([]byte, w*h*4)
	cur := make([]byte, w*h*4)
	copy(cur, prev)

	fill := func(x0, y0, x1, y1 int) {
		for y := y0; y < y1; y++ {
			for x := x0; x < x1; x++ {
				off := (y*w + x) * 4
				cur[off] = 255
			}
		}
	}
	// Two far-apart changes plus one wide thin line.
	fill(10, 20, 60, 30)
	fill(300, 200, 360, 210)
	fill(0, 150, w, 152)

	rects := computeDirtyRects(prev, cur, w, h, 4)
	if len(rects) != 3 {
		t.Fatalf("expected 3 dirty rects, got %d: %+v", len(rects), rects)
	}
	// Every changed pixel must be covered by one of the rects.
	covers := func(x, y int) bool {
		for _, r := range rects {
			if x >= r.X && x < r.X+r.W && y >= r.Y && y < r.Y+r.H {
				return true
			}
		}
		return false
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			off := (y*w + x) * 4
			changed := cur[off] != prev[off]
			if changed && !covers(x, y) {
				t.Fatalf("changed pixel (%d,%d) not covered", x, y)
			}
		}
	}

	// Budget of 2 must merge the closest bands while still covering everything.
	merged := computeDirtyRects(prev, cur, w, h, 2)
	if len(merged) > 2 {
		t.Fatalf("maxRects=2 violated: %+v", merged)
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			off := (y*w + x) * 4
			if cur[off] == prev[off] {
				continue
			}
			ok := false
			for _, r := range merged {
				if x >= r.X && x < r.X+r.W && y >= r.Y && y < r.Y+r.H {
					ok = true
					break
				}
			}
			if !ok {
				t.Fatalf("merged rects miss (%d,%d)", x, y)
			}
		}
	}

	// Identical frames produce no work.
	if same := computeDirtyRects(prev, prev, w, h, 4); len(same) != 0 {
		t.Fatalf("expected no dirty rects, got %+v", same)
	}
}

func TestConPty(t *testing.T) {
	sess, err := startConPtySession("test-pty", "cmd.exe", "", 80, 24)
	if err != nil {
		t.Fatalf("startConPtySession failed: %v", err)
	}
	defer func() {
		ptyMu.Lock()
		ptyMap["test-pty"] = sess
		ptyMu.Unlock()
		closePty("test-pty")
	}()

	var out bytes.Buffer
	done := make(chan struct{})
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := sess.outReader.Read(buf)
			if n > 0 {
				out.Write(buf[:n])
			}
			if err != nil {
				break
			}
		}
		close(done)
	}()

	time.Sleep(500 * time.Millisecond)
	_, err = sess.inWriter.Write([]byte("echo CONPTY_OK_123\r\nexit\r\n"))
	if err != nil {
		t.Fatalf("inWriter.Write failed: %v", err)
	}

	go func() {
		procWaitForSingleObject.Call(uintptr(sess.procHandle), infiniteTimeout)
		sess.closeHpc()
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("ConPTY timed out; output so far: %q", out.String())
	}

	if !bytes.Contains(out.Bytes(), []byte("CONPTY_OK_123")) {
		t.Fatalf("expected CONPTY_OK_123 in output, got %q", out.String())
	}
}
