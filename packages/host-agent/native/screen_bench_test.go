//go:build windows

package main

import (
	"bytes"
	"image"
	"image/jpeg"
	"runtime"
	"sync"
	"testing"
	"time"
)

// The strip encoder must actually beat a single-threaded full-frame encode,
// otherwise splitting full frames costs bandwidth for nothing.
func TestStripEncodingIsFaster(t *testing.T) {
	const w, h = 3440, 1440
	rgba := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(rgba.Pix); i += 4 {
		rgba.Pix[i] = byte(i / 7)
		rgba.Pix[i+1] = byte(i / 13)
		rgba.Pix[i+2] = byte(i / 29)
		rgba.Pix[i+3] = 255
	}

	encodeFull := func() int {
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, rgba, &jpeg.Options{Quality: 94}); err != nil {
			t.Fatalf("encode: %v", err)
		}
		return buf.Len()
	}

	stripCount := runtime.NumCPU()
	if stripCount > 6 {
		stripCount = 6
	}
	encodeStrips := func() int {
		stripH := (h + stripCount - 1) / stripCount
		var mu sync.Mutex
		var wg sync.WaitGroup
		total := 0
		for i := 0; i < stripCount; i++ {
			y0 := i * stripH
			y1 := y0 + stripH
			if y1 > h {
				y1 = h
			}
			if y0 >= y1 {
				break
			}
			wg.Add(1)
			go func(top, bottom int) {
				defer wg.Done()
				sub := image.NewRGBA(image.Rect(0, 0, w, bottom-top))
				for y := top; y < bottom; y++ {
					copy(sub.Pix[(y-top)*w*4:(y-top+1)*w*4], rgba.Pix[y*w*4:(y+1)*w*4])
				}
				var buf bytes.Buffer
				if err := jpeg.Encode(&buf, sub, &jpeg.Options{Quality: 94}); err != nil {
					return
				}
				mu.Lock()
				total += buf.Len()
				mu.Unlock()
			}(y0, y1)
		}
		wg.Wait()
		return total
	}

	encodeFull() // warm up
	start := time.Now()
	fullBytes := encodeFull()
	fullMs := float64(time.Since(start).Microseconds()) / 1000

	encodeStrips()
	start = time.Now()
	stripBytes := encodeStrips()
	stripMs := float64(time.Since(start).Microseconds()) / 1000

	t.Logf("cpus=%d full=%.1fms (%dKB) strips=%.1fms (%dKB) speedup=%.2fx",
		runtime.NumCPU(), fullMs, fullBytes/1024, stripMs, stripBytes/1024, fullMs/stripMs)
	if stripMs >= fullMs {
		t.Fatalf("strip encoding not faster: %.1fms vs %.1fms", stripMs, fullMs)
	}
}
