package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

// Shared H.264 Annex-B pipeline used by both the Windows pipe-fed ffmpeg
// encoder and native screen-grab encoders on macOS/Linux.
type videoRoiMeta struct {
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	W          float64 `json:"w"`
	H          float64 `json:"h"`
	FullWidth  int     `json:"fullWidth"`
	FullHeight int     `json:"fullHeight"`
}

var (
	videoMu      sync.Mutex
	videoCmd     *exec.Cmd
	videoIn      io.WriteCloser
	videoRoiCur  *videoRoiMeta
	videoRunning atomic.Bool
	videoW       int
	videoH       int
	videoFPS     int
	videoKbps    int
	videoStarts  atomic.Uint64
	videoSeq     uint64
	videoStderr  boundedBuffer
)

func setVideoRoiMeta(roi *videoRoiMeta) {
	videoMu.Lock()
	if roi == nil {
		videoRoiCur = nil
	} else {
		cp := *roi
		videoRoiCur = &cp
	}
	videoMu.Unlock()
}

// boundedBuffer keeps the tail of ffmpeg's stderr for diagnostics.
type boundedBuffer struct {
	mu   sync.Mutex
	data []byte
	max  int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.max == 0 {
		b.max = 4096
	}
	b.data = append(b.data, p...)
	if len(b.data) > b.max {
		b.data = b.data[len(b.data)-b.max:]
	}
	return len(p), nil
}

func (b *boundedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.data)
}

func (b *boundedBuffer) Reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = nil
}

func videoEncoderAvailable() bool {
	_, err := exec.LookPath("ffmpeg")
	return err == nil
}

func startFfmpegVideoCmd(args []string, withStdin bool, w, h, fps int) error {
	cmd := exec.Command("ffmpeg", args...)
	videoStderr.Reset()
	cmd.Stderr = &videoStderr
	var stdin io.WriteCloser
	if withStdin {
		var err error
		stdin, err = cmd.StdinPipe()
		if err != nil {
			return err
		}
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		if stdin != nil {
			_ = stdin.Close()
		}
		return err
	}
	if err := cmd.Start(); err != nil {
		if stdin != nil {
			_ = stdin.Close()
		}
		return err
	}

	videoCmd = cmd
	videoIn = stdin
	videoW = w
	videoH = h
	videoFPS = fps
	videoRunning.Store(true)

	go pumpVideoPackets(stdout, videoEmit)
	go func() {
		err := cmd.Wait()
		videoRunning.Store(false)
		tail := videoStderr.String()
		if err != nil && tail != "" {
			writeJSONFrame(evtJSON, map[string]any{"op": "video_error", "error": tail})
		} else {
			writeJSONFrame(evtJSON, map[string]any{"op": "video_exit"})
		}
	}()
	return nil
}

// encoderTargetKbps derives a bitrate from the requested quality and pixel rate.
// One hardcoded bitrate for every preset was why "超清" looked soft on a large
// display and why "流畅" still saturated a WAN link: the resolution changed but
// the encoder's budget never did.
func encoderTargetKbps(w, h, fps, quality int) int {
	if w <= 0 || h <= 0 || fps <= 0 {
		return 4000
	}
	if quality < 30 {
		quality = 30
	}
	if quality > 95 {
		quality = 95
	}
	// bits per pixel per frame: ~0.055 (thin) .. ~0.20 (generous)
	bpp := 0.055 + float64(quality-30)/65.0*0.145
	kbps := float64(w) * float64(h) * float64(fps) * bpp / 1000.0
	if kbps < 1500 {
		kbps = 1500
	}
	if kbps > 40000 {
		kbps = 40000
	}
	return int(kbps)
}

// encoderCrf maps the UI quality (30..95) onto an x264/NVENC quality level
// (32..16): higher UI quality -> lower CRF/CQ -> sharper picture.
func encoderCrf(quality int) int {
	if quality < 30 {
		quality = 30
	}
	if quality > 95 {
		quality = 95
	}
	return 32 - int(float64(quality-30)/65.0*16.0)
}

