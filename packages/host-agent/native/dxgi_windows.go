//go:build windows

package main

import (
	"fmt"
	"syscall"
	"time"
	"unsafe"
)

var (
	d3d11                 = syscall.NewLazyDLL("d3d11.dll")
	procD3D11CreateDevice = d3d11.NewProc("D3D11CreateDevice")
)

var (
	iidIDXGIDevice     = guid{0x54ec77fa, 0x1377, 0x44e6, [8]byte{0x8c, 0x32, 0x88, 0xfd, 0x5f, 0x44, 0xc8, 0x4c}}
	iidIDXGIAdapter    = guid{0x2411e7e1, 0x12ac, 0x4ccf, [8]byte{0xbd, 0x14, 0x97, 0x98, 0xe8, 0x53, 0x4d, 0xc0}}
	iidIDXGIOutput1    = guid{0x00cddea8, 0x939b, 0x4b83, [8]byte{0xa3, 0x40, 0xa6, 0x85, 0x22, 0x66, 0x66, 0xcc}}
	iidID3D11Texture2D = guid{0x6f15aaf2, 0xd208, 0x4e89, [8]byte{0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c}}
)

const (
	d3dDriverTypeHardware      = 1
	d3d11CreateDeviceBgra      = 0x20
	d3d11SdkVersion            = 7
	d3d11UsageStaging          = 3
	d3d11CpuAccessRead         = 0x20000
	d3d11MapRead               = 1
	dxgiErrorWaitTimeout       = 0x887A0027
	dxgiErrorAccessLost        = 0x887A0026
	dxgiErrorSessionDisconnect = 0x887A0028
)

type dxgiOutputDesc struct {
	DeviceName         [32]uint16
	DesktopCoordinates rect
	AttachedToDesktop  int32
	Rotation           uint32
	Monitor            uintptr
}

type dxgiSampleDesc struct {
	Count   uint32
	Quality uint32
}

type d3d11Texture2DDesc struct {
	Width          uint32
	Height         uint32
	MipLevels      uint32
	ArraySize      uint32
	Format         uint32
	SampleDesc     dxgiSampleDesc
	Usage          uint32
	BindFlags      uint32
	CPUAccessFlags uint32
	MiscFlags      uint32
}

type d3d11MappedSubresource struct {
	PData      uintptr
	RowPitch   uint32
	DepthPitch uint32
}

type dxgiCapturer struct {
	device       uintptr
	context      uintptr
	dupl         uintptr
	stagingTex   uintptr
	dispID       int
	srcW         int
	srcH         int
	cachedScaled []byte
	cachedOutW   int
	cachedOutH   int
	disabledTill time.Time
}

var dxgiState dxgiCapturer

func (d *dxgiCapturer) release() {
	if d.stagingTex != 0 {
		comRelease(d.stagingTex)
		d.stagingTex = 0
	}
	if d.dupl != 0 {
		comRelease(d.dupl)
		d.dupl = 0
	}
	if d.context != 0 {
		comRelease(d.context)
		d.context = 0
	}
	if d.device != 0 {
		comRelease(d.device)
		d.device = 0
	}
	d.srcW = 0
	d.srcH = 0
	d.cachedOutW = 0
	d.cachedOutH = 0
}

