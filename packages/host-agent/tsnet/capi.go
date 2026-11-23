//go:build ohoslib

package main

/*
#include <stdlib.h>
*/
import "C"
import (
	"encoding/json"
	"errors"
	"net"
	"net/netip"
	"os"
	"time"
	"unsafe"

	_ "golang.org/x/crypto/x509roots/fallback"
	"tailscale.com/net/netmon"
	"tailscale.com/net/netns"
)

func init() {
	// Embedded tsnet uses userspace gVisor netstack without a kernel TUN,
	// so Linux SO_MARK / SO_BINDTODEVICE fwmark overrides break HarmonyOS netd routing.
	netns.SetEnabled(false)
	if os.Getenv("SSL_CERT_FILE") == "" {
		if f, err := os.Open("/etc/ssl/certs/cacert.pem"); err == nil {
			_ = f.Close()
			_ = os.Setenv("SSL_CERT_FILE", "/etc/ssl/certs/cacert.pem")
		}
	}
	netmon.RegisterInterfaceGetter(ohosGetInterfaces)
}

// HarmonyOS app sandboxes deny AF_NETLINK (NETLINK_ROUTE), causing net.Interfaces()
// to fail with "route ip+net: netlinkrib: permission denied". Fall back to UDP
// route probing (no packets sent) when net.Interfaces() is blocked.
func ohosGetInterfaces() ([]netmon.Interface, error) {
	if ifs, err := net.Interfaces(); err == nil {
		ret := make([]netmon.Interface, len(ifs))
		for i := range ifs {
			ret[i].Interface = &ifs[i]
		}
		return ret, nil
	}

	var addrs []net.Addr
	seen := make(map[netip.Addr]bool)
	addOutbound := func(network string, targets []string, maskBits int) {
		for _, target := range targets {
			d := net.Dialer{Timeout: 2 * time.Second}
			c, err := d.Dial(network, target)
			if err != nil {
				continue
			}
			ua, ok := c.LocalAddr().(*net.UDPAddr)
			_ = c.Close()
			if !ok {
				continue
			}
			ip, ok := netip.AddrFromSlice(ua.IP)
			if !ok {
				continue
			}
			ip = ip.Unmap()
			if ip.IsLoopback() || ip.IsUnspecified() || seen[ip] {
				continue
			}
			seen[ip] = true
			bits := 32
			if ip.Is6() {
				bits = 128
			}
			_ = maskBits
			addrs = append(addrs, &net.IPNet{IP: ip.AsSlice(), Mask: net.CIDRMask(bits, bits)})
		}
	}

	addOutbound("udp4", []string{"223.5.5.5:53", "8.8.8.8:53", "192.168.1.1:53", "10.0.0.1:53"}, 32)
	addOutbound("udp6", []string{"[2400:3200::1]:53", "[2001:4860:4860::8888]:53"}, 128)
	if len(addrs) == 0 {
		return nil, errors.New("ohos: no outbound interface addresses discovered")
	}
	return []netmon.Interface{{
		Interface: &net.Interface{
			Index: 1,
			MTU:   1500,
			Name:  "ohos0",
			Flags: net.FlagUp | net.FlagRunning | net.FlagMulticast,
		},
		AltAddrs: addrs,
	}}, nil
}

var ohosMgr = NewManager(nil)

type capiResult struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

func toCJSON(v any) *C.char {
	b, err := json.Marshal(v)
	if err != nil {
		return C.CString(`{"ok":false,"error":"marshal failed"}`)
	}
	return C.CString(string(b))
}

//export TsnetStart
func TsnetStart(stateDir *C.char, hostname *C.char, authKey *C.char) *C.char {
	err := ohosMgr.Start(C.GoString(stateDir), C.GoString(hostname), C.GoString(authKey), 9603)
	if err != nil {
		return toCJSON(capiResult{OK: false, Error: err.Error()})
	}
	return toCJSON(capiResult{OK: true})
}

//export TsnetStop
func TsnetStop() *C.char {
	ohosMgr.Stop()
	return toCJSON(capiResult{OK: true})
}

//export TsnetLogout
func TsnetLogout() *C.char {
	_ = ohosMgr.Logout()
	return toCJSON(capiResult{OK: true})
}

//export TsnetGetStatus
func TsnetGetStatus() *C.char {
	return toCJSON(ohosMgr.Status())
}

//export TsnetOpenTunnel
func TsnetOpenTunnel(targetIP *C.char, targetPort C.int) C.int {
	port, err := ohosMgr.OpenTunnel(C.GoString(targetIP), int(targetPort))
	if err != nil {
		return 0
	}
	return C.int(port)
}

//export TsnetCloseAllTunnels
func TsnetCloseAllTunnels() {
	ohosMgr.CloseAllTunnels()
}

//export TsnetFreeString
func TsnetFreeString(s *C.char) {
	if s != nil {
		C.free(unsafe.Pointer(s))
	}
}

func main() {}
