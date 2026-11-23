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
)

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

func startVideoEncoder(w, h, fps int) error {
	videoMu.Lock()
	defer videoMu.Unlock()
	if videoRunning.Load() {
		if videoW == w && videoH == h && videoFPS == fps {
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

	var encoderArgs []string
	if useFastNvencEncoder("ffmpeg") {
		encoderArgs = []string{
			"-c:v", "h264_nvenc",
			"-preset", "p1",
			"-tune", "ull",
			"-zerolatency", "1",
			"-profile:v", "baseline",
			"-rc", "cbr",
			"-b:v", "6000k",
			"-maxrate", "8000k",
			"-bufsize", "1600k",
			"-pix_fmt", "yuv420p",
			"-g", fmt.Sprintf("%d", fps*2),
		}
	} else {
		encoderArgs = []string{
			"-c:v", "libx264",
			"-preset", "ultrafast",
			"-tune", "zerolatency",
			"-profile:v", "baseline",
			"-crf", "23",
			"-maxrate", "8000k",
			"-bufsize", "1600k",
			"-pix_fmt", "yuv420p",
			"-g", fmt.Sprintf("%d", fps*2),
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
	return startFfmpegVideoCmd(args, true, w, h, fps)
}
