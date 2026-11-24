//go:build linux

package main

import (
	"encoding/base64"
	"encoding/json"
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
	vaapiOnce sync.Once
	vaapiDev  string
)

func vaapiRenderDevice() string {
	vaapiOnce.Do(func() {
		if _, err := os.Stat("/dev/dri/renderD128"); err != nil {
			return
		}
		out, err := exec.Command("ffmpeg", "-hide_banner", "-encoders").Output()
		if err != nil {
			return
		}
		if strings.Contains(string(out), "h264_vaapi") {
			vaapiDev = "/dev/dri/renderD128"
		}
	})
	return vaapiDev
}

func isWaylandSession() bool {
	return os.Getenv("WAYLAND_DISPLAY") != ""
}

func queryPlatformDisplays() ([]displayInfo, error) {
	if isWaylandSession() {
		if _, err := exec.LookPath("wlr-randr"); err == nil {
			if out, err := exec.Command("wlr-randr", "--json").Output(); err == nil {
				var items []struct {
					Name     string `json:"name"`
					Enabled  bool   `json:"enabled"`
					Position struct {
						X int `json:"x"`
						Y int `json:"y"`
					} `json:"position"`
					Modes []struct {
						Width   int  `json:"width"`
						Height  int  `json:"height"`
						Current bool `json:"current"`
					} `json:"modes"`
				}
				if json.Unmarshal(out, &items) == nil && len(items) > 0 {
					var displays []displayInfo
					for _, it := range items {
						if !it.Enabled {
							continue
						}
						w, h := 0, 0
						for _, m := range it.Modes {
							if m.Current {
								w, h = m.Width, m.Height
								break
							}
						}
						if w > 0 && h > 0 {
							displays = append(displays, displayInfo{
								ID:      len(displays),
								Name:    it.Name,
								Left:    it.Position.X,
								Top:     it.Position.Y,
								Width:   w,
								Height:  h,
								Primary: len(displays) == 0,
							})
						}
					}
					if len(displays) > 0 {
						return displays, nil
					}
				}
			}
		}
	}

	if out, err := exec.Command("xrandr", "--current").Output(); err == nil {
		var displays []displayInfo
		for _, line := range strings.Split(string(out), "\n") {
			if !strings.Contains(line, " connected") {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) < 3 {
				continue
			}
			name := fields[0]
			primary := strings.Contains(line, " primary ")
			for _, f := range fields {
				if strings.Contains(f, "x") && strings.Contains(f, "+") {
					parts := strings.Split(f, "+")
					wh := strings.Split(parts[0], "x")
					if len(wh) == 2 && len(parts) >= 3 {
						w, _ := strconv.Atoi(wh[0])
						h, _ := strconv.Atoi(wh[1])
						lx, _ := strconv.Atoi(parts[1])
						ty, _ := strconv.Atoi(parts[2])
						if w > 0 && h > 0 {
							displays = append(displays, displayInfo{
								ID:      len(displays),
								Name:    name,
								Left:    lx,
								Top:     ty,
								Width:   w,
								Height:  h,
								Primary: primary,
							})
						}
					}
					break
				}
			}
		}
		if len(displays) > 0 {
			return displays, nil
		}
	}

	return []displayInfo{{ID: 0, Name: "Primary", Left: 0, Top: 0, Width: 1920, Height: 1080, Primary: true}}, nil
}

func captureRawScreenPng(disp displayInfo, roi *image.Rectangle) ([]byte, error) {
	tmp := filepath.Join(os.TempDir(), fmt.Sprintf("rd-cap-%d.png", os.Getpid()))
	defer os.Remove(tmp)

	var cmd *exec.Cmd
	if _, err := exec.LookPath("grim"); err == nil && isWaylandSession() {
		args := []string{}
		if roi != nil && !roi.Empty() {
			args = append(args, "-g", fmt.Sprintf("%d,%d %dx%d", disp.Left+roi.Min.X, disp.Top+roi.Min.Y, roi.Dx(), roi.Dy()))
		} else if disp.Name != "" && disp.Name != "Primary" {
			args = append(args, "-o", disp.Name)
		}
		args = append(args, tmp)
		cmd = exec.Command("grim", args...)
	} else if _, err := exec.LookPath("scrot"); err == nil {
		cmd = exec.Command("scrot", "-o", tmp)
	} else if _, err := exec.LookPath("import"); err == nil {
		args := []string{"-window", "root"}
		if roi != nil && !roi.Empty() {
			args = append(args, "-crop", fmt.Sprintf("%dx%d+%d+%d", roi.Dx(), roi.Dy(), disp.Left+roi.Min.X, disp.Top+roi.Min.Y))
		}
		args = append(args, tmp)
		cmd = exec.Command("import", args...)
	} else {
		return nil, fmt.Errorf("linux capture requires grim (Wayland), scrot, or imagemagick import (X11)")
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("screen capture failed: %v (%s)", err, strings.TrimSpace(string(out)))
	}
	return os.ReadFile(tmp)
}

