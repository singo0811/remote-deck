//go:build darwin

package main

import (
	"encoding/base64"
	"fmt"
	"image"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

var (
	vtOnce sync.Once
	vtOK   bool
)

func videoToolboxAvailable() bool {
	vtOnce.Do(func() {
		out, err := exec.Command("ffmpeg", "-hide_banner", "-encoders").Output()
		if err != nil {
			return
		}
		vtOK = strings.Contains(string(out), "h264_videotoolbox")
	})
	return vtOK
}

func queryPlatformDisplays() ([]displayInfo, error) {
	if out, err := exec.Command("system_profiler", "SPDisplaysDataType", "-json").Output(); err == nil {
		if displays := parseMacDisplaysJSON(out); len(displays) > 0 {
			return displays, nil
		}
	}
	return []displayInfo{{ID: 0, Name: "Primary", Left: 0, Top: 0, Width: 1920, Height: 1080, Primary: true}}, nil
}

func captureRawScreenPng(disp displayInfo, roi *image.Rectangle) ([]byte, error) {
	tmp := filepath.Join(os.TempDir(), fmt.Sprintf("rd-cap-%d.png", os.Getpid()))
	defer os.Remove(tmp)

	args := []string{"-x"}
	if roi != nil && !roi.Empty() {
		args = append(args, "-R", fmt.Sprintf("%d,%d,%d,%d", roi.Min.X, roi.Min.Y, roi.Dx(), roi.Dy()))
	} else if disp.ID > 0 {
		args = append(args, "-D", strconv.Itoa(disp.ID+1))
	}
	args = append(args, "-t", "png", tmp)
	cmd := exec.Command("screencapture", args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("screencapture failed: %v (%s)", err, strings.TrimSpace(string(out)))
	}
	return os.ReadFile(tmp)
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
		fps = 30
	}
	if !videoEncoderAvailable() {
		return fmt.Errorf("ffmpeg not found in PATH")
	}

	otherCursorMu.Lock()
	disp := otherVideoDisplay
	otherCursorMu.Unlock()

	// ScreenCaptureKit / AVFoundation capture + VideoToolbox hardware H.264.
	inputArgs := []string{
		"-f", "avfoundation",
		"-framerate", strconv.Itoa(fps),
		"-capture_cursor", "1",
		"-i", fmt.Sprintf("Capture screen %d:none", disp.ID),
		"-vf", fmt.Sprintf("scale=%d:%d,format=yuv420p", w, h),
	}

	var encCodec []string
	if videoToolboxAvailable() {
		encCodec = []string{
			"-c:v", "h264_videotoolbox",
			"-realtime", "true",
			"-allow_sw", "1",
			"-profile:v", "baseline",
			"-b:v", "6000k",
			"-maxrate", "8000k",
			"-g", strconv.Itoa(fps * 2),
		}
	} else {
		encCodec = []string{
			"-c:v", "libx264",
			"-preset", "ultrafast",
			"-tune", "zerolatency",
			"-profile:v", "baseline",
			"-crf", "23",
			"-pix_fmt", "yuv420p",
			"-g", strconv.Itoa(fps * 2),
			"-x264-params", "repeat-headers=1:scenecut=0:bframes=0:rc-lookahead=0:slice-max-size=65000",
		}
	}

	args := []string{"-hide_banner", "-loglevel", "error"}
	args = append(args, inputArgs...)
	args = append(args, encCodec...)
	args = append(args, "-flush_packets", "1", "-f", "h264", "pipe:1")
	return startFfmpegVideoCmd(args, false, w, h, fps, encoderTargetKbps(w, h, fps, quality))
}

