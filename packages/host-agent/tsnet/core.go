package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

func init() {
	installSandboxDnsFallback()
}

// HarmonyOS app sandboxes (and minimal Linux containers) often lack /etc/resolv.conf,
// which causes Go's pure resolver to try 127.0.0.1:53 and fail DNS lookups.
func installSandboxDnsFallback() {
	if runtime.GOOS != "linux" {
		return
	}
	if f, err := os.Open("/etc/resolv.conf"); err == nil {
		_ = f.Close()
		return
	}
	dnsServers := []string{"223.5.5.5:53", "119.29.29.29:53", "8.8.8.8:53"}
	net.DefaultResolver = &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, _network, _address string) (net.Conn, error) {
			d := net.Dialer{Timeout: 4 * time.Second}
			var lastErr error
			for _, srv := range dnsServers {
				conn, err := d.DialContext(ctx, "udp", srv)
				if err == nil {
					return conn, nil
				}
				lastErr = err
			}
			return nil, lastErr
		},
	}
}

var authURLRe = regexp.MustCompile(`https://\S+`)

type PeerInfo struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	IP      string `json:"ip"`
	OS      string `json:"os"`
	Online  bool   `json:"online"`
	CurAddr string `json:"curAddr,omitempty"`
	Relay   string `json:"relay,omitempty"`
}

type StatusSnapshot struct {
	Enabled     bool       `json:"enabled"`
	State       string     `json:"state"`
	TailscaleIP string     `json:"tailscaleIp"`
	Hostname    string     `json:"hostname"`
	AuthURL     string     `json:"authUrl"`
	LastError   string     `json:"lastError"`
	Peers       []PeerInfo `json:"peers"`
	Logs        []string   `json:"logs,omitempty"`
}

type tunnelEntry struct {
	ln   net.Listener
	port int
}

type Manager struct {
	mu          sync.Mutex
	srv         *tsnet.Server
	cancel      context.CancelFunc
	enabled     bool
	stateDir    string
	hostname    string
	forwardPort int
	state       string
	tailscaleIP string
	authURL     string
	lastError   string
	peers       []PeerInfo
	tunnels     map[string]tunnelEntry
	recentLogs  []string
	onChange    func(StatusSnapshot)
}

func (m *Manager) appendLog(source, msg string) {
	msg = strings.TrimSpace(msg)
	if msg == "" {
		return
	}
	line := fmt.Sprintf("[%s] %s", source, msg)
	m.mu.Lock()
	m.recentLogs = append(m.recentLogs, line)
	if len(m.recentLogs) > 15 {
		m.recentLogs = m.recentLogs[len(m.recentLogs)-15:]
	}
	stateDir := m.stateDir
	lower := strings.ToLower(msg)
	if m.state != "Running" && m.authURL == "" &&
		(strings.Contains(lower, "error") || strings.Contains(lower, "err:") ||
			strings.Contains(lower, "fail") || strings.Contains(lower, "denied") ||
			strings.Contains(lower, "timeout") || strings.Contains(lower, "timed out") ||
			strings.Contains(lower, "refused") || strings.Contains(lower, "x509") ||
			strings.Contains(lower, "unreachable")) {
		m.lastError = formatFriendlyTsnetError(msg)
	}
	m.mu.Unlock()
	if stateDir != "" {
		if f, err := os.OpenFile(filepath.Join(stateDir, "logs", "tsnet-debug.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
			_, _ = fmt.Fprintf(f, "%s %s\n", time.Now().Format("15:04:05.000"), line)
			_ = f.Close()
		}
	}
}

func NewManager(onChange func(StatusSnapshot)) *Manager {
	return &Manager{
		state:    "Stopped",
		peers:    []PeerInfo{},
		tunnels:  make(map[string]tunnelEntry),
		onChange: onChange,
	}
}

func (m *Manager) snapshotLocked() StatusSnapshot {
	peersCopy := make([]PeerInfo, len(m.peers))
	copy(peersCopy, m.peers)
	logsCopy := make([]string, len(m.recentLogs))
	copy(logsCopy, m.recentLogs)
	return StatusSnapshot{
		Enabled:     m.enabled,
		State:       m.state,
		TailscaleIP: m.tailscaleIP,
		Hostname:    m.hostname,
		AuthURL:     m.authURL,
		LastError:   m.lastError,
		Peers:       peersCopy,
		Logs:        logsCopy,
	}
}

func (m *Manager) Status() StatusSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snapshotLocked()
}

