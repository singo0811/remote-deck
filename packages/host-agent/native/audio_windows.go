//go:build windows

package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

var (
	ole32               = syscall.NewLazyDLL("ole32.dll")
	procCoInitializeEx  = ole32.NewProc("CoInitializeEx")
	procCoUninitialize  = ole32.NewProc("CoUninitialize")
	procCoCreateInstance = ole32.NewProc("CoCreateInstance")
	procCoTaskMemFree   = ole32.NewProc("CoTaskMemFree")
)

type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

var (
	clsidMMDeviceEnumerator = guid{0xBCDE0395, 0xE52F, 0x467C, [8]byte{0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}}
	iidIMMDeviceEnumerator  = guid{0xA95664D2, 0x9614, 0x4F35, [8]byte{0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}}
	iidIAudioClient         = guid{0x1CB9AD4C, 0xDBFA, 0x4C32, [8]byte{0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2}}
	iidIAudioCaptureClient  = guid{0xC8ADBD64, 0xE71E, 0x48A0, [8]byte{0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17}}
	subtypeIEEEFloat        = guid{0x00000003, 0x0000, 0x0010, [8]byte{0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}}
	subtypePCM              = guid{0x00000001, 0x0000, 0x0010, [8]byte{0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}}
)

type waveFormatEx struct {
	WFormatTag      uint16
	NChannels       uint16
	NSamplesPerSec  uint32
	NAvgBytesPerSec uint32
	NBlockAlign     uint16
	WBitsPerSample  uint16
	CbSize          uint16
}

type waveFormatExtensible struct {
	Format      waveFormatEx
	Samples     uint16
	ChannelMask uint32
	SubFormat   guid
}

func comMethod(obj uintptr, index uintptr) uintptr {
	vtbl := *(*uintptr)(unsafe.Pointer(obj))
	return *(*uintptr)(unsafe.Pointer(vtbl + index*unsafe.Sizeof(uintptr(0))))
}

func comRelease(obj uintptr) {
	if obj != 0 {
		syscall.SyscallN(comMethod(obj, 2), obj)
	}
}

var (
	audioMu           sync.Mutex
	audioRunning      atomic.Bool
	audioLowBandwidth atomic.Bool
	audioPreferOpus   atomic.Bool
	audioStopCh       chan struct{}
	audioDoneCh       chan struct{}
)

// decimatePcm2x halves the sample rate with a 2-tap box filter (cheap anti-alias),
// turning 48 kHz into 24 kHz while keeping all channels interleaved.
func decimatePcm2x(pcm []byte, channels int) []byte {
	frameBytes := channels * 2
	frames := len(pcm) / frameBytes
	if frames < 2 {
		return pcm
	}
	outFrames := frames / 2
	out := make([]byte, outFrames*frameBytes)
	for f := 0; f < outFrames; f++ {
		for ch := 0; ch < channels; ch++ {
			offA := (f*2*frameBytes) + ch*2
			offB := offA + frameBytes
			a := int(int16(binary.LittleEndian.Uint16(pcm[offA : offA+2])))
			b := int(int16(binary.LittleEndian.Uint16(pcm[offB : offB+2])))
			avg := int16((a + b) / 2)
			dst := f*frameBytes + ch*2
			binary.LittleEndian.PutUint16(out[dst:dst+2], uint16(avg))
		}
	}
	return out
}

func startAudioCapture(lowBandwidth bool) {
	startAudioCaptureWithOpts(lowBandwidth, false)
}