func injectMousePlatform(req mouseReq, disp displayInfo, px, py int) error {
	if req.Action == "wheel" {
		notches := req.DeltaY / 40
		if notches == 0 {
			if req.DeltaY > 0 {
				notches = 3
			} else if req.DeltaY < 0 {
				notches = -3
			}
		}
		if _, err := exec.LookPath("python3"); err == nil && notches != 0 {
			script := fmt.Sprintf(
				"import Quartz; e=Quartz.CGEventCreateScrollWheelEvent(None,0,1,%d); Quartz.CGEventPost(Quartz.kCGHIDEventTap,e)",
				notches,
			)
			return exec.Command("python3", "-c", script).Run()
		}
		return nil
	}

	coord := fmt.Sprintf("%d,%d", px, py)
	if _, err := exec.LookPath("cliclick"); err == nil {
		switch req.Action {
		case "move", "move_rel":
			return exec.Command("cliclick", "m:"+coord).Run()
		case "down":
			return exec.Command("cliclick", "dd:"+coord).Run()
		case "up":
			return exec.Command("cliclick", "du:"+coord).Run()
		case "click":
			if req.Button == "right" {
				return exec.Command("cliclick", "rc:"+coord).Run()
			}
			return exec.Command("cliclick", "c:"+coord).Run()
		case "dblclick":
			return exec.Command("cliclick", "dc:"+coord).Run()
		}
	}

	if _, err := exec.LookPath("python3"); err == nil {
		btn := "Quartz.kCGMouseButtonLeft"
		downEvt := "Quartz.kCGEventLeftMouseDown"
		upEvt := "Quartz.kCGEventLeftMouseUp"
		if req.Button == "right" {
			btn = "Quartz.kCGMouseButtonRight"
			downEvt = "Quartz.kCGEventRightMouseDown"
			upEvt = "Quartz.kCGEventRightMouseUp"
		}
		var script string
		switch req.Action {
		case "move", "move_rel":
			script = fmt.Sprintf("import Quartz; e=Quartz.CGEventCreateMouseEvent(None,Quartz.kCGEventMouseMoved,(%d,%d),0); Quartz.CGEventPost(Quartz.kCGHIDEventTap,e)", px, py)
		case "down":
			script = fmt.Sprintf("import Quartz; e=Quartz.CGEventCreateMouseEvent(None,%s,(%d,%d),%s); Quartz.CGEventPost(Quartz.kCGHIDEventTap,e)", downEvt, px, py, btn)
		case "up":
			script = fmt.Sprintf("import Quartz; e=Quartz.CGEventCreateMouseEvent(None,%s,(%d,%d),%s); Quartz.CGEventPost(Quartz.kCGHIDEventTap,e)", upEvt, px, py, btn)
		case "click":
			script = fmt.Sprintf("import Quartz; d=Quartz.CGEventCreateMouseEvent(None,%s,(%d,%d),%s); u=Quartz.CGEventCreateMouseEvent(None,%s,(%d,%d),%s); Quartz.CGEventPost(Quartz.kCGHIDEventTap,d); Quartz.CGEventPost(Quartz.kCGHIDEventTap,u)", downEvt, px, py, btn, upEvt, px, py, btn)
		case "dblclick":
			script = fmt.Sprintf("import Quartz; d=Quartz.CGEventCreateMouseEvent(None,%s,(%d,%d),%s); Quartz.CGEventSetIntegerValueField(d,Quartz.kCGMouseEventClickState,2); u=Quartz.CGEventCreateMouseEvent(None,%s,(%d,%d),%s); Quartz.CGEventSetIntegerValueField(u,Quartz.kCGMouseEventClickState,2); Quartz.CGEventPost(Quartz.kCGHIDEventTap,d); Quartz.CGEventPost(Quartz.kCGHIDEventTap,u)", downEvt, px, py, btn, upEvt, px, py, btn)
		}
		if script != "" {
			return exec.Command("python3", "-c", script).Run()
		}
	}
	return nil
}

func injectKeyPlatform(req keyReq) error {
	if req.Action == "up" {
		return nil
	}
	code, ok := vkToMacKeyCode(req.VK)
	if !ok {
		return nil
	}
	var mods []string
	if req.Mods.Ctrl {
		mods = append(mods, "control down")
	}
	if req.Mods.Alt {
		mods = append(mods, "option down")
	}
	if req.Mods.Shift {
		mods = append(mods, "shift down")
	}
	if req.Mods.Meta {
		mods = append(mods, "command down")
	}
	using := ""
	if len(mods) > 0 {
		using = " using {" + strings.Join(mods, ", ") + "}"
	}
	script := fmt.Sprintf(`tell application "System Events" to key code %d%s`, code, using)
	return exec.Command("osascript", "-e", script).Run()
}

func injectTextPlatform(text string) error {
	escaped := strings.ReplaceAll(text, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)
	return exec.Command("osascript", "-e", fmt.Sprintf(`tell application "System Events" to keystroke "%s"`, escaped)).Run()
}

func getClipboardText() (string, error) {
	out, err := exec.Command("pbpaste").Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func setClipboardText(text string) error {
	cmd := exec.Command("pbcopy")
	cmd.Stdin = strings.NewReader(text)
	return cmd.Run()
}

func audioCaptureInputArgs() []string {
	return []string{"-f", "avfoundation", "-i", ":0"}
}

func getClipboardImageBase64() string {
	tmp := filepath.Join(os.TempDir(), fmt.Sprintf("rd-clip-read-%d.png", os.Getpid()))
	defer os.Remove(tmp)
	script := fmt.Sprintf(`
try
  set pngData to the clipboard as «class PNGf»
  set f to open for access (POSIX file "%s") with write permission
  set eof f to 0
  write pngData to f
  close access f
on error
  try
    close access (POSIX file "%s")
  end try
end try`, tmp, tmp)
	if err := exec.Command("osascript", "-e", script).Run(); err != nil {
		return ""
	}
	raw, err := os.ReadFile(tmp)
	if err != nil || len(raw) < 16 {
		return ""
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func setClipboardImageBase64(b64 string) error {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return err
	}
	tmp := filepath.Join(os.TempDir(), fmt.Sprintf("rd-clip-write-%d.png", os.Getpid()))
	defer os.Remove(tmp)
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	script := fmt.Sprintf(`set the clipboard to (read (POSIX file "%s") as «class PNGf»)`, tmp)
	return exec.Command("osascript", "-e", script).Run()
}

func setPrivacyScreenPlatform(enabled bool) error {
	if _, err := exec.LookPath("python3"); err != nil {
		return fmt.Errorf("privacy blackout on macOS requires python3 Quartz")
	}
	if enabled {
		script := "import Quartz; Quartz.CGSetDisplayTransferByFormula(Quartz.CGMainDisplayID(), 0, 0, 1, 0, 0, 1, 0, 0, 1)"
		return exec.Command("python3", "-c", script).Run()
	}
	script := "import Quartz; Quartz.CGDisplayRestoreColorSyncSettings()"
	return exec.Command("python3", "-c", script).Run()
}
