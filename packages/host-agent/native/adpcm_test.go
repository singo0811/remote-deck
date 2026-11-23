package main

import (
	"encoding/binary"
	"math"
	"testing"
)

func TestImaAdpcmRoundtrip(t *testing.T) {
	for _, ch := range []int{1, 2} {
		frames := 480
		pcm := make([]byte, frames*ch*2)
		for f := 0; f < frames; f++ {
			v0 := int16(12000 * math.Sin(2*math.Pi*440*float64(f)/48000))
			if ch == 1 {
				binary.LittleEndian.PutUint16(pcm[f*2:f*2+2], uint16(v0))
			} else {
				v1 := int16(10000 * math.Cos(2*math.Pi*660*float64(f)/48000))
				binary.LittleEndian.PutUint16(pcm[f*4:f*4+2], uint16(v0))
				binary.LittleEndian.PutUint16(pcm[f*4+2:f*4+4], uint16(v1))
			}
		}

		enc, gotFrames := encodeImaAdpcm(pcm, ch)
		if gotFrames != frames {
			t.Fatalf("ch=%d expected %d frames, got %d", ch, frames, gotFrames)
		}
		if len(enc) >= len(pcm)/2 {
			t.Fatalf("ch=%d expected ~4:1 compression, got %d vs %d", ch, len(enc), len(pcm))
		}
		dec := decodeImaAdpcm(enc, ch, gotFrames)
		if len(dec) != len(pcm) {
			t.Fatalf("ch=%d expected decoded len %d, got %d", ch, len(pcm), len(dec))
		}
		var sumSq float64
		var steadyMaxErr int
		for f := 0; f < frames; f++ {
			for c := 0; c < ch; c++ {
				off := (f*ch + c) * 2
				a := int(int16(binary.LittleEndian.Uint16(pcm[off : off+2])))
				b := int(int16(binary.LittleEndian.Uint16(dec[off : off+2])))
				diff := a - b
				if diff < 0 {
					diff = -diff
				}
				sumSq += float64(diff * diff)
				if f >= 16 && diff > steadyMaxErr {
					steadyMaxErr = diff
				}
			}
		}
		rmse := math.Sqrt(sumSq / float64(frames*ch))
		if rmse > 350 || steadyMaxErr > 400 {
			t.Fatalf("ch=%d excessive ADPCM error rmse=%.1f steadyMax=%d", ch, rmse, steadyMaxErr)
		}
	}
}