func ffmpegSupportsPipewire() bool {
	out, err := exec.Command("ffmpeg", "-hide_banner", "-devices").Output()
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(out)), "pipewire")
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
	if disp.Width <= 0 || disp.Height <= 0 {
		disp.Width, disp.Height = w, h
	}

	var preInput []string
	var inputArgs []string
	if isWaylandSession() && ffmpegSupportsPipewire() {
		inputArgs = []string{
			"-f", "pipewire",
			"-framerate", strconv.Itoa(fps),
			"-i", "default",
		}
	} else {
		displayEnv := os.Getenv("DISPLAY")
		if displayEnv == "" {
			displayEnv = ":0.0"
		}
		inputArgs = []string{
			"-f", "x11grab",
			"-framerate", strconv.Itoa(fps),
			"-video_size", fmt.Sprintf("%dx%d", disp.Width, disp.Height),
			"-i", fmt.Sprintf("%s+%d,%d", displayEnv, disp.Left, disp.Top),
		}
	}

	var filterAndCodec []string
	if dev := vaapiRenderDevice(); dev != "" {
		preInput = []string{"-vaapi_device", dev}
		filterAndCodec = []string{
			"-vf", fmt.Sprintf("scale=%d:%d,format=nv12,hwupload", w, h),
			"-c:v", "h264_vaapi",
			"-profile:v", "constrained_baseline",
			"-b:v", "6000k",
			"-maxrate", "8000k",
			"-g", strconv.Itoa(fps * 2),
		}
	} else {
		filterAndCodec = []string{
			"-vf", fmt.Sprintf("scale=%d:%d", w, h),
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
	args = append(args, preInput...)
	args = append(args, inputArgs...)
	args = append(args, filterAndCodec...)
	args = append(args, "-flush_packets", "1", "-f", "h264", "pipe:1")
	return startFfmpegVideoCmd(args, false, w, h, fps, encoderTargetKbps(w, h, fps, quality))
}

func injectMousePlatform(req mouseReq, disp displayInfo, px, py int) error {
	if _, err := exec.LookPath("xdotool"); err == nil && os.Getenv("DISPLAY") != "" {
		if req.Action == "move_rel" {
			return exec.Command("xdotool", "mousemove_relative", "--", strconv.Itoa(int(req.DX)), strconv.Itoa(int(req.DY))).Run()
		}
		btn := "1"
		if req.Button == "right" {
			btn = "3"
		} else if req.Button == "middle" {
			btn = "2"
		}
		switch req.Action {
		case "move":
			return exec.Command("xdotool", "mousemove", strconv.Itoa(px), strconv.Itoa(py)).Run()
		case "down":
			return exec.Command("xdotool", "mousemove", strconv.Itoa(px), strconv.Itoa(py), "mousedown", btn).Run()
		case "up":
			return exec.Command("xdotool", "mousemove", strconv.Itoa(px), strconv.Itoa(py), "mouseup", btn).Run()
		case "click":
			return exec.Command("xdotool", "mousemove", strconv.Itoa(px), strconv.Itoa(py), "click", btn).Run()
		case "dblclick":
			return exec.Command("xdotool", "mousemove", strconv.Itoa(px), strconv.Itoa(py), "click", "--repeat", "2", btn).Run()
		case "wheel":
			wBtn := "4"
			dy := req.DeltaY
			if dy < 0 {
				wBtn = "5"
				dy = -dy
			}
			notches := dy / 120
			if notches < 1 {
				notches = 1
			}
			return exec.Command("xdotool", "click", "--repeat", strconv.Itoa(notches), wBtn).Run()
		}
	}

	if _, err := exec.LookPath("ydotool"); err == nil {
		if req.Action == "move_rel" {
			return exec.Command("ydotool", "mousemove", "--", strconv.Itoa(int(req.DX)), strconv.Itoa(int(req.DY))).Run()
		}
		if req.Action == "move" {
			return exec.Command("ydotool", "mousemove", "--absolute", "-x", strconv.Itoa(px), "-y", strconv.Itoa(py)).Run()
		}
		if req.Action == "click" {
			_ = exec.Command("ydotool", "mousemove", "--absolute", "-x", strconv.Itoa(px), "-y", strconv.Itoa(py)).Run()
			code := "0xC0" // left click
			if req.Button == "right" {
				code = "0xC1"
			} else if req.Button == "middle" {
				code = "0xC2"
			}
			return exec.Command("ydotool", "click", code).Run()
		}
	}
	return nil
}

func injectKeyPlatform(req keyReq) error {
	if _, err := exec.LookPath("xdotool"); err == nil && os.Getenv("DISPLAY") != "" {
		name := vkToXKeysym(req.VK)
		if name != "" {
			var parts []string
			if req.Mods.Ctrl {
				parts = append(parts, "ctrl")
			}
			if req.Mods.Alt {
				parts = append(parts, "alt")
			}
			if req.Mods.Shift {
				parts = append(parts, "shift")
			}
			if req.Mods.Meta {
				parts = append(parts, "super")
			}
			parts = append(parts, name)
			combo := strings.Join(parts, "+")
			if req.Action == "down" {
				return exec.Command("xdotool", "keydown", combo).Run()
			}
			if req.Action == "up" {
				return exec.Command("xdotool", "keyup", combo).Run()
			}
			return exec.Command("xdotool", "key", combo).Run()
		}
	}
	if req.Action != "up" {
		if _, err := exec.LookPath("wtype"); err == nil {
			if name := vkToXKeysym(req.VK); name != "" {
				return exec.Command("wtype", "-k", name).Run()
			}
		}
	}
	return nil
}

func injectTextPlatform(text string) error {
	if isWaylandSession() {
		if _, err := exec.LookPath("wtype"); err == nil {
			return exec.Command("wtype", text).Run()
		}
		if _, err := exec.LookPath("ydotool"); err == nil {
			return exec.Command("ydotool", "type", text).Run()
		}
	}
	if _, err := exec.LookPath("xdotool"); err == nil {
		return exec.Command("xdotool", "type", "--clearmodifiers", text).Run()
	}
	return nil
}

func getClipboardText() (string, error) {
	var cmd *exec.Cmd
	if _, err := exec.LookPath("wl-paste"); err == nil && isWaylandSession() {
		cmd = exec.Command("wl-paste", "--no-newline")
	} else if _, err := exec.LookPath("xclip"); err == nil {
		cmd = exec.Command("xclip", "-o", "-selection", "clipboard")
	} else if _, err := exec.LookPath("xsel"); err == nil {
		cmd = exec.Command("xsel", "-ob")
	} else {
		return "", nil
	}
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func setClipboardText(text string) error {
	var cmd *exec.Cmd
	if _, err := exec.LookPath("wl-copy"); err == nil && isWaylandSession() {
		cmd = exec.Command("wl-copy")
	} else if _, err := exec.LookPath("xclip"); err == nil {
		cmd = exec.Command("xclip", "-i", "-selection", "clipboard")
	} else if _, err := exec.LookPath("xsel"); err == nil {
		cmd = exec.Command("xsel", "-ib")
	} else {
		return nil
	}
	cmd.Stdin = strings.NewReader(text)
	return cmd.Run()
}

func audioCaptureInputArgs() []string {
	if out, err := exec.Command("pactl", "get-default-sink").Output(); err == nil {
		sink := strings.TrimSpace(string(out))
		if sink != "" {
			return []string{"-f", "pulse", "-i", sink + ".monitor"}
		}
	}
	return []string{"-f", "pulse", "-i", "default"}
}

func getClipboardImageBase64() string {
	var cmd *exec.Cmd
	if _, err := exec.LookPath("wl-paste"); err == nil && isWaylandSession() {
		cmd = exec.Command("wl-paste", "--type", "image/png")
	} else if _, err := exec.LookPath("xclip"); err == nil {
		cmd = exec.Command("xclip", "-o", "-selection", "clipboard", "-t", "image/png")
	} else {
		return ""
	}
	out, err := cmd.Output()
	if err != nil || len(out) < 16 {
		return ""
	}
	return base64.StdEncoding.EncodeToString(out)
}

func setClipboardImageBase64(b64 string) error {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return err
	}
	var cmd *exec.Cmd
	if _, err := exec.LookPath("wl-copy"); err == nil && isWaylandSession() {
		cmd = exec.Command("wl-copy", "--type", "image/png")
	} else if _, err := exec.LookPath("xclip"); err == nil {
		cmd = exec.Command("xclip", "-i", "-selection", "clipboard", "-t", "image/png")
	} else {
		return fmt.Errorf("linux clipboard image requires wl-copy or xclip")
	}
	cmd.Stdin = strings.NewReader(string(raw))
	return cmd.Run()
}

func setPrivacyScreenPlatform(enabled bool) error {
	if _, err := exec.LookPath("xrandr"); err != nil {
		return fmt.Errorf("linux privacy blackout requires xrandr")
	}
	displays, _ := listDisplays()
	val := "1"
	if enabled {
		val = "0"
	}
	applied := false
	for _, d := range displays {
		if d.Name == "" || d.Name == "Primary" {
			continue
		}
		if exec.Command("xrandr", "--output", d.Name, "--brightness", val).Run() == nil {
			applied = true
		}
	}
	if !applied {
		return fmt.Errorf("no active xrandr output found")
	}
	return nil
}
