//go:build windows

package main

import (
	"fmt"
	"os/exec"
	"sync"
	"time"
)

var (
	nvencOnce   sync.Once
	nvencFastOK bool
	qsvOnce     sync.Once
	qsvOK       bool
)

// Intel Quick Sync: hardware H.264 without touching the CPU. MiniRTC-style
// designs always prefer a hardware encoder; software x264 at 3440x1440 is what
// makes "外网/超清" feel heavy.
func useQsvEncoder(ffmpeg string) bool {
	qsvOnce.Do(func() {
		cmd := exec.Command(ffmpeg,
			"-hide_banner", "-loglevel", "error",
			"-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=0.2",
			"-c:v", "h264_qsv", "-f", "h264", "pipe:1",
		)
		out, err := cmd.Output()
		qsvOK = err == nil && len(out) > 0
	})
	return qsvOK
}

func useFastNvencEncoder(ffmpeg string) bool {
	nvencOnce.Do(func() {
		const w, h = 256, 256
		cmd := exec.Command(ffmpeg,
			"-hide_banner", "-loglevel", "error",
			"-f", "rawvideo", "-pix_fmt", "bgra",
			"-s", "256x256", "-r", "30", "-i", "pipe:0",
			"-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ull", "-zerolatency", "1",
			"-profile:v", "baseline", "-rc", "cbr", "-b:v", "2000k",
			"-pix_fmt", "yuv420p", "-f", "h264", "pipe:1",
		)
		in, err := cmd.StdinPipe()
		if err != nil {
			return
		}
		out, err := cmd.StdoutPipe()
		if err != nil {
			return
		}
		if err := cmd.Start(); err != nil {
			return
		}
		frame := make([]byte, w*h*4)
		gotCh := make(chan bool, 1)
		go func() {
			buf := make([]byte, 4096)
			n, _ := out.Read(buf)
			gotCh <- n > 0
		}()
		_, _ = in.Write(frame)
		select {
		case ok := <-gotCh:
			nvencFastOK = ok
		case <-time.After(250 * time.Millisecond):
			nvencFastOK = false
		}
		_ = in.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	})
	return nvencFastOK
}

func startVideoEncoder(w, h, fps, quality int) error {
	videoMu.Lock()
	defer videoMu.Unlock()
	if videoRunning.Load() {
		if videoW == w && videoH == h && videoFPS == fps && videoKbps == encoderTargetKbps(w, h, fps, quality) {
			return nil
		}
		stopVideoEncoderLocked()
	}
	if w <= 0 || h <= 0 {
		return fmt.Errorf("invalid video size %dx%d", w, h)
	}
	if fps < 5 || fps > 60 {
		fps = 20
	}
	if !videoEncoderAvailable() {
		return fmt.Errorf("ffmpeg not found in PATH")
	}

	kbps := encoderTargetKbps(w, h, fps, quality)
	crf := encoderCrf(quality)
	// A VBV buffer of 1.6 Mbit (the old value) is smaller than one keyframe at
	// this resolution, so the rate controller kept clamping quality down.
	maxKbps := kbps + kbps/2
	bufKbps := maxKbps * 2

	var encoderArgs []string
	if useQsvEncoder("ffmpeg") {
		videoEncoderName = "h264_qsv"
		encoderArgs = []string{
			"-c:v", "h264_qsv",
			"-preset", "veryfast",
			"-global_quality", fmt.Sprintf("%d", crf),
			"-look_ahead", "0",
			"-async_depth", "1",
			"-bf", "0",
			"-idr_interval", "0",
			"-b:v", fmt.Sprintf("%dk", kbps),
			"-maxrate", fmt.Sprintf("%dk", maxKbps),
			"-bufsize", fmt.Sprintf("%dk", bufKbps),
			"-pix_fmt", "nv12",
			// One-second GOP: recovery never needs the encoder to be torn down and
			// rebuilt just to get an IDR, which is what MiniRTC-style designs avoid.
			"-g", fmt.Sprintf("%d", fps),
		}
	} else if useFastNvencEncoder("ffmpeg") {
		videoEncoderName = "h264_nvenc"
		encoderArgs = []string{
			"-c:v", "h264_nvenc",
			// p1 is NVENC's fastest/lowest-quality preset; p3 keeps up with a
			// 24-30 fps desktop while compressing noticeably better.
			"-preset", "p3",
			"-tune", "ull",
			"-zerolatency", "1",
			"-profile:v", "main",
			"-rc", "vbr",
			"-cq", fmt.Sprintf("%d", crf),
			"-b:v", fmt.Sprintf("%dk", kbps),
			"-maxrate", fmt.Sprintf("%dk", maxKbps),
			"-bufsize", fmt.Sprintf("%dk", bufKbps),
			"-pix_fmt", "yuv420p",
			"-g", fmt.Sprintf("%d", fps),
		}
	} else {
		videoEncoderName = "libx264"
		encoderArgs = []string{
			"-c:v", "libx264",
			// ultrafast drops CABAC and most motion search; veryfast keeps both
			// and is the difference between a soft and a crisp desktop.
			"-preset", "veryfast",
			"-tune", "zerolatency",
			"-profile:v", "main",
			"-crf", fmt.Sprintf("%d", crf),
			"-maxrate", fmt.Sprintf("%dk", maxKbps),
			"-bufsize", fmt.Sprintf("%dk", bufKbps),
			"-pix_fmt", "yuv420p",
			"-g", fmt.Sprintf("%d", fps),
			// Keep x264's sliced-threads (from -tune zerolatency): it is what keeps
			// latency low. The AU splitter groups slices by first_mb_in_slice instead
			// of assuming one slice per picture.
			"-x264-params", "repeat-headers=1:scenecut=0:bframes=0:rc-lookahead=0:slice-max-size=65000",
		}
	}
	args := []string{
		"-hide_banner", "-loglevel", "error",
		"-f", "rawvideo", "-pix_fmt", "bgra",
		"-s", fmt.Sprintf("%dx%d", w, h),
		"-r", fmt.Sprintf("%d", fps),
		"-i", "pipe:0",
	}
	args = append(args, encoderArgs...)
	args = append(args, "-flush_packets", "1", "-f", "h264", "pipe:1")
	return startFfmpegVideoCmd(args, true, w, h, fps, kbps)
}
