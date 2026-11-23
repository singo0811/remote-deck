//go:build !ohoslib

package main

import (
	"bufio"
	"encoding/json"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

type cmdRequest struct {
	Op          string `json:"op"`
	ReqID       string `json:"reqId"`
	StateDir    string `json:"stateDir"`
	Hostname    string `json:"hostname"`
	AuthKey     string `json:"authKey"`
	ForwardPort int    `json:"forwardPort"`
	TargetIP    string `json:"targetIp"`
	TargetPort  int    `json:"targetPort"`
}

type tunnelEvent struct {
	Type  string `json:"type"`
	ReqID string `json:"reqId"`
	Port  int    `json:"port"`
	Error string `json:"error,omitempty"`
}

type statusEvent struct {
	Type string `json:"type"`
	StatusSnapshot
}

var writeMu sync.Mutex

func emitJSON(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	writeMu.Lock()
	_, _ = os.Stdout.Write(append(b, '\n'))
	writeMu.Unlock()
}

func main() {
	mgr := NewManager(func(st StatusSnapshot) {
		emitJSON(statusEvent{
			Type:           "status",
			StatusSnapshot: st,
		})
	})

	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		mgr.Stop()
		os.Exit(0)
	}()

	emitJSON(statusEvent{
		Type:           "status",
		StatusSnapshot: mgr.Status(),
	})

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		var req cmdRequest
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			continue
		}
		switch req.Op {
		case "start":
			_ = mgr.Start(req.StateDir, req.Hostname, req.AuthKey, req.ForwardPort)
		case "stop":
			mgr.Stop()
		case "logout":
			_ = mgr.Logout()
		case "status":
			emitJSON(statusEvent{
				Type:           "status",
				StatusSnapshot: mgr.Status(),
			})
		case "openTunnel":
			port, err := mgr.OpenTunnel(req.TargetIP, req.TargetPort)
			errStr := ""
			if err != nil {
				errStr = err.Error()
			}
			emitJSON(tunnelEvent{
				Type:  "tunnel",
				ReqID: req.ReqID,
				Port:  port,
				Error: errStr,
			})
		}
	}

	mgr.Stop()
}