func (m *Manager) emitChange() {
	if m.onChange != nil {
		m.onChange(m.Status())
	}
}

func (m *Manager) Start(stateDir, hostname, authKey string, forwardPort int) error {
	m.mu.Lock()
	if m.srv != nil && m.enabled && m.stateDir == stateDir && m.hostname == hostname && m.forwardPort == forwardPort {
		m.mu.Unlock()
		return nil
	}
	m.stopLocked()

	if stateDir == "" {
		m.mu.Unlock()
		return errors.New("stateDir is required")
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		m.lastError = err.Error()
		m.state = "Error"
		m.mu.Unlock()
		m.emitChange()
		return err
	}
	ensureSandboxDirs(stateDir)
	if hostname == "" {
		hostname = "remotedeck"
	}

	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.enabled = true
	m.stateDir = stateDir
	m.hostname = hostname
	m.forwardPort = forwardPort
	m.state = "Starting"
	m.tailscaleIP = ""
	m.authURL = ""
	m.lastError = ""
	m.peers = []PeerInfo{}

	srv := &tsnet.Server{
		Dir:      stateDir,
		Hostname: hostname,
		AuthKey:  strings.TrimSpace(authKey),
		UserLogf: func(format string, args ...any) {
			msg := fmt.Sprintf(format, args...)
			m.appendLog("user", msg)
			if u := authURLRe.FindString(msg); u != "" {
				m.mu.Lock()
				changed := m.authURL != u
				m.authURL = u
				m.lastError = ""
				if m.state == "Starting" || m.state == "" {
					m.state = "NeedsLogin"
				}
				m.mu.Unlock()
				if changed {
					m.emitChange()
				}
			}
		},
		Logf: func(format string, args ...any) {
			m.appendLog("tsnet", fmt.Sprintf(format, args...))
		},
	}
	m.srv = srv
	m.mu.Unlock()
	m.emitChange()

	go m.runLifecycle(ctx, srv, forwardPort)
	return nil
}

func formatFriendlyTsnetError(msg string) string {
	if strings.Contains(msg, "198.18.") && (strings.Contains(msg, "timeout") || strings.Contains(msg, "timed out")) {
		return "检测到系统 VPN/Fake-IP (198.18.x.x) 阻断了 Tailscale 握手，请关闭或重连系统 VPN 后重试（" + msg + "）"
	}
	return msg
}

func ensureSandboxDirs(stateDir string) {
	logsDir := filepath.Join(stateDir, "logs")
	_ = os.MkdirAll(logsDir, 0o700)
	if os.Getenv("TS_LOGS_DIR") == "" {
		_ = os.Setenv("TS_LOGS_DIR", logsDir)
	}
	if runtime.GOOS == "windows" {
		return
	}
	tmpDir := filepath.Join(stateDir, "tmp")
	cacheDir := filepath.Join(stateDir, "cache")
	_ = os.MkdirAll(tmpDir, 0o700)
	_ = os.MkdirAll(cacheDir, 0o700)
	if os.Getenv("TMPDIR") == "" {
		_ = os.Setenv("TMPDIR", tmpDir)
	}
	if os.Getenv("HOME") == "" {
		_ = os.Setenv("HOME", stateDir)
	}
	if os.Getenv("XDG_CACHE_HOME") == "" {
		_ = os.Setenv("XDG_CACHE_HOME", cacheDir)
	}
	if os.Getenv("XDG_CONFIG_HOME") == "" {
		_ = os.Setenv("XDG_CONFIG_HOME", stateDir)
	}
}

