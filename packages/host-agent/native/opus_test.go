package main

import (
	"bytes"
	"encoding/binary"
	"math"
	"sync"
	"testing"
	"time"
)

func TestOpusEncoderProducesValidPackets(t *testing.T) {
	if !opusEncoderAvailable() {
		t.Skip("ffmpeg libopus not available")
	}

	var mu sync.Mutex
	var packets [][]byte
	var gotHead []byte

	enc, err := startOpusEncoder(48000, 2, 64, func(pkt []byte, head []byte) {
		mu.Lock()
		packets = append(packets, append([]byte(nil), pkt...))
		if len(gotHead) == 0 && len(head) > 0 {
			gotHead = append([]byte(nil), head...)
		}
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("startOpusEncoder: %v", err)
	}
	defer enc.Close()

	// Feed 300ms of 48kHz stereo sine wave in 20ms (960-frame) chunks.
	const framesPerChunk = 960
	pcm := make([]byte, framesPerChunk*2*2)
	for c := 0; c < 15; c++ {
		for f := 0; f < framesPerChunk; f++ {
			sampleIdx := c*framesPerChunk + f
			v := int16(12000 * math.Sin(2*math.Pi*440*float64(sampleIdx)/48000))
			binary.LittleEndian.PutUint16(pcm[f*4:f*4+2], uint16(v))
			binary.LittleEndian.PutUint16(pcm[f*4+2:f*4+4], uint16(v))
		}
		if err := enc.WritePCM(pcm); err != nil {
			t.Fatalf("WritePCM(%d): %v", c, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	enc.Close()

	mu.Lock()
	defer mu.Unlock()
	if len(gotHead) < 19 || !bytes.Equal(gotHead[:8], []byte("OpusHead")) {
		t.Fatalf("expected OpusHead header, got %d bytes", len(gotHead))
	}
	if len(packets) < 10 {
		t.Fatalf("expected >=10 Opus packets for 300ms audio, got %d", len(packets))
	}
	for i, pkt := range packets {
		if len(pkt) < 2 {
			t.Fatalf("packet %d too short: %d", i, len(pkt))
		}
	}
}