func startAudioCaptureWithOpts(lowBandwidth bool, preferOpus bool) {
	audioMu.Lock()
	prevOpus := audioPreferOpus.Swap(preferOpus)
	prevLow := audioLowBandwidth.Swap(lowBandwidth)
	var waitDone chan struct{}
	if audioRunning.Load() {
		if prevOpus == preferOpus && prevLow == lowBandwidth {
			audioMu.Unlock()
			return
		}
		audioRunning.Store(false)
		if audioStopCh != nil {
			close(audioStopCh)
			audioStopCh = nil
		}
		waitDone = audioDoneCh
	}
	audioMu.Unlock()

	if waitDone != nil {
		<-waitDone
	}

	audioMu.Lock()
	stopCh := make(chan struct{})
	doneCh := make(chan struct{})
	audioStopCh = stopCh
	audioDoneCh = doneCh
	audioRunning.Store(true)
	audioMu.Unlock()
	go runWasapiLoopback(stopCh, doneCh)
}

func stopAudioCapture() {
	audioMu.Lock()
	if !audioRunning.Load() {
		audioMu.Unlock()
		return
	}
	audioRunning.Store(false)
	if audioStopCh != nil {
		close(audioStopCh)
		audioStopCh = nil
	}
	doneCh := audioDoneCh
	audioMu.Unlock()
	if doneCh != nil {
		<-doneCh
	}
}

