package main

import "encoding/binary"

var imaIndexTable = [16]int{
	-1, -1, -1, -1, 2, 4, 6, 8,
	-1, -1, -1, -1, 2, 4, 6, 8,
}

var imaStepTable = [89]int{
	7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
	19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
	50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
	130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
	337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
	876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
	2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
	5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
	15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
}

type imaState struct {
	pred  int
	index int
}

func (s *imaState) encodeSample(sample int) byte {
	step := imaStepTable[s.index]
	diff := sample - s.pred
	nibble := 0
	if diff < 0 {
		nibble = 8
		diff = -diff
	}
	delta := step >> 3
	if diff >= step {
		nibble |= 4
		diff -= step
		delta += step
	}
	step >>= 1
	if diff >= step {
		nibble |= 2
		diff -= step
		delta += step
	}
	step >>= 1
	if diff >= step {
		nibble |= 1
		delta += step
	}
	if (nibble & 8) != 0 {
		s.pred -= delta
	} else {
		s.pred += delta
	}
	if s.pred > 32767 {
		s.pred = 32767
	} else if s.pred < -32768 {
		s.pred = -32768
	}
	s.index += imaIndexTable[nibble]
	if s.index < 0 {
		s.index = 0
	} else if s.index > 88 {
		s.index = 88
	}
	return byte(nibble & 0x0f)
}

func (s *imaState) decodeNibble(nibble byte) int16 {
	step := imaStepTable[s.index]
	delta := step >> 3
	if (nibble & 4) != 0 {
		delta += step
	}
	if (nibble & 2) != 0 {
		delta += step >> 1
	}
	if (nibble & 1) != 0 {
		delta += step >> 2
	}
	if (nibble & 8) != 0 {
		s.pred -= delta
	} else {
		s.pred += delta
	}
	if s.pred > 32767 {
		s.pred = 32767
	} else if s.pred < -32768 {
		s.pred = -32768
	}
	s.index += imaIndexTable[nibble&0x0f]
	if s.index < 0 {
		s.index = 0
	} else if s.index > 88 {
		s.index = 88
	}
	return int16(s.pred)
}

// encodeImaAdpcm compresses 16-bit LE PCM frames into a compact 4:1 IMA-ADPCM payload.
// Header per channel (4 bytes): [int16 pred0][uint8 index=0][uint8 0]
// Stereo body: 1 byte per remaining frame -> low nibble L, high nibble R.
// Mono body: 2 remaining samples per byte -> low nibble even, high nibble odd.
func encodeImaAdpcm(pcm []byte, channels int) ([]byte, int) {
	if channels != 1 {
		channels = 2
	}
	frameBytes := channels * 2
	frames := len(pcm) / frameBytes
	if frames <= 0 {
		return nil, 0
	}

	hdrBytes := channels * 4
	var bodyBytes int
	if channels == 2 {
		bodyBytes = frames - 1
	} else {
		bodyBytes = (frames) / 2
	}

	out := make([]byte, hdrBytes+bodyBytes)
	var st [2]imaState
	for ch := 0; ch < channels; ch++ {
		s0 := int(int16(binary.LittleEndian.Uint16(pcm[ch*2 : ch*2+2])))
		st[ch] = imaState{pred: s0, index: 0}
		off := ch * 4
		binary.LittleEndian.PutUint16(out[off:off+2], uint16(int16(s0)))
		out[off+2] = 0
		out[off+3] = 0
	}

	if channels == 2 {
		for f := 1; f < frames; f++ {
			off := f * 4
			sL := int(int16(binary.LittleEndian.Uint16(pcm[off : off+2])))
			sR := int(int16(binary.LittleEndian.Uint16(pcm[off+2 : off+4])))
			nL := st[0].encodeSample(sL)
			nR := st[1].encodeSample(sR)
			out[hdrBytes+f-1] = (nL & 0x0f) | ((nR & 0x0f) << 4)
		}
	} else {
		byteIdx := 0
		for f := 1; f < frames; f += 2 {
			s0 := int(int16(binary.LittleEndian.Uint16(pcm[f*2 : f*2+2])))
			n0 := st[0].encodeSample(s0)
			var n1 byte
			if f+1 < frames {
				s1 := int(int16(binary.LittleEndian.Uint16(pcm[(f+1)*2 : (f+1)*2+2])))
				n1 = st[0].encodeSample(s1)
			}
			out[hdrBytes+byteIdx] = (n0 & 0x0f) | ((n1 & 0x0f) << 4)
			byteIdx++
		}
	}

	return out, frames
}

func decodeImaAdpcm(data []byte, channels, frames int) []byte {
	if channels != 1 {
		channels = 2
	}
	hdrBytes := channels * 4
	if frames <= 0 || len(data) < hdrBytes {
		return nil
	}
	out := make([]byte, frames*channels*2)
	var st [2]imaState
	for ch := 0; ch < channels; ch++ {
		off := ch * 4
		p := int(int16(binary.LittleEndian.Uint16(data[off : off+2])))
		idx := int(data[off+2])
		if idx < 0 {
			idx = 0
		} else if idx > 88 {
			idx = 88
		}
		st[ch] = imaState{pred: p, index: idx}
		binary.LittleEndian.PutUint16(out[ch*2:ch*2+2], uint16(int16(p)))
	}
	if channels == 2 {
		for f := 1; f < frames && hdrBytes+f-1 < len(data); f++ {
			b := data[hdrBytes+f-1]
			sL := st[0].decodeNibble(b & 0x0f)
			sR := st[1].decodeNibble((b >> 4) & 0x0f)
			off := f * 4
			binary.LittleEndian.PutUint16(out[off:off+2], uint16(sL))
			binary.LittleEndian.PutUint16(out[off+2:off+4], uint16(sR))
		}
	} else {
		f := 1
		for i := hdrBytes; i < len(data) && f < frames; i++ {
			b := data[i]
			s0 := st[0].decodeNibble(b & 0x0f)
			binary.LittleEndian.PutUint16(out[f*2:f*2+2], uint16(s0))
			f++
			if f < frames {
				s1 := st[0].decodeNibble((b >> 4) & 0x0f)
				binary.LittleEndian.PutUint16(out[f*2:f*2+2], uint16(s1))
				f++
			}
		}
	}
	return out
}