func startVideoEncoderIfNeeded(w, h, fps, quality int) error {
	videoMu.Lock()
	target := encoderTargetKbps(w, h, fps, quality)
	need := !videoRunning.Load() || videoW != w || videoH != h || videoKbps != target
	if need {
		videoKbps = target
	}
	prevW, prevH, prevKbps := videoW, videoH, videoKbps
	videoMu.Unlock()
	if !need {
		return nil
	}
	// Emit why the encoder restarted: a restart costs a keyframe, so a per-frame
	// restart looks like a keyframe storm on the wire.
	writeJSONFrame(evtJSON, map[string]any{
		"op":    "video_start",
		"w":     w,
		"h":     h,
		"fps":   fps,
		"kbps":  target,
		"crf":   encoderCrf(quality),
		"prevW": prevW,
		"prevH": prevH,
		"prevK": prevKbps,
		"seq":   videoStarts.Add(1),
	})
	return startVideoEncoder(w, h, fps, quality)
}

func stopVideoEncoderLocked() {
	videoRunning.Store(false)
	if videoIn != nil {
		// Close stdin first so ffmpeg flushes frames still in its pipeline;
		// only kill it when it does not exit promptly.
		_ = videoIn.Close()
		videoIn = nil
	}
	if videoCmd != nil {
		done := make(chan struct{})
		go func(cmd *exec.Cmd) {
			_ = cmd.Wait()
			close(done)
		}(videoCmd)
		select {
		case <-done:
		case <-time.After(600 * time.Millisecond):
			if videoCmd.Process != nil {
				_ = videoCmd.Process.Kill()
			}
			<-done
		}
		videoCmd = nil
	}
}

func stopVideoEncoder() {
	videoMu.Lock()
	defer videoMu.Unlock()
	stopVideoEncoderLocked()
}

// feedVideoFrame writes one full BGRA frame into the encoder.
func feedVideoFrame(raw []byte, w, h int) error {
	videoMu.Lock()
	defer videoMu.Unlock()
	if !videoRunning.Load() || videoIn == nil {
		return fmt.Errorf("video encoder not running")
	}
	if w != videoW || h != videoH {
		return fmt.Errorf("frame size %dx%d differs from encoder %dx%d", w, h, videoW, videoH)
	}
	_, err := videoIn.Write(raw)
	return err
}

// videoEmit lets tests capture packets instead of writing to stdout.
var videoEmit = func(metaBytes, payload []byte) {
	out := make([]byte, 4+len(metaBytes)+len(payload))
	out[0] = byte(len(metaBytes) >> 24)
	out[1] = byte(len(metaBytes) >> 16)
	out[2] = byte(len(metaBytes) >> 8)
	out[3] = byte(len(metaBytes))
	copy(out[4:], metaBytes)
	copy(out[4+len(metaBytes):], payload)
	_ = writeFrame(evtVideoPacket, out)
}