func (m *Manager) runLifecycle(ctx context.Context, srv *tsnet.Server, forwardPort int) {
	defer func() {
		if r := recover(); r != nil {
			m.mu.Lock()
			if m.srv == srv {
				m.lastError = fmt.Sprintf("tsnet panic: %v\n%s", r, strings.TrimSpace(string(debug.Stack())))
				m.state = "Error"
			}
			m.mu.Unlock()
			m.emitChange()
		}
	}()
	if err := srv.Start(); err != nil {
		m.mu.Lock()
		if m.srv == srv {
			m.lastError = err.Error()
			m.state = "Error"
		}
		m.mu.Unlock()
		m.emitChange()
		return
	}

	lc, err := srv.LocalClient()
	if err != nil {
		m.mu.Lock()
		if m.srv == srv {
			m.lastError = err.Error()
			m.state = "Error"
		}
		m.mu.Unlock()
		m.emitChange()
		return
	}

	go func() {
		watcher, err := lc.WatchIPNBus(ctx, ipn.NotifyInitialState)
		if err != nil {
			return
		}
		defer watcher.Close()
		for {
			n, err := watcher.Next()
			if err != nil {
				return
			}
			dirty := false
			m.mu.Lock()
			if m.srv != srv {
				m.mu.Unlock()
				return
			}
			if n.BrowseToURL != nil && *n.BrowseToURL != "" && m.authURL != *n.BrowseToURL {
				m.authURL = *n.BrowseToURL
				m.lastError = ""
				dirty = true
			}
			if n.State != nil {
				nextState := n.State.String()
				if m.state != nextState {
					m.state = nextState
					if *n.State == ipn.Running {
						m.authURL = ""
						m.lastError = ""
					}
					dirty = true
				}
			}
			if n.ErrMessage != nil && *n.ErrMessage != "" && m.lastError != *n.ErrMessage {
				m.lastError = *n.ErrMessage
				dirty = true
			}
			m.mu.Unlock()
			if dirty {
				m.emitChange()
				m.refreshStatus(ctx, srv, lc)
			}
		}
	}()

	if forwardPort > 0 {
		go m.runForwarder(ctx, srv, forwardPort)
	}

	ticker := time.NewTicker(4 * time.Second)
	defer ticker.Stop()
	m.refreshStatus(ctx, srv, lc)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.refreshStatus(ctx, srv, lc)
		}
	}
}

func (m *Manager) refreshStatus(ctx context.Context, srv *tsnet.Server, lc *local.Client) {
	qctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	st, err := lc.Status(qctx)
	if err != nil || st == nil {
		return
	}

	var tsIP string
	for _, addr := range st.TailscaleIPs {
		if addr.Is4() {
			tsIP = addr.String()
			break
		}
	}
	if tsIP == "" && len(st.TailscaleIPs) > 0 {
		tsIP = st.TailscaleIPs[0].String()
	}

	var peers []PeerInfo
	for _, ps := range st.Peer {
		if ps == nil {
			continue
		}
		var peerIP string
		for _, addr := range ps.TailscaleIPs {
			if addr.Is4() {
				peerIP = addr.String()
				break
			}
		}
		if peerIP == "" && len(ps.TailscaleIPs) > 0 {
			peerIP = ps.TailscaleIPs[0].String()
		}
		if peerIP == "" {
			continue
		}
		name := ps.HostName
		if name == "" && ps.DNSName != "" {
			name = strings.Split(ps.DNSName, ".")[0]
		}
		peers = append(peers, PeerInfo{
			ID:      string(ps.ID),
			Name:    name,
			IP:      peerIP,
			OS:      ps.OS,
			Online:  ps.Online,
			CurAddr: ps.CurAddr,
			Relay:   ps.Relay,
		})
	}
	sort.Slice(peers, func(i, j int) bool {
		if peers[i].Online != peers[j].Online {
			return peers[i].Online
		}
		return peers[i].Name < peers[j].Name
	})

	m.mu.Lock()
	if m.srv != srv {
		m.mu.Unlock()
		return
	}
	changed := false
	if st.BackendState != "" && m.state != st.BackendState {
		m.state = st.BackendState
		changed = true
	}
	if tsIP != "" && m.tailscaleIP != tsIP {
		m.tailscaleIP = tsIP
		changed = true
	}
	if st.AuthURL != "" && m.authURL != st.AuthURL {
		m.authURL = st.AuthURL
		changed = true
	}
	if st.BackendState == "Running" && m.authURL != "" {
		m.authURL = ""
		m.lastError = ""
		changed = true
	} else if st.BackendState != "Running" && m.authURL == "" && len(st.Health) > 0 {
		healthMsg := formatFriendlyTsnetError(strings.Join(st.Health, "; "))
		if m.lastError != healthMsg {
			m.lastError = healthMsg
			changed = true
		}
	}
	if !peersEqual(m.peers, peers) {
		m.peers = peers
		changed = true
	}
	m.mu.Unlock()

	if changed {
		m.emitChange()
	}
}