func runWasapiLoopback(stopCh chan struct{}, doneCh chan struct{}) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer func() {
		audioRunning.Store(false)
		close(doneCh)
	}()

	hr, _, _ := procCoInitializeEx.Call(0, 0) // COINIT_MULTITHREADED
	if hr == 0 || hr == 1 {
		defer procCoUninitialize.Call()
	}

	var enumerator uintptr
	r, _, _ := procCoCreateInstance.Call(
		uintptr(unsafe.Pointer(&clsidMMDeviceEnumerator)),
		0,
		23, // CLSCTX_ALL
		uintptr(unsafe.Pointer(&iidIMMDeviceEnumerator)),
		uintptr(unsafe.Pointer(&enumerator)),
	)
	if r != 0 || enumerator == 0 {
		writeJSONFrame(evtJSON, map[string]any{"op": "audio_error", "error": fmt.Sprintf("CoCreateInstance failed: 0x%x", r)})
		return
	}
	defer comRelease(enumerator)

	var device uintptr
	r, _, _ = syscall.SyscallN(comMethod(enumerator, 4), enumerator, 0, 0, uintptr(unsafe.Pointer(&device))) // eRender, eConsole
	if r != 0 || device == 0 {
		writeJSONFrame(evtJSON, map[string]any{"op": "audio_error", "error": fmt.Sprintf("GetDefaultAudioEndpoint failed: 0x%x", r)})
		return
	}
	defer comRelease(device)

	var audioClient uintptr
	r, _, _ = syscall.SyscallN(comMethod(device, 3), device, uintptr(unsafe.Pointer(&iidIAudioClient)), 23, 0, uintptr(unsafe.Pointer(&audioClient)))
	if r != 0 || audioClient == 0 {
		writeJSONFrame(evtJSON, map[string]any{"op": "audio_error", "error": fmt.Sprintf("Activate IAudioClient failed: 0x%x", r)})
		return
	}
	defer comRelease(audioClient)

	var pwfx uintptr
	r, _, _ = syscall.SyscallN(comMethod(audioClient, 8), audioClient, uintptr(unsafe.Pointer(&pwfx))) // GetMixFormat
	if r != 0 || pwfx == 0 {
		writeJSONFrame(evtJSON, map[string]any{"op": "audio_error", "error": fmt.Sprintf("GetMixFormat failed: 0x%x", r)})
		return
	}
	defer procCoTaskMemFree.Call(pwfx)

	wfx := *(*waveFormatEx)(unsafe.Pointer(pwfx))
	isFloat := wfx.WFormatTag == 3
	if wfx.WFormatTag == 0xFFFE && wfx.CbSize >= 22 {
		ext := *(*waveFormatExtensible)(unsafe.Pointer(pwfx))
		if ext.SubFormat == subtypeIEEEFloat {
			isFloat = true
		} else if ext.SubFormat == subtypePCM {
			isFloat = false
		}
	}

	const audclntStreamflagsLoopback = 0x00020000
	const hnsBufferDuration = 10000000 // 1s
	r, _, _ = syscall.SyscallN(
		comMethod(audioClient, 3), // Initialize
		audioClient,
		0, // AUDCLNT_SHAREMODE_SHARED
		audclntStreamflagsLoopback,
		hnsBufferDuration,
		0,
		pwfx,
		0,
	)
	if r != 0 {
		writeJSONFrame(evtJSON, map[string]any{"op": "audio_error", "error": fmt.Sprintf("IAudioClient.Initialize failed: 0x%x", r)})
		return
	}

	var captureClient uintptr
	r, _, _ = syscall.SyscallN(comMethod(audioClient, 14), audioClient, uintptr(unsafe.Pointer(&iidIAudioCaptureClient)), uintptr(unsafe.Pointer(&captureClient)))
	if r != 0 || captureClient == 0 {
		writeJSONFrame(evtJSON, map[string]any{"op": "audio_error", "error": fmt.Sprintf("GetService(IAudioCaptureClient) failed: 0x%x", r)})
		return
	}
	defer comRelease(captureClient)

	r, _, _ = syscall.SyscallN(comMethod(audioClient, 10), audioClient) // Start
	if r != 0 {
		writeJSONFrame(evtJSON, map[string]any{"op": "audio_error", "error": fmt.Sprintf("IAudioClient.Start failed: 0x%x", r)})
		return
	}
	defer syscall.SyscallN(comMethod(audioClient, 11), audioClient) // Stop

	srcRate := int(wfx.NSamplesPerSec)
	srcCh := int(wfx.NChannels)
	if srcRate <= 0 || srcCh <= 0 {
		return
	}
	outCh := 2
	if srcCh == 1 {
		outCh = 1
	}
	useOpus := audioPreferOpus.Load() && opusEncoderAvailable()
	var opusEnc *opusPipe
	var sentHead bool
	if useOpus {
		kbps := 96
		if audioLowBandwidth.Load() {
			kbps = 48
		}
		enc, encErr := startOpusEncoder(srcRate, outCh, kbps, func(pkt []byte, head []byte) {
			meta := map[string]any{
				"codec":      "opus",
				"sampleRate": 48000,
				"channels":   outCh,
				"frames":     960,
			}
			if !sentHead && len(head) >= 19 {
				sentHead = true
				meta["head"] = base64.StdEncoding.EncodeToString(head)
			}
			metaBytes, _ := json.Marshal(meta)
			out := make([]byte, 4+len(metaBytes)+len(pkt))
			binary.BigEndian.PutUint32(out[0:4], uint32(len(metaBytes)))
			copy(out[4:4+len(metaBytes)], metaBytes)
			copy(out[4+len(metaBytes):], pkt)
			_ = writeFrame(evtAudioFrame, out)
		})
		if encErr == nil {
			opusEnc = enc
			defer func() {
				if opusEnc != nil {
					opusEnc.Close()
				}
			}()
		} else {
			useOpus = false
		}
	}

	// Narrow-band mode (relay / WebRTC without Opus): halve the sample rate so
	// WAN audio keeps roughly 90 kbps and never starves the video stream.
	decimate := !useOpus && audioLowBandwidth.Load() && srcRate >= 32000
	outRate := srcRate
	if decimate {
		outRate = srcRate / 2
	}
	chunkFrames := outRate / 25 // ~40ms per chunk
	if useOpus {
		chunkFrames = outRate / 50 // 20ms Opus frames
	}
	if chunkFrames < 480 {
		chunkFrames = 480
	}
	pcmBuf := make([]byte, 0, chunkFrames*outCh*2)

	flushChunk := func() {
		if len(pcmBuf) == 0 {
			return
		}
		if opusEnc != nil {
			if err := opusEnc.WritePCM(pcmBuf); err == nil {
				pcmBuf = pcmBuf[:0]
				return
			}
			opusEnc.Close()
			opusEnc = nil
			useOpus = false
		}
		var payload []byte
		var metaBytes []byte
		if !audioLowBandwidth.Load() {
			frames := len(pcmBuf) / (outCh * 2)
			if frames == 0 {
				pcmBuf = pcmBuf[:0]
				return
			}
			payload = make([]byte, len(pcmBuf))
			copy(payload, pcmBuf)
			metaBytes, _ = json.Marshal(map[string]any{
				"codec":      "pcm16",
				"sampleRate": outRate,
				"channels":   outCh,
				"frames":     frames,
			})
		} else {
			encoded, frames := encodeImaAdpcm(pcmBuf, outCh)
			if len(encoded) == 0 || frames == 0 {
				pcmBuf = pcmBuf[:0]
				return
			}
			payload = encoded
			metaBytes, _ = json.Marshal(map[string]any{
				"codec":      "ima_adpcm",
				"sampleRate": outRate,
				"channels":   outCh,
				"frames":     frames,
			})
		}
		out := make([]byte, 4+len(metaBytes)+len(payload))
		binary.BigEndian.PutUint32(out[0:4], uint32(len(metaBytes)))
		copy(out[4:4+len(metaBytes)], metaBytes)
		copy(out[4+len(metaBytes):], payload)
		_ = writeFrame(evtAudioFrame, out)
		pcmBuf = pcmBuf[:0]
	}

	ticker := time.NewTicker(15 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-stopCh:
			return
		case <-ticker.C:
			for {
				var packetFrames uint32
				r, _, _ := syscall.SyscallN(comMethod(captureClient, 5), captureClient, uintptr(unsafe.Pointer(&packetFrames)))
				if r != 0 || packetFrames == 0 {
					break
				}
				var dataPtr uintptr
				var numFrames uint32
				var flags uint32
				r, _, _ = syscall.SyscallN(
					comMethod(captureClient, 3), // GetBuffer
					captureClient,
					uintptr(unsafe.Pointer(&dataPtr)),
					uintptr(unsafe.Pointer(&numFrames)),
					uintptr(unsafe.Pointer(&flags)),
					0,
					0,
				)
				if r != 0 {
					break
				}

				if numFrames > 0 && dataPtr != 0 && (flags&0x2) == 0 { // not AUDCLNT_BUFFERFLAGS_SILENT
					byteCount := int(numFrames) * int(wfx.NBlockAlign)
					raw := unsafe.Slice((*byte)(unsafe.Pointer(dataPtr)), byteCount)
					nonZero := false
					tmp := make([]byte, int(numFrames)*outCh*2)
					bytesPerSample := int(wfx.WBitsPerSample) / 8

					for f := 0; f < int(numFrames); f++ {
						for ch := 0; ch < outCh; ch++ {
							srcIdx := f*int(wfx.NBlockAlign) + ch*bytesPerSample
							var s16 int16
							if isFloat && bytesPerSample == 4 && srcIdx+4 <= len(raw) {
								bits := binary.LittleEndian.Uint32(raw[srcIdx : srcIdx+4])
								fv := math.Float32frombits(bits)
								if fv > 1 {
									fv = 1
								} else if fv < -1 {
									fv = -1
								}
								s16 = int16(fv * 32767)
							} else if !isFloat && bytesPerSample == 2 && srcIdx+2 <= len(raw) {
								s16 = int16(binary.LittleEndian.Uint16(raw[srcIdx : srcIdx+2]))
							}
							if s16 > 4 || s16 < -4 {
								nonZero = true
							}
							di := (f*outCh + ch) * 2
							binary.LittleEndian.PutUint16(tmp[di:di+2], uint16(s16))
						}
					}

					if nonZero {
						out := tmp
						if decimate {
							out = decimatePcm2x(tmp, outCh)
						}
						pcmBuf = append(pcmBuf, out...)
						if len(pcmBuf) >= chunkFrames*outCh*2 {
							flushChunk()
						}
					}
				}
				syscall.SyscallN(comMethod(captureClient, 4), captureClient, uintptr(numFrames)) // ReleaseBuffer
			}
		}
	}
}