// pumpVideoPackets groups the Annex-B byte stream into access units and emits
// one binary frame per AU so the client can build EncodedVideoChunks.
func pumpVideoPackets(r io.Reader, emit func(metaBytes, payload []byte)) {
	buf := make([]byte, 256*1024)
	acc := make([]byte, 0, 512*1024)
	var au bytes.Buffer
	auHasVCL := false
	flush := func() {
		if au.Len() == 0 {
			return
		}
		videoSeq += 1
		hasKey := false
		if bytes.Contains(au.Bytes(), []byte{0x00, 0x00, 0x01, 0x65}) ||
			bytes.Contains(au.Bytes(), []byte{0x00, 0x00, 0x00, 0x01, 0x65}) {
			hasKey = true
		}
		metaMap := map[string]any{
			"codec":  "h264",
			"key":    hasKey,
			"seq":    videoSeq,
			"ts":     time.Now().UnixMilli(),
			"width":  videoW,
			"height": videoH,
		}
		videoMu.Lock()
		roiSnap := videoRoiCur
		videoMu.Unlock()
		if roiSnap != nil {
			metaMap["fullWidth"] = roiSnap.FullWidth
			metaMap["fullHeight"] = roiSnap.FullHeight
			metaMap["roi"] = map[string]float64{
				"x": roiSnap.X,
				"y": roiSnap.Y,
				"w": roiSnap.W,
				"h": roiSnap.H,
			}
		}
		meta, _ := json.Marshal(metaMap)
		payload := au.Bytes()
		emit(meta, payload)
		au.Reset()
		auHasVCL = false
	}

	for {
		n, err := r.Read(buf)
		if n > 0 {
			acc = append(acc, buf[:n]...)
			// Split accumulated bytes into NAL units (start code delimited).
			for {
				start := findStartCode(acc, 0)
				if start < 0 {
					break
				}
				next := findStartCode(acc, start+3)
				if next < 0 {
					// Keep the partial NAL for the next read.
					acc = acc[start:]
					break
				}
				nal := acc[start:next]
				acc = acc[next:]
				nalType := int(nal[startCodeLen(nal)] & 0x1f)
				isVCL := nalType >= 1 && nalType <= 5
				// x264 with sliced-threads emits several slices per picture; only a
				// slice whose first_mb_in_slice is 0 starts a new access unit.
				startsNewPicture := isVCL
				if isVCL {
					if mb, ok := firstMbInSlice(nal); ok && mb > 0 {
						startsNewPicture = false
					}
				}
				if startsNewPicture && auHasVCL {
					flush()
				}
				au.Write(nal)
				if isVCL {
					auHasVCL = true
				}
			}
		}
		if err != nil {
			// Flush the trailing NAL (held back while waiting for its end) too,
			// keeping the same access-unit boundaries as the streaming path.
			if len(acc) > 0 {
				nalType := int(acc[startCodeLen(acc)] & 0x1f)
				if nalType >= 1 && nalType <= 5 && auHasVCL {
					newPicture := true
					if mb, ok := firstMbInSlice(acc); ok && mb > 0 {
						newPicture = false
					}
					if newPicture {
						flush()
					}
				}
				au.Write(acc)
				acc = nil
			}
			flush()
			return
		}
	}
}

func findStartCode(b []byte, from int) int {
	for i := from; i+3 <= len(b); i++ {
		if b[i] == 0x00 && b[i+1] == 0x00 && b[i+2] == 0x01 {
			return i
		}
	}
	return -1
}

func startCodeLen(nal []byte) int {
	if len(nal) >= 4 && nal[0] == 0 && nal[1] == 0 && nal[2] == 0 && nal[3] == 1 {
		return 4
	}
	return 3
}

// firstMbInSlice parses the leading ue(v) of a slice header (RFC 6184 / H.264).
func firstMbInSlice(nal []byte) (int, bool) {
	off := startCodeLen(nal) + 1 // skip start code + NAL header
	if off >= len(nal) {
		return 0, false
	}
	zeros := 0
	base := off * 8
	for {
		bitPos := base + zeros
		if bitPos/8 >= len(nal) {
			return 0, false
		}
		bit := (nal[bitPos/8] >> (7 - uint(bitPos%8))) & 1
		if bit == 1 {
			break
		}
		zeros++
		if zeros > 31 {
			return 0, false
		}
	}
	val := 0
	pos := base + zeros + 1
	for i := 0; i < zeros; i++ {
		if pos/8 >= len(nal) {
			return 0, false
		}
		bit := (nal[pos/8] >> (7 - uint(pos%8))) & 1
		val = (val << 1) | int(bit)
		pos++
	}
	return (1 << uint(zeros)) - 1 + val, true
}
