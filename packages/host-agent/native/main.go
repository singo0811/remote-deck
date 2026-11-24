package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
)

const (
	cmdDisplays     byte = 0x01
	cmdCapture      byte = 0x02
	cmdMouse        byte = 0x03
	cmdKey          byte = 0x04
	cmdText         byte = 0x05
	cmdClipboard    byte = 0x06
	cmdAudioStart   byte = 0x07
	cmdAudioStop    byte = 0x08
	cmdPrivacy      byte = 0x09
	cmdSysInfo      byte = 0x0A
	cmdVideoStart   byte = 0x0C
	cmdVideoStop    byte = 0x0D
	cmdPtyOpen      byte = 0x10
	cmdPtyInput     byte = 0x11
	cmdPtyResize    byte = 0x12
	cmdPtyClose     byte = 0x13

	evtJSON        byte = 0x81
	evtScreenFrame byte = 0x82
	evtClipboard   byte = 0x83
	evtAudioFrame  byte = 0x84
	evtVideoPacket byte = 0x85
	evtPtyOpened   byte = 0x90
	evtPtyOutput   byte = 0x91
	evtPtyExit     byte = 0x92
)

var writeMu sync.Mutex

func writeFrame(frameType byte, payload []byte) error {
	writeMu.Lock()
	defer writeMu.Unlock()
	var hdr [5]byte
	hdr[0] = frameType
	binary.BigEndian.PutUint32(hdr[1:5], uint32(len(payload)))
	if _, err := os.Stdout.Write(hdr[:]); err != nil {
		return err
	}
	if len(payload) > 0 {
		if _, err := os.Stdout.Write(payload); err != nil {
			return err
		}
	}
	return nil
}

func writeJSONFrame(frameType byte, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal error: %v\n", err)
		return
	}
	if err := writeFrame(frameType, b); err != nil {
		fmt.Fprintf(os.Stderr, "writeFrame error: %v\n", err)
	}
}

// writeScreenFrame sends one JPEG frame (metadata + payload) to the parent.
func writeScreenFrame(meta map[string]any, jpeg []byte) {
	metaBytes, err := json.Marshal(meta)
	if err != nil {
		return
	}
	out := make([]byte, 4+len(metaBytes)+len(jpeg))
	binary.BigEndian.PutUint32(out[0:4], uint32(len(metaBytes)))
	copy(out[4:4+len(metaBytes)], metaBytes)
	copy(out[4+len(metaBytes):], jpeg)
	_ = writeFrame(evtScreenFrame, out)
}

type captureReq struct {
	ReqID       string  `json:"reqId"`
	DisplayID   int     `json:"displayId"`
	Scale       float64 `json:"scale"`
	MaxWidth    int     `json:"maxWidth"`
	SingleFrame bool    `json:"singleFrame"`
	Quality     int     `json:"quality"`
	LastHash    string  `json:"lastHash"`
	Seq         uint64  `json:"seq"`
	AllowDirty     bool    `json:"allowDirty"`
	ForceKey       bool    `json:"forceKey"`
	SeparateCursor bool    `json:"separateCursor"`
	CursorShapeID  uint64  `json:"cursorShapeId"`
	Video          bool    `json:"video"`
	FPS         int     `json:"fps"`
	PaceMS      int     `json:"paceMs"`
	RoiX        float64 `json:"roiX"`
	RoiY        float64 `json:"roiY"`
	RoiW        float64 `json:"roiW"`
	RoiH        float64 `json:"roiH"`
}

type mouseReq struct {
	Action    string  `json:"action"`
	X         float64 `json:"x"`
	Y         float64 `json:"y"`
	DX        float64 `json:"dx"`
	DY        float64 `json:"dy"`
	Button    string  `json:"button"`
	DeltaY    int     `json:"deltaY"`
	DisplayID int     `json:"displayId"`
}