func (d *dxgiCapturer) ensureInit(disp displayInfo) error {
	if time.Now().Before(d.disabledTill) {
		return fmt.Errorf("dxgi cooldown")
	}
	if d.dupl != 0 && d.dispID == disp.ID && d.srcW == disp.Width && d.srcH == disp.Height {
		return nil
	}
	d.release()

	if err := procD3D11CreateDevice.Find(); err != nil {
		d.disabledTill = time.Now().Add(60 * time.Second)
		return err
	}

	var dev, ctx uintptr
	var featLevel uint32
	hr, _, _ := procD3D11CreateDevice.Call(
		0,
		d3dDriverTypeHardware,
		0,
		d3d11CreateDeviceBgra,
		0,
		0,
		d3d11SdkVersion,
		uintptr(unsafe.Pointer(&dev)),
		uintptr(unsafe.Pointer(&featLevel)),
		uintptr(unsafe.Pointer(&ctx)),
	)
	if int32(hr) < 0 || dev == 0 || ctx == 0 {
		d.disabledTill = time.Now().Add(10 * time.Second)
		return fmt.Errorf("D3D11CreateDevice hr=0x%x", uint32(hr))
	}

	var dxgiDev uintptr
	hr, _, _ = syscall.SyscallN(comMethod(dev, 0), dev, uintptr(unsafe.Pointer(&iidIDXGIDevice)), uintptr(unsafe.Pointer(&dxgiDev)))
	if int32(hr) < 0 || dxgiDev == 0 {
		comRelease(ctx)
		comRelease(dev)
		d.disabledTill = time.Now().Add(10 * time.Second)
		return fmt.Errorf("QI IDXGIDevice failed: 0x%x", uint32(hr))
	}

	var adapter uintptr
	hr, _, _ = syscall.SyscallN(comMethod(dxgiDev, 6), dxgiDev, uintptr(unsafe.Pointer(&iidIDXGIAdapter)), uintptr(unsafe.Pointer(&adapter))) // GetParent
	comRelease(dxgiDev)
	if int32(hr) < 0 || adapter == 0 {
		comRelease(ctx)
		comRelease(dev)
		d.disabledTill = time.Now().Add(10 * time.Second)
		return fmt.Errorf("GetParent IDXGIAdapter failed: 0x%x", uint32(hr))
	}

	var matchedOut1 uintptr
	for idx := uint32(0); idx < 16; idx++ {
		var outPtr uintptr
		hr, _, _ = syscall.SyscallN(comMethod(adapter, 7), adapter, uintptr(idx), uintptr(unsafe.Pointer(&outPtr))) // EnumOutputs
		if int32(hr) < 0 || outPtr == 0 {
			break
		}
		var desc dxgiOutputDesc
		hrDesc, _, _ := syscall.SyscallN(comMethod(outPtr, 7), outPtr, uintptr(unsafe.Pointer(&desc))) // GetDesc
		if int32(hrDesc) >= 0 && desc.AttachedToDesktop != 0 {
			if int(desc.DesktopCoordinates.Left) == disp.Left && int(desc.DesktopCoordinates.Top) == disp.Top &&
				int(desc.DesktopCoordinates.Right-desc.DesktopCoordinates.Left) == disp.Width &&
				int(desc.DesktopCoordinates.Bottom-desc.DesktopCoordinates.Top) == disp.Height {
				var out1 uintptr
				hrQ, _, _ := syscall.SyscallN(comMethod(outPtr, 0), outPtr, uintptr(unsafe.Pointer(&iidIDXGIOutput1)), uintptr(unsafe.Pointer(&out1)))
				comRelease(outPtr)
				if int32(hrQ) >= 0 && out1 != 0 {
					matchedOut1 = out1
				}
				break
			}
		}
		comRelease(outPtr)
	}
	comRelease(adapter)

	if matchedOut1 == 0 {
		comRelease(ctx)
		comRelease(dev)
		d.disabledTill = time.Now().Add(5 * time.Second)
		return fmt.Errorf("no matching DXGI output for display %d", disp.ID)
	}

	var dupl uintptr
	hr, _, _ = syscall.SyscallN(comMethod(matchedOut1, 22), matchedOut1, dev, uintptr(unsafe.Pointer(&dupl))) // DuplicateOutput
	comRelease(matchedOut1)
	if int32(hr) < 0 || dupl == 0 {
		comRelease(ctx)
		comRelease(dev)
		d.disabledTill = time.Now().Add(5 * time.Second)
		return fmt.Errorf("DuplicateOutput failed: 0x%x", uint32(hr))
	}

	d.device = dev
	d.context = ctx
	d.dupl = dupl
	d.dispID = disp.ID
	d.srcW = disp.Width
	d.srcH = disp.Height
	d.cachedOutW = 0
	d.cachedOutH = 0
	return nil
}

func (d *dxgiCapturer) ensureStaging(srcTex uintptr) error {
	if d.stagingTex != 0 {
		return nil
	}
	var desc d3d11Texture2DDesc
	syscall.SyscallN(comMethod(srcTex, 10), srcTex, uintptr(unsafe.Pointer(&desc))) // GetDesc
	desc.Usage = d3d11UsageStaging
	desc.BindFlags = 0
	desc.CPUAccessFlags = d3d11CpuAccessRead
	desc.MiscFlags = 0
	desc.MipLevels = 1
	desc.ArraySize = 1
	desc.SampleDesc = dxgiSampleDesc{Count: 1, Quality: 0}

	var staging uintptr
	hr, _, _ := syscall.SyscallN(comMethod(d.device, 5), d.device, uintptr(unsafe.Pointer(&desc)), 0, uintptr(unsafe.Pointer(&staging))) // CreateTexture2D
	if int32(hr) < 0 || staging == 0 {
		return fmt.Errorf("CreateTexture2D staging failed: 0x%x", uint32(hr))
	}
	d.stagingTex = staging
	return nil
}

