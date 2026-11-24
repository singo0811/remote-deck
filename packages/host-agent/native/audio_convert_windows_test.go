//go:build windows

package main

import (
	"encoding/binary"
	"math"
	"testing"
)

// buildFloat32Stereo makes `frames` of a sine at `amp` (0..1) as float32 stereo.
func buildFloat32Stereo(frames int, freq, rate float64, amp float64) ([]byte, waveFormatEx) {
	raw := make([]byte, frames*8)
	for i := 0; i < frames; i++ {
		v := amp * math.Sin(2*math.Pi*freq*float64(i)/rate)
		bits := math.Float32bits(float32(v))
		binary.LittleEndian.PutUint32(raw[i*8:], bits)
		binary.LittleEndian.PutUint32(raw[i*8+4:], bits)
	}
	return raw, waveFormatEx{
		NChannels:      2,
		NSamplesPerSec: uint32(rate),
		NBlockAlign:    8,
		WBitsPerSample: 32,
		CbSize:         22,
	}
}

func rmsOf(pcm []byte) (peak float64, rms float64) {
	n := 0
	var sumSq float64
	for i := 0; i+1 < len(pcm); i += 2 {
		v := float64(int16(binary.LittleEndian.Uint16(pcm[i : i+2])))
		if math.Abs(v) > peak {
			peak = math.Abs(v)
		}
		sumSq += v * v
		n++
	}
	if n == 0 {
		return 0, 0
	}
	return peak, math.Sqrt(sumSq / float64(n))
}

// A 32-bit IEEE-float device must be decoded as float. Reading those bytes as
// 32-bit integer PCM (the old mis-detection) produces full-scale noise.
func TestConvertFloat32MixFormatProducesCleanAudio(t *testing.T) {
	const frames = 4800
	raw, wfx := buildFloat32Stereo(frames, 440, 48000, 0.5)

	pcm, nonZero := convertAudioToPCM16S16(raw, frames, wfx, true, 2)
	if !nonZero {
		t.Fatal("half-scale input was treated as silence")
	}
	peak, rms := rmsOf(pcm)
	if peak < 15000 || peak > 17000 {
		t.Fatalf("peak = %.0f, want ~16384 for a -6 dBFS sine", peak)
	}
	// Sine crest factor is ~1.41; noise decoded from float bits would show a far
	// higher crest factor and near-full-scale RMS.
	if rms < 10000 || rms > 13000 {
		t.Fatalf("rms = %.0f, want ~11585 (noise mis-decode would be much higher)", rms)
	}
}

// Mis-reading the same float buffer as integer must be visibly wrong — this is
// the regression guard for the offset bug in the WAVEFORMATEXTENSIBLE layout.
func TestConvertFloatBufferAsIntegerIsNoise(t *testing.T) {
	const frames = 4800
	raw, wfx := buildFloat32Stereo(frames, 440, 48000, 0.5)
	pcm, _ := convertAudioToPCM16S16(raw, frames, wfx, false, 2)
	_, rms := rmsOf(pcm)
	if rms < 15000 {
		t.Fatalf("expected mis-decoded float bits to be loud noise, rms = %.0f", rms)
	}
}

func TestConvertInteger32MixFormat(t *testing.T) {
	const frames = 4800
	raw := make([]byte, frames*8)
	for i := 0; i < frames; i++ {
		v := int32(0.5 * math.Sin(2*math.Pi*440*float64(i)/48000) * 2147483647)
		binary.LittleEndian.PutUint32(raw[i*8:], uint32(v))
		binary.LittleEndian.PutUint32(raw[i*8+4:], uint32(v))
	}
	wfx := waveFormatEx{NChannels: 2, NSamplesPerSec: 48000, NBlockAlign: 8, WBitsPerSample: 32, CbSize: 22}
	pcm, nonZero := convertAudioToPCM16S16(raw, frames, wfx, false, 2)
	if !nonZero {
		t.Fatal("32-bit integer input was treated as silence")
	}
	peak, _ := rmsOf(pcm)
	if peak < 15000 || peak > 17000 {
		t.Fatalf("peak = %.0f, want ~16384", peak)
	}
}

func TestConvertInt16PassThrough(t *testing.T) {
	const frames = 4
	wfx := waveFormatEx{NChannels: 2, NSamplesPerSec: 48000, NBlockAlign: 4, WBitsPerSample: 16}
	raw := make([]byte, frames*4)
	for i := 0; i < frames; i++ {
		binary.LittleEndian.PutUint16(raw[i*4:], uint16(1000))
		binary.LittleEndian.PutUint16(raw[i*4+2:], uint16(2000))
	}
	pcm, nonZero := convertAudioToPCM16S16(raw, frames, wfx, false, 2)
	if !nonZero {
		t.Fatal("int16 input was treated as silence")
	}
	if got := int16(binary.LittleEndian.Uint16(pcm[0:2])); got != 1000 {
		t.Fatalf("left = %d, want 1000", got)
	}
	if got := int16(binary.LittleEndian.Uint16(pcm[2:4])); got != 2000 {
		t.Fatalf("right = %d, want 2000", got)
	}
}
