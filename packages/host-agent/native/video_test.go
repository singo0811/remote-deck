//go:build windows

package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestAccessUnitsKeepDecoderConfigOnEveryIDR(t *testing.T) {
	sps := []byte{0, 0, 0, 1, 0x67, 0xaa}
	pps := []byte{0, 0, 1, 0x68, 0xbb}
	idr := []byte{0, 0, 0, 1, 0x45, 0x80}
	delta := []byte{0, 0, 1, 0x41, 0x80}
	stream := bytes.Join([][]byte{sps, pps, idr, delta, idr}, nil)
	var keys, count int
	pumpVideoPackets(bytes.NewReader(stream), func(meta, payload []byte) {
		count++
		if bytes.Contains(meta, []byte(`"key":true`)) {
			keys++
			if !bytes.Equal(payload, bytes.Join([][]byte{sps, pps, idr}, nil)) {
				t.Errorf("IDR missing decoder configuration: %x", payload)
			}
		}
	}, 640, 480)
	if keys != 2 || count != 3 {
		t.Fatalf("got %d keyframes in %d access units", keys, count)
	}
}

// Produces real H.264 access units and verifies them by decoding with ffmpeg.
func TestVideoEncoderProducesDecodableStream(t *testing.T) {
	if !videoEncoderAvailable() {
		t.Skip("ffmpeg not available")
	}

	type packet struct {
		meta    map[string]any
		payload []byte
	}
	var mu sync.Mutex
	var packets []packet
	videoEmit = func(metaBytes, payload []byte) {
		var m map[string]any
		_ = json.Unmarshal(metaBytes, &m)
		mu.Lock()
		packets = append(packets, packet{meta: m, payload: append([]byte(nil), payload...)})
		mu.Unlock()
	}

	const w, h, fps, frames = 160, 120, 15, 10
	if err := startVideoEncoder(w, h, fps, 80); err != nil {
		t.Fatalf("startVideoEncoder: %v", err)
	}
	defer stopVideoEncoder()

	frame := make([]byte, w*h*4)
	for i := 0; i < frames; i++ {
		// Moving gradient so x264 has something to predict.
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				off := (y*w + x) * 4
				frame[off+0] = byte((x + i*7) & 0xff)
				frame[off+1] = byte((y + i*3) & 0xff)
				frame[off+2] = byte(64 + i*4)
				frame[off+3] = 255
			}
		}
		if err := feedVideoFrame(frame, w, h); err != nil {
			t.Fatalf("feedVideoFrame: %v", err)
		}
		time.Sleep(time.Second / fps)
	}

	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(packets)
		mu.Unlock()
		if n >= frames/2 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}

	mu.Lock()
	got := append([]packet(nil), packets...)
	mu.Unlock()
	if len(got) < 3 {
		t.Fatalf("expected several access units, got %d", len(got))
	}
	if key, _ := got[0].meta["key"].(bool); !key {
		t.Fatalf("first access unit should be a keyframe, meta=%v", got[0].meta)
	}

	var stream []byte
	for _, p := range got {
		stream = append(stream, p.payload...)
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "stream.h264")
	if err := os.WriteFile(src, stream, 0o644); err != nil {
		t.Fatal(err)
	}

	// Decode back and count frames: proves the bitstream is valid H.264.
	out, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "h264",
		"-i", src, "-f", "rawvideo", "-pix_fmt", "yuv420p", "pipe:1").Output()
	if err != nil {
		t.Fatalf("ffmpeg decode failed: %v", err)
	}
	decoded := len(out) / (w * h * 3 / 2)
	if decoded < 3 {
		t.Fatalf("decoded only %d frames from %d bytes", decoded, len(out))
	}
	t.Logf("packets=%d bytes=%d decodedFrames=%d", len(got), len(stream), decoded)
}