func peersEqual(a, b []PeerInfo) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (m *Manager) runForwarder(ctx context.Context, srv *tsnet.Server, targetPort int) {
	ln, err := srv.Listen("tcp", fmt.Sprintf(":%d", targetPort))
	if err != nil {
		m.mu.Lock()
		if m.srv == srv {
			m.lastError = fmt.Sprintf("listen :%d: %v", targetPort, err)
		}
		m.mu.Unlock()
		m.emitChange()
		return
	}
	defer ln.Close()

	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()

	localTarget := net.JoinHostPort("127.0.0.1", strconv.Itoa(targetPort))
	for {
		rc, err := ln.Accept()
		if err != nil {
			return
		}
		go func(remoteConn net.Conn) {
			defer remoteConn.Close()
			lc, err := net.DialTimeout("tcp", localTarget, 3*time.Second)
			if err != nil {
				return
			}
			defer lc.Close()
			proxyBiDir(remoteConn, lc)
		}(rc)
	}
}

// OpenTunnel creates or reuses a local loopback TCP forwarder (127.0.0.1:<port>)
// that tunnels connections through tsnet.Dial to targetIP:targetPort.
func (m *Manager) OpenTunnel(targetIP string, targetPort int) (int, error) {
	m.mu.Lock()
	srv := m.srv
	if srv == nil || !m.enabled {
		m.mu.Unlock()
		return 0, errors.New("tsnet not running")
	}
	key := net.JoinHostPort(targetIP, strconv.Itoa(targetPort))
	if existing, ok := m.tunnels[key]; ok {
		m.mu.Unlock()
		return existing.port, nil
	}
	m.mu.Unlock()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	tcpAddr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		_ = ln.Close()
		return 0, errors.New("unexpected listener address")
	}
	port := tcpAddr.Port

	m.mu.Lock()
	if m.srv != srv || !m.enabled {
		m.mu.Unlock()
		_ = ln.Close()
		return 0, errors.New("tsnet closed")
	}
	if existing, ok := m.tunnels[key]; ok {
		m.mu.Unlock()
		_ = ln.Close()
		return existing.port, nil
	}
	m.tunnels[key] = tunnelEntry{ln: ln, port: port}
	m.mu.Unlock()

	go func() {
		defer ln.Close()
		for {
			localConn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				dctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
				defer cancel()
				remoteConn, err := srv.Dial(dctx, "tcp", key)
				if err != nil {
					return
				}
				defer remoteConn.Close()
				proxyBiDir(c, remoteConn)
			}(localConn)
		}
	}()

	return port, nil
}

func (m *Manager) CloseAllTunnels() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closeTunnelsLocked()
}

func (m *Manager) closeTunnelsLocked() {
	for k, entry := range m.tunnels {
		_ = entry.ln.Close()
		delete(m.tunnels, k)
	}
}

func (m *Manager) Logout() error {
	m.mu.Lock()
	srv := m.srv
	m.mu.Unlock()
	if srv != nil {
		if lc, err := srv.LocalClient(); err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = lc.Logout(ctx)
			cancel()
		}
	}
	m.Stop()
	return nil
}

func (m *Manager) Stop() {
	m.mu.Lock()
	m.stopLocked()
	m.mu.Unlock()
	m.emitChange()
}

func (m *Manager) stopLocked() {
	m.closeTunnelsLocked()
	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
	}
	if m.srv != nil {
		_ = m.srv.Close()
		m.srv = nil
	}
	m.enabled = false
	m.state = "Stopped"
	m.tailscaleIP = ""
	m.authURL = ""
	m.peers = []PeerInfo{}
}

func proxyBiDir(a, b net.Conn) {
	done := make(chan struct{}, 2)
	cp := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		done <- struct{}{}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
}
