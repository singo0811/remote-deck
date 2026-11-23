package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

var (
	libopusOnce sync.Once
	libopusOK   bool
)

func opusEncoderAvailable() bool {
	libopusOnce.Do(func() {
		if _, err := exec.LookPath("ffmpeg"); err != nil {
			return
		}
		out, err := exec.Command("ffmpeg", "-hide_banner", "-encoders").Output()
		if err != nil {
			return
		}
		libopusOK = strings.Contains(string(out), "libopus")
	})
	return libopusOK
}

type opusPipe struct {
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	mu       sync.Mutex
	closed   bool
	doneCh   chan struct{}
	opusHead []byte
}

func startOpusEncoder(sampleRate, channels, bitrateKbps int, onPacket func(pkt []byte, head []byte)) (*opusPipe, error) {
	if !opusEncoderAvailable() {
		return nil, fmt.Errorf("ffmpeg libopus not available")
	}
	if sampleRate <= 0 {
		sampleRate = 48000
	}
	if channels != 1 {
		channels = 2
	}
	if bitrateKbps <= 0 {
		bitrateKbps = 64
	}

	args := []string{
		"-hide_banner", "-loglevel", "error",
		"-f", "s16le",
		"-ar", fmt.Sprintf("%d", sampleRate),
		"-ac", fmt.Sprintf("%d", channels),
		"-i", "pipe:0",
		"-c:a", "libopus",
		"-application", "lowdelay",
		"-frame_duration", "20",
		"-b:a", fmt.Sprintf("%dk", bitrateKbps),
		"-page_duration", "20000",
		"-flush_packets", "1",
		"-f", "ogg",
		"pipe:1",
	}

	cmd := exec.Command("ffmpeg", args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return nil, err
	}

	p := &opusPipe{
		cmd:    cmd,
		stdin:  stdin,
		doneCh: make(chan struct{}),
	}

	go func() {
		defer close(p.doneCh)
		p.readOggStream(stdout, onPacket)
		_ = cmd.Wait()
	}()

	return p, nil
}

func (p *opusPipe) readOggStream(r io.Reader, onPacket func(pkt []byte, head []byte)) {
	br := bufio.NewReaderSize(r, 16384)
	var curPkt []byte
	var head []byte

	for {
		var hdr [27]byte
		if _, err := io.ReadFull(br, hdr[:]); err != nil {
			return
		}
		if string(hdr[0:4]) != "OggS" {
			// Resync to next OggS capture pattern if needed.
			b, err := br.ReadByte()
			if err != nil {
				return
			}
			_ = b
			continue
		}
		nSegs := int(hdr[26])
		segTable := make([]byte, nSegs)
		if nSegs > 0 {
			if _, err := io.ReadFull(br, segTable); err != nil {
				return
			}
		}
		bodyLen := 0
		for _, s := range segTable {
			bodyLen += int(s)
		}
		body := make([]byte, bodyLen)
		if bodyLen > 0 {
			if _, err := io.ReadFull(br, body); err != nil {
				return
			}
		}

		// Reassemble packets across Ogg segments.
		off := 0
		for _, segLenByte := range segTable {
			segLen := int(segLenByte)
			if off+segLen > len(body) {
				break
			}
			curPkt = append(curPkt, body[off:off+segLen]...)
			off += segLen
			if segLen < 255 {
				pkt := curPkt
				curPkt = nil
				if len(pkt) >= 8 && bytes.Equal(pkt[:8], []byte("OpusHead")) {
					head = append([]byte(nil), pkt...)
					p.mu.Lock()
					p.opusHead = head
					p.mu.Unlock()
				} else if len(pkt) >= 8 && bytes.Equal(pkt[:8], []byte("OpusTags")) {
					// Skip Vorbis comment header.
				} else if len(pkt) > 0 && onPacket != nil {
					onPacket(pkt, head)
				}
			}
		}
	}
}

func (p *opusPipe) WritePCM(pcm []byte) error {
	p.mu.Lock()
	if p.closed || p.stdin == nil {
		p.mu.Unlock()
		return fmt.Errorf("opus encoder closed")
	}
	stdin := p.stdin
	p.mu.Unlock()
	_, err := stdin.Write(pcm)
	return err
}

func (p *opusPipe) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	stdin := p.stdin
	p.stdin = nil
	p.mu.Unlock()

	if stdin != nil {
		_ = stdin.Close()
	}
	select {
	case <-p.doneCh:
	case <-time.After(500 * time.Millisecond):
		if p.cmd != nil && p.cmd.Process != nil {
			_ = p.cmd.Process.Kill()
		}
		<-p.doneCh
	}
}

// buildOpusHead constructs a standard 19-byte RFC 7845 OpusHead packet.
func buildOpusHead(channels int, origSampleRate int) []byte {
	if channels < 1 || channels > 2 {
		channels = 2
	}
	if origSampleRate <= 0 {
		origSampleRate = 48000
	}
	head := make([]byte, 19)
	copy(head[0:8], "OpusHead")
	head[8] = 1
	head[9] = byte(channels)
	binary.LittleEndian.PutUint16(head[10:12], 312) // standard 6.5ms pre-skip
	binary.LittleEndian.PutUint32(head[12:16], uint32(origSampleRate))
	binary.LittleEndian.PutUint16(head[16:18], 0)
	head[18] = 0
	return head
}