// captureToBuffer tries DXGI Desktop Duplication and copies the scaled desktop BGRA into dst.
// Returns (usedDxgi=true, desktopChanged=bool, err).
func (d *dxgiCapturer) captureToBuffer(disp displayInfo, dst []byte, outW, outH int) (bool, bool, error) {
	if err := d.ensureInit(disp); err != nil {
		return false, false, err
	}

	var frameInfo [128]byte
	var res uintptr
	// Bounded wait: 0 would block until the desktop changes, which stalls the
	// capture loop (100ms+ gaps => visible stutter). 10ms keeps frames on budget;
	// on timeout we reuse the cached frame and report "unchanged".
	hr, _, _ := syscall.SyscallN(
		comMethod(d.dupl, 8), // AcquireNextFrame
		d.dupl,
		10,
		uintptr(unsafe.Pointer(&frameInfo[0])),
		uintptr(unsafe.Pointer(&res)),
	)

	if uint32(hr) == dxgiErrorWaitTimeout {
		need := outW * outH * 4
		if d.cachedOutW == outW && d.cachedOutH == outH && len(d.cachedScaled) == need {
			copy(dst, d.cachedScaled)
			return true, false, nil
		}
		// Scale mismatch or first frame hasn't arrived yet -> fallback to GDI once so first frame never stalls
		return false, false, fmt.Errorf("dxgi wait timeout before first frame")
	}

	if int32(hr) < 0 || res == 0 {
		u := uint32(hr)
		if u == dxgiErrorAccessLost || u == dxgiErrorSessionDisconnect {
			d.release()
			d.disabledTill = time.Now().Add(2 * time.Second)
		} else {
			d.release()
			d.disabledTill = time.Now().Add(5 * time.Second)
		}
		return false, false, fmt.Errorf("AcquireNextFrame failed: 0x%x", u)
	}

	var tex uintptr
	hrQ, _, _ := syscall.SyscallN(comMethod(res, 0), res, uintptr(unsafe.Pointer(&iidID3D11Texture2D)), uintptr(unsafe.Pointer(&tex)))
	comRelease(res)
	if int32(hrQ) < 0 || tex == 0 {
		syscall.SyscallN(comMethod(d.dupl, 14), d.dupl) // ReleaseFrame
		return false, false, fmt.Errorf("QI ID3D11Texture2D failed: 0x%x", uint32(hrQ))
	}

	if err := d.ensureStaging(tex); err != nil {
		comRelease(tex)
		syscall.SyscallN(comMethod(d.dupl, 14), d.dupl)
		d.release()
		return false, false, err
	}

	syscall.SyscallN(comMethod(d.context, 47), d.context, d.stagingTex, tex) // CopyResource
	comRelease(tex)
	syscall.SyscallN(comMethod(d.dupl, 14), d.dupl) // ReleaseFrame

	var mapped d3d11MappedSubresource
	hrMap, _, _ := syscall.SyscallN(comMethod(d.context, 14), d.context, d.stagingTex, 0, d3d11MapRead, 0, uintptr(unsafe.Pointer(&mapped)))
	if int32(hrMap) < 0 || mapped.PData == 0 {
		return false, false, fmt.Errorf("Map staging failed: 0x%x", uint32(hrMap))
	}

	need := outW * outH * 4
	if cap(d.cachedScaled) < need {
		d.cachedScaled = make([]byte, need)
	}
	d.cachedScaled = d.cachedScaled[:need]
	srcSlice := unsafe.Slice((*byte)(unsafe.Pointer(mapped.PData)), int(mapped.RowPitch)*d.srcH)
	bgraScaleCopy(srcSlice, int(mapped.RowPitch), d.srcW, d.srcH, d.cachedScaled, outW, outH)
	syscall.SyscallN(comMethod(d.context, 15), d.context, d.stagingTex, 0) // Unmap

	d.cachedOutW = outW
	d.cachedOutH = outH
	copy(dst, d.cachedScaled)
	return true, true, nil
}

func bgraScaleCopy(src []byte, srcPitch, srcW, srcH int, dst []byte, dstW, dstH int) {
	dstStride := dstW * 4
	if srcW == dstW && srcH == dstH {
		for y := 0; y < dstH; y++ {
			sOff := y * srcPitch
			dOff := y * dstStride
			copy(dst[dOff:dOff+dstStride], src[sOff:sOff+dstStride])
		}
		return
	}
	// Fixed-point 16.16 nearest/box sampling for fast CPU downscale
	stepX := (srcW << 16) / dstW
	stepY := (srcH << 16) / dstH
	for y := 0; y < dstH; y++ {
		sy := (y * stepY) >> 16
		if sy >= srcH {
			sy = srcH - 1
		}
		sRow := sy * srcPitch
		dRow := y * dstStride
		sxAcc := 0
		for x := 0; x < dstW; x++ {
			sx := sxAcc >> 16
			if sx >= srcW {
				sx = srcW - 1
			}
			si := sRow + sx*4
			di := dRow + x*4
			dst[di+0] = src[si+0]
			dst[di+1] = src[si+1]
			dst[di+2] = src[si+2]
			dst[di+3] = 255
			sxAcc += stepX
		}
	}
}