type keyMods struct {
	Ctrl  bool `json:"ctrl"`
	Alt   bool `json:"alt"`
	Shift bool `json:"shift"`
	Meta  bool `json:"meta"`
}

type keyReq struct {
	Action string  `json:"action"`
	VK     int     `json:"vk"`
	Code   string  `json:"code"`
	Mods   keyMods `json:"mods"`
}

type textReq struct {
	Text string `json:"text"`
}

type clipboardReq struct {
	ReqID       string `json:"reqId"`
	Op          string `json:"op"`
	Text        string `json:"text"`
	ImageBase64 string `json:"imageBase64"`
	Enabled     bool   `json:"enabled"`
}

type ptyOpenReq struct {
	ID    string `json:"id"`
	Cols  int    `json:"cols"`
	Rows  int    `json:"rows"`
	Shell string `json:"shell"`
	Cwd   string `json:"cwd"`
}

type ptyResizeReq struct {
	ID   string `json:"id"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

type ptyCloseReq struct {
	ID string `json:"id"`
}

func main() {
	initPlatform()
	defer closeAllPtys()
	defer stopAudioCapture()
	defer stopVideoEncoder()
	defer setClipboardWatch(false)
	defer func() { _ = setPrivacyScreen(false) }()

	reader := bufio.NewReaderSize(os.Stdin, 256*1024)
	var hdr [5]byte

	for {
		if _, err := io.ReadFull(reader, hdr[:]); err != nil {
			if err != io.EOF {
				fmt.Fprintf(os.Stderr, "stdin read error: %v\n", err)
			}
			return
		}
		frameType := hdr[0]
		length := binary.BigEndian.Uint32(hdr[1:5])
		if length > 32*1024*1024 {
			fmt.Fprintf(os.Stderr, "frame too large: %d\n", length)
			return
		}
		payload := make([]byte, length)
		if length > 0 {
			if _, err := io.ReadFull(reader, payload); err != nil {
				fmt.Fprintf(os.Stderr, "payload read error: %v\n", err)
				return
			}
		}

		switch frameType {
		case cmdDisplays:
			var req struct {
				ReqID string `json:"reqId"`
			}
			_ = json.Unmarshal(payload, &req)
			displays, err := listDisplaysFresh()
			if err != nil {
				writeJSONFrame(evtJSON, map[string]any{"reqId": req.ReqID, "op": "displays", "error": err.Error()})
			} else {
				writeJSONFrame(evtJSON, map[string]any{"reqId": req.ReqID, "op": "displays", "displays": displays})
			}

		case cmdCapture:
			var req captureReq
			if err := json.Unmarshal(payload, &req); err != nil {
				writeJSONFrame(evtJSON, map[string]any{"op": "capture_error", "error": err.Error()})
				continue
			}
			// Run capture asynchronously so input/PTY commands never block behind JPEG encoding.
			go func(r captureReq) {
				meta, jpegBytes, err := captureDisplay(r)
				if err != nil {
					writeJSONFrame(evtJSON, map[string]any{"reqId": r.ReqID, "op": "capture_error", "error": err.Error()})
					return
				}
				// Extra dirty rectangles are emitted by captureDisplay itself;
				// the returned frame (full or first rect) is written here.
				if jpegBytes != nil {
					writeScreenFrame(meta, jpegBytes)
					return
				}
				if meta != nil {
					writeScreenFrame(meta, []byte{})
				}
			}(req)

		case cmdMouse:
			var req mouseReq
			if err := json.Unmarshal(payload, &req); err == nil {
				if err := injectMouse(req); err != nil {
					fmt.Fprintf(os.Stderr, "mouse error: %v\n", err)
				}
			}

		case cmdKey:
			var req keyReq
			if err := json.Unmarshal(payload, &req); err == nil {
				if err := injectKey(req); err != nil {
					fmt.Fprintf(os.Stderr, "key error: %v\n", err)
				}
			}

		case cmdText:
			var req textReq
			if err := json.Unmarshal(payload, &req); err == nil {
				if err := injectText(req.Text); err != nil {
					fmt.Fprintf(os.Stderr, "text error: %v\n", err)
				}
			}

		case cmdClipboard:
			var req clipboardReq
			if err := json.Unmarshal(payload, &req); err == nil {
				switch req.Op {
				case "set":
					var err error
					if req.ImageBase64 != "" {
						err = setClipboardImageBase64(req.ImageBase64)
					} else {
						err = setClipboardText(req.Text)
					}
					writeJSONFrame(evtClipboard, map[string]any{"reqId": req.ReqID, "op": "set", "ok": err == nil, "error": errString(err)})
				case "watch":
					setClipboardWatch(req.Enabled)
					writeJSONFrame(evtClipboard, map[string]any{"reqId": req.ReqID, "op": "watch", "enabled": req.Enabled})
				default:
					txt, imgB64, err := getClipboardContent()
					writeJSONFrame(evtClipboard, map[string]any{
						"reqId":       req.ReqID,
						"op":          "get",
						"text":        txt,
						"imageBase64": imgB64,
						"error":       errString(err),
					})
				}
			}

		case cmdAudioStart:
			var req struct {
				LowBandwidth bool   `json:"lowBandwidth"`
				Codec        string `json:"codec"`
				PreferOpus   bool   `json:"preferOpus"`
			}
			_ = json.Unmarshal(payload, &req)
			preferOpus := req.PreferOpus || req.Codec == "opus"
			startAudioCaptureWithOpts(req.LowBandwidth, preferOpus)

		case cmdAudioStop:
			stopAudioCapture()

		case cmdVideoStart:
			var req struct {
				Width   int `json:"width"`
				Height  int `json:"height"`
				FPS     int `json:"fps"`
				Quality int `json:"quality"`
			}
			if err := json.Unmarshal(payload, &req); err == nil {
				if err := startVideoEncoderIfNeeded(req.Width, req.Height, req.FPS, req.Quality); err != nil {
					writeJSONFrame(evtJSON, map[string]any{"op": "video_error", "error": err.Error()})
				}
			}

		case cmdVideoStop:
			stopVideoEncoder()

		case cmdPrivacy:
			var req struct {
				ReqID   string `json:"reqId"`
				Enabled bool   `json:"enabled"`
			}
			if err := json.Unmarshal(payload, &req); err == nil {
				err := setPrivacyScreen(req.Enabled)
				writeJSONFrame(evtJSON, map[string]any{
					"reqId":   req.ReqID,
					"op":      "privacy",
					"enabled": req.Enabled && err == nil,
					"error":   errString(err),
				})
			}

		case cmdSysInfo:
			var req struct {
				ReqID string `json:"reqId"`
			}
			_ = json.Unmarshal(payload, &req)
			writeJSONFrame(evtJSON, map[string]any{
				"reqId":        req.ReqID,
				"op":           "sysinfo",
				"elevated":     isProcessElevated(),
				"videoEncoder": videoEncoderAvailable(),
			})

		case cmdPtyOpen:
			var req ptyOpenReq
			if err := json.Unmarshal(payload, &req); err == nil {
				openPty(req)
			}

		case cmdPtyInput:
			if len(payload) >= 4 {
				idLen := binary.BigEndian.Uint32(payload[0:4])
				if int(4+idLen) <= len(payload) {
					id := string(payload[4 : 4+idLen])
					data := payload[4+idLen:]
					writePty(id, data)
				}
			}

		case cmdPtyResize:
			var req ptyResizeReq
			if err := json.Unmarshal(payload, &req); err == nil {
				resizePty(req.ID, req.Cols, req.Rows)
			}

		case cmdPtyClose:
			var req ptyCloseReq
			if err := json.Unmarshal(payload, &req); err == nil {
				closePty(req.ID)
			}
		}
	}
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