// Regression guard: x264 with sliced-threads emits several slices per picture.
// We must group them back into one access unit per frame, otherwise the client
// receives ~10 "frames" for every real frame and decodes garbage.
func TestEncoderEmitsOneAccessUnitPerFrame(t *testing.T) {
	if !videoEncoderAvailable() {
		t.Skip("ffmpeg not available")
	}
	const w, h, frames = 640, 360, 8

	var mu sync.Mutex
	packets := 0
	old := videoEmit
	videoEmit = func(metaBytes, _ []byte) {
		mu.Lock()
		packets++
		mu.Unlock()
	}
	defer func() { videoEmit = old }()

	if err := startVideoEncoder(w, h, 10, 80); err != nil {
		t.Fatalf("startVideoEncoder: %v", err)
	}
	defer stopVideoEncoder()

	frame := make([]byte, w*h*4)
	for i := 0; i < frames; i++ {
		for y := 0; y < h; y += 9 {
			for x := 0; x < w; x += 9 {
				off := (y*w + x) * 4
				frame[off+0] = byte((x + i*11) & 0xff)
				frame[off+1] = byte((y + i*5) & 0xff)
				frame[off+2] = byte(60 + i*9)
				frame[off+3] = 255
			}
		}
		if err := feedVideoFrame(frame, w, h); err != nil {
			t.Fatalf("feed: %v", err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	time.Sleep(1200 * time.Millisecond)

	mu.Lock()
	got := packets
	mu.Unlock()
	if got < frames-2 || got > frames+2 {
		t.Fatalf("expected ~%d access units (one per frame), got %d", frames, got)
	}
	t.Logf("frames=%d access-units=%d", frames, got)
}

// Access unit splitter must not merge two frames into one packet.
func TestAnnexBSplitterGroupsAccessUnits(t *testing.T) {
	// Two tiny "frames": SPS + IDR + P slice, then another P slice.
	au := func(nalType byte) []byte {
		return []byte{0x00, 0x00, 0x00, 0x01, nalType, 0xAA, 0xBB}
	}
	stream := append(append(append(au(0x67), au(0x65)...), au(0x41)...), au(0x41)...)
	var count int
	pr, pw, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		_, _ = pw.Write(stream)
		_ = pw.Close()
	}()
	pumpVideoPackets(pr, func(_, _ []byte) { count++ }, 640, 480)
	_ = pr.Close()
	if count != 3 {
		t.Fatalf("expected 3 access units (IDR + 2 P slices), got %d", count)
	}
}

var _ = binary.BigEndian

// The encoder budget used to be one hardcoded value for every preset, which made
// 超清 look soft and 流畅 still saturate a WAN link.
func TestEncoderTargetKbpsScalesWithQualityAndPixels(t *testing.T) {
	low := encoderTargetKbps(1720, 720, 24, 62)
	mid := encoderTargetKbps(3026, 1266, 30, 84)
	high := encoderTargetKbps(3440, 1440, 24, 92)
	if !(low < mid && mid < high) {
		t.Fatalf("bitrate must grow with preset: low=%d mid=%d high=%d", low, mid, high)
	}
	if low < 800 || low > 8000 {
		t.Fatalf("low preset bitrate out of range: %d kbps", low)
	}
	if high < 8000 || high > 40000 {
		t.Fatalf("high preset bitrate out of range: %d kbps", high)
	}
	// Same preset on a smaller display must not ask for the same bits.
	if encoderTargetKbps(1720, 720, 24, 92) >= encoderTargetKbps(3440, 1440, 24, 92) {
		t.Fatal("bitrate must scale with pixel count")
	}
}

func TestEncoderCrfMovesWithQuality(t *testing.T) {
	if !(encoderCrf(92) < encoderCrf(74) && encoderCrf(74) < encoderCrf(50)) {
		t.Fatalf("crf must shrink as quality grows: %d %d %d", encoderCrf(92), encoderCrf(74), encoderCrf(50))
	}
	if encoderCrf(30) != 32 || encoderCrf(95) != 16 {
		t.Fatalf("crf endpoints wrong: %d %d", encoderCrf(30), encoderCrf(95))
	}
}
