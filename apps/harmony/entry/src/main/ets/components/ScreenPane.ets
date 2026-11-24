import tsnetBridge from 'libremotedeck_ts.so';
import { image } from '@kit.ImageKit';
import { KeyCode } from '@kit.InputKit';
import { CursorShapeInfo, QUICK_HOTKEYS, QuickHotkey, ScreenFrameMeta, VideoFrameMeta } from '../protocol/Protocol';
import { RemoteClient } from '../protocol/RemoteClient';

function harmonyKeyToVk(code: number): number {
  if (code >= KeyCode.KEYCODE_A && code <= KeyCode.KEYCODE_Z) {
    return 65 + (code - KeyCode.KEYCODE_A);
  }
  if (code >= KeyCode.KEYCODE_0 && code <= KeyCode.KEYCODE_9) {
    return 48 + (code - KeyCode.KEYCODE_0);
  }
  if (code >= KeyCode.KEYCODE_F1 && code <= KeyCode.KEYCODE_F12) {
    return 0x70 + (code - KeyCode.KEYCODE_F1);
  }
  switch (code) {
    case KeyCode.KEYCODE_ENTER:
      return 0x0d;
    case KeyCode.KEYCODE_ESCAPE:
      return 0x1b;
    case KeyCode.KEYCODE_DEL:
      return 0x08;
    case KeyCode.KEYCODE_FORWARD_DEL:
      return 0x2e;
    case KeyCode.KEYCODE_TAB:
      return 0x09;
    case KeyCode.KEYCODE_SPACE:
      return 0x20;
    case KeyCode.KEYCODE_DPAD_LEFT:
      return 0x25;
    case KeyCode.KEYCODE_DPAD_UP:
      return 0x26;
    case KeyCode.KEYCODE_DPAD_RIGHT:
      return 0x27;
    case KeyCode.KEYCODE_DPAD_DOWN:
      return 0x28;
    case KeyCode.KEYCODE_MOVE_HOME:
      return 0x24;
    case KeyCode.KEYCODE_MOVE_END:
      return 0x23;
    case KeyCode.KEYCODE_PAGE_UP:
      return 0x21;
    case KeyCode.KEYCODE_PAGE_DOWN:
      return 0x22;
    case KeyCode.KEYCODE_CTRL_LEFT:
    case KeyCode.KEYCODE_CTRL_RIGHT:
      return 0x11;
    case KeyCode.KEYCODE_ALT_LEFT:
    case KeyCode.KEYCODE_ALT_RIGHT:
      return 0x12;
    case KeyCode.KEYCODE_SHIFT_LEFT:
    case KeyCode.KEYCODE_SHIFT_RIGHT:
      return 0x10;
    case KeyCode.KEYCODE_META_LEFT:
    case KeyCode.KEYCODE_META_RIGHT:
      return 0x5b;
    case KeyCode.KEYCODE_MINUS:
      return 0xbd;
    case KeyCode.KEYCODE_EQUALS:
      return 0xbb;
    case KeyCode.KEYCODE_LEFT_BRACKET:
      return 0xdb;
    case KeyCode.KEYCODE_RIGHT_BRACKET:
      return 0xdd;
    case KeyCode.KEYCODE_BACKSLASH:
      return 0xdc;
    case KeyCode.KEYCODE_SEMICOLON:
      return 0xba;
    case KeyCode.KEYCODE_APOSTROPHE:
      return 0xde;
    case KeyCode.KEYCODE_COMMA:
      return 0xbc;
    case KeyCode.KEYCODE_PERIOD:
      return 0xbe;
    case KeyCode.KEYCODE_SLASH:
      return 0xbf;
    case KeyCode.KEYCODE_GRAVE:
      return 0xc0;
    default:
      return 0;
  }
}

interface ImageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface BufferedVideoFrame {
  data: ArrayBuffer;
  meta: VideoFrameMeta;
}

@Component
export struct ScreenPane {
  @Prop tier: string = 'phone';
  @Prop isLandscape: boolean = false;
  @Prop compactChrome: boolean = false;
  @Prop frameAspect: number = 16 / 9;
  @Prop videoActive: boolean = false;
  @Link @Watch('onPixelMapTick') pixelMap: image.PixelMap | null;
  @Link frameMeta: ScreenFrameMeta | null;
  @State canvasReady: boolean = false;
  private canvasSettings: RenderingContextSettings = new RenderingContextSettings(true);
  private canvasCtx: CanvasRenderingContext2D = new CanvasRenderingContext2D(this.canvasSettings);
  private hasFullBaseline: boolean = false;
  private lastDrawRectKey: string = '';
  private directPixelMap: image.PixelMap | null = null;
  private directFrameMeta: ScreenFrameMeta | null = null;
  private xCompController: XComponentController = new XComponentController();
  private xCompSurfaceId: string = '';
  private xCompVideoW: number = 0;
  private xCompVideoH: number = 0;
  private bufferedVideoFrame: BufferedVideoFrame | null = null;
  @State videoRoiX: number = 0;
  @State videoRoiY: number = 0;
  @State videoRoiW: number = 0;
  @State videoRoiH: number = 0;
  private roiSyncTimer: number = -1;
  private roiRequested: boolean = false;
  private lastRoiSentKey: string = '';
  @Prop @Watch('onRemoteCursor') cursorX: number = 0.5;
  @Prop @Watch('onRemoteCursor') cursorY: number = 0.5;
  @Prop cursorShape: CursorShapeInfo | null = null;
  @Prop canControl: boolean = true;
  @Prop audioEnabled: boolean = false;
  client: RemoteClient | null = null;
  onExitImmersive: () => void = () => {};
  onToggleAudio: () => void = () => {};
  onDisconnect: () => void = () => {};
  onZoomLevel: (z: number) => void = () => {};

  @State touchMode: string = 'direct'; // 'direct' | 'trackpad'
  @State dragLock: boolean = false;
  @State showGuide: boolean = false;
  @State orbMenuOpen: boolean = false;
  @State localCursorX: number = 0.5;
  @State localCursorY: number = 0.5;
  @State @Watch('onZoomTick') zoom: number = 1;
  @State @Watch('onPanTick') panX: number = 0;
  @State @Watch('onPanTick') panY: number = 0;
  @State rippleVisible: boolean = false;
  @State rippleX: number = 0;
  @State rippleY: number = 0;
  @State rippleColor: string = '#38BDF8';

  @State showVirtualKeys: boolean = false;
  @State showTextBridge: boolean = false;
  @State textInput: string = '';
  @State ctrlSticky: boolean = false;
  @State altSticky: boolean = false;
  @State shiftSticky: boolean = false;
  @State metaSticky: boolean = false;

  @State areaWidth: number = 1;
  @State areaHeight: number = 1;

  private touchPhase: string = 'idle'; // 'idle' | 'one' | 'two' | 'ignore'
  private downX: number = 0;
  private downY: number = 0;
  private lastX: number = 0;
  private lastY: number = 0;
  private downAt: number = 0;
  private moved: boolean = false;
  private longFired: boolean = false;
  private activeDrag: boolean = false;
  private dragStartButtonDown: boolean = false;
  private scrollAccumY: number = 0;
  private scrollVelocityY: number = 0;
  private scrollMoved: boolean = false;
  private wheelPending: number = 0;
  private wheelTimer: number = -1;
  private momentumTimer: number = -1;

  private lastTapAt: number = 0;
  private lastTapX: number = 0;
  private lastTapY: number = 0;
  private longTimer: number = -1;
  private rippleTimer: number = -1;

  private pinchStartDist: number = 1;
  private pinchLastDist: number = 1;
  private pinchLastMx: number = 0;
  private pinchLastMy: number = 0;
  private pinchStartAt: number = 0;
  private pinchMoved: boolean = false;
  private pinchWheelAccum: number = 0;

  private lastMoveSentMs: number = 0;
  private lastLocalCursorMs: number = 0;

  private attachedClient: RemoteClient | null = null;

  private ensureDirectListener(): void {
    if (this.client && this.attachedClient !== this.client) {
      this.attachedClient?.setDirectFrameListener(null);
      this.attachedClient?.setVideoFrameListener(null);
      this.attachedClient = this.client;
      this.client.setDirectFrameListener((pm: image.PixelMap, meta: ScreenFrameMeta) => {
        this.directPixelMap = pm;
        this.directFrameMeta = meta;
        if (this.canvasReady) {
          this.drawFrame(pm, meta);
        }
      });
      this.client.setVideoFrameListener((data: ArrayBuffer, meta: VideoFrameMeta) => {
        this.handleVideoFrame(data, meta);
      });
    }
  }

  private handleVideoFrame(data: ArrayBuffer, meta: VideoFrameMeta): void {
    if (meta.key) {
      this.bufferedVideoFrame = { data, meta };
    }
    if (
      Math.abs(meta.roiX - this.videoRoiX) > 0.002 ||
      Math.abs(meta.roiY - this.videoRoiY) > 0.002 ||
      Math.abs(meta.roiW - this.videoRoiW) > 0.002 ||
      Math.abs(meta.roiH - this.videoRoiH) > 0.002
    ) {
      this.videoRoiX = meta.roiX;
      this.videoRoiY = meta.roiY;
      this.videoRoiW = meta.roiW;
      this.videoRoiH = meta.roiH;
    }
    if (this.xCompSurfaceId.length === 0) {
      return;
    }
    if (this.xCompVideoW === 0 && meta.width > 0 && meta.height > 0) {
      const ok = tsnetBridge.videoInit(this.xCompSurfaceId, meta.width, meta.height);
      if (!ok) {
        this.client?.setCodec('jpeg');
        return;
      }
      this.xCompVideoW = meta.width;
      this.xCompVideoH = meta.height;
    }
    const ptsUs = meta.ts > 0 ? Math.round(meta.ts) : Date.now() * 1000;
    const rc = tsnetBridge.videoPush(data, ptsUs, meta.key, meta.width, meta.height);
    if (rc === 0) {
      this.client?.setCodec('jpeg');
    } else if (rc === 2) {
      this.client?.requestKeyFrame();
    } else if (meta.width > 0 && meta.height > 0) {
      this.xCompVideoW = meta.width;
      this.xCompVideoH = meta.height;
    }
  }

  aboutToAppear(): void {
    this.touchMode = 'direct';
    this.localCursorX = this.cursorX;
    this.localCursorY = this.cursorY;
    this.ensureDirectListener();
  }

  aboutToDisappear(): void {
    this.attachedClient?.setDirectFrameListener(null);
    this.attachedClient?.setVideoFrameListener(null);
    this.attachedClient = null;
    this.directPixelMap = null;
    this.directFrameMeta = null;
    this.bufferedVideoFrame = null;
    this.xCompSurfaceId = '';
    this.xCompVideoW = 0;
    this.xCompVideoH = 0;
    this.videoRoiX = 0;
    this.videoRoiY = 0;
    this.videoRoiW = 0;
    this.videoRoiH = 0;
    if (this.roiSyncTimer !== -1) {
      clearTimeout(this.roiSyncTimer);
      this.roiSyncTimer = -1;
    }
    if (this.roiRequested) {
      this.roiRequested = false;
      this.lastRoiSentKey = '';
      this.client?.clearRoi();
    }
    tsnetBridge.videoDestroy();
    this.clearLongTimer();
    if (this.rippleTimer >= 0) {
      clearTimeout(this.rippleTimer);
      this.rippleTimer = -1;
    }
  }

  onRemoteCursor(): void {
    if (Date.now() - this.lastLocalCursorMs > 350) {
      this.localCursorX = this.cursorX;
      this.localCursorY = this.cursorY;
    }
  }

  onZoomTick(): void {
    // Only a real zoom change needs to reach the parent; panning used to run
    // this too, re-rendering the whole pane (and the video surface) per touch
    // move, which showed up as jitter while dragging the zoomed view sideways.
    this.onZoomLevel(this.zoom);
    this.scheduleZoomRoiUpdate();
  }

  onPanTick(): void {
    this.scheduleZoomRoiUpdate();
  }

  /** Viewport (what the user can see) expressed in full-desktop normalized coords. */
  private visibleNormalizedRect(): ImageRect {
    const tl = this.localToNormalized(0, 0);
    const br = this.localToNormalized(this.areaWidth, this.areaHeight);
    return { x: tl.x, y: tl.y, w: Math.max(0.01, br.x - tl.x), h: Math.max(0.01, br.y - tl.y) };
  }

  /** True when the current ROI still covers the viewport with some slack. */
  private roiCoversViewport(): boolean {
    if (!this.roiRequested || this.videoRoiW <= 0.01 || this.videoRoiH <= 0.01) return false;
    const vis = this.visibleNormalizedRect();
    const slack = 0.015;
    return (
      vis.x >= this.videoRoiX + slack &&
      vis.y >= this.videoRoiY + slack &&
      vis.x + vis.w <= this.videoRoiX + this.videoRoiW - slack &&
      vis.y + vis.h <= this.videoRoiY + this.videoRoiH - slack
    );
  }

  private scheduleZoomRoiUpdate(): void {
    if (!this.client) return;
    if (this.zoom <= 1.6) {
      if (this.roiSyncTimer !== -1) {
        clearTimeout(this.roiSyncTimer);
        this.roiSyncTimer = -1;
      }
      if (this.roiRequested) {
        this.roiRequested = false;
        this.lastRoiSentKey = '';
        this.client.clearRoi();
      }
      return;
    }
    if (this.zoom <= 2.2) return;
    if (this.roiSyncTimer !== -1) {
      clearTimeout(this.roiSyncTimer);
    }
    // Moving the ROI makes the host emit a fresh keyframe, so only re-cut it when
    // panning actually leaves the region we already stream (edge-triggered)
    // instead of once per settle.
    const settleMs = this.roiRequested ? 320 : 140;
    this.roiSyncTimer = setTimeout(() => {
      this.roiSyncTimer = -1;
      if (this.zoom <= 2.2 || !this.client || this.areaWidth <= 10 || this.areaHeight <= 10) return;
      if (this.roiCoversViewport()) return;
      const vis = this.visibleNormalizedRect();
      const pad = 0.14;
      const snap = (v: number): number => Math.round(v * 25) / 25;
      const rx = Math.max(0, Math.min(0.8, snap(vis.x - pad)));
      const ry = Math.max(0, Math.min(0.8, snap(vis.y - pad)));
      const rw = Math.max(0.2, Math.min(1 - rx, snap(vis.w + pad * 2)));
      const rh = Math.max(0.2, Math.min(1 - ry, snap(vis.h + pad * 2)));
      const key = `${rx.toFixed(2)}:${ry.toFixed(2)}:${rw.toFixed(2)}:${rh.toFixed(2)}`;
      if (key === this.lastRoiSentKey) return;
      this.lastRoiSentKey = key;
      this.roiRequested = true;
      this.client.setRoi(rx, ry, rw, rh);
    }, settleMs);
  }

  /** Coalesce drag distance into smooth sub-notch wheel deltas. */
  private queueWheel(dyPx: number): void {
    this.wheelPending += dyPx;
    if (this.wheelTimer !== -1) return;
    this.wheelTimer = setTimeout(() => {
      this.wheelTimer = -1;
      const px = this.wheelPending;
      this.wheelPending = 0;
      let delta = Math.round(px * 3);
      if (delta > 240) {
        delta = 240;
      }
      if (delta < -240) {
        delta = -240;
      }
      if (delta !== 0) {
        this.client?.sendMouseWheel(delta);
      }
    }, 12);
  }

  private startMomentum(v: number): void {
    if (this.momentumTimer !== -1) {
      clearTimeout(this.momentumTimer);
      this.momentumTimer = -1;
    }
    if (Math.abs(v) < 0.25) return;
    this.momentumTimer = setTimeout(() => {
      this.momentumStep(v);
    }, 16);
  }

  private momentumStep(v: number): void {
    const next = v * 0.82;
    if (Math.abs(next) < 0.06) {
      this.momentumTimer = -1;
      return;
    }
    this.queueWheel(next * 16);
    this.momentumTimer = setTimeout(() => {
      this.momentumStep(next);
    }, 16);
  }

  private clearLongTimer(): void {
    if (this.longTimer >= 0) {
      clearTimeout(this.longTimer);
      this.longTimer = -1;
    }
  }

  private showRipple(sx: number, sy: number, color: string): void {
    this.rippleX = sx - 16;
    this.rippleY = sy - 16;
    this.rippleColor = color;
    this.rippleVisible = true;
    if (this.rippleTimer >= 0) {
      clearTimeout(this.rippleTimer);
    }
    this.rippleTimer = setTimeout(() => {
      this.rippleVisible = false;
      this.rippleTimer = -1;
    }, 240);
  }

  private clampNorm(v: number): number {
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }

  onPixelMapTick(): void {
    this.ensureDirectListener();
    if (this.pixelMap === null) {
      this.canvasReady = false;
      this.hasFullBaseline = false;
      this.lastDrawRectKey = '';
      this.directPixelMap = null;
      this.directFrameMeta = null;
      return;
    }
    this.directPixelMap = this.pixelMap;
    this.directFrameMeta = this.frameMeta;
    if (this.canvasReady) {
      this.drawFrame(this.pixelMap, this.frameMeta);
    }
  }

  /**
   * Draw a full frame or a dirty patch 1:1 into the letterboxed image rect.
   * Zoom and pan are applied purely by the wrapper Stacks (never in canvasCtx),
   * so panning never leaves trails and never causes flicker.
   */
  private drawFrame(pm: image.PixelMap, meta: ScreenFrameMeta | null): void {
    const rect = this.getRenderedImageRect();
    const frameW = meta !== null && meta.width > 0 ? meta.width : rect.w;
    const frameH = meta !== null && meta.height > 0 ? meta.height : rect.h;
    const kx = frameW > 0 ? rect.w / frameW : 1;
    const ky = frameH > 0 ? rect.h / frameH : kx;
    if (meta !== null && meta.hasDirty && !this.hasFullBaseline) {
      this.client?.refreshFullFrame();
      return;
    }
    this.canvasCtx.setTransform(1, 0, 0, 1, 0, 0);
    if (meta !== null && meta.hasDirty) {
      this.canvasCtx.drawImage(
        pm,
        rect.x + meta.dirtyX * kx,
        rect.y + meta.dirtyY * ky,
        meta.dirtyW * kx,
        meta.dirtyH * ky
      );
      return;
    }
    const rectKey = `${rect.x.toFixed(1)},${rect.y.toFixed(1)},${rect.w.toFixed(1)},${rect.h.toFixed(1)}`;
    if (rectKey !== this.lastDrawRectKey) {
      this.canvasCtx.clearRect(0, 0, this.areaWidth + 4, this.areaHeight + 4);
      this.lastDrawRectKey = rectKey;
    }
    this.hasFullBaseline = true;
    this.canvasCtx.drawImage(pm, rect.x, rect.y, rect.w, rect.h);
  }

  private getRenderedImageRect(): ImageRect {
    const aspect = this.frameAspect > 0 ? this.frameAspect : 16 / 9;
    const aw = Math.max(1, this.areaWidth);
    const ah = Math.max(1, this.areaHeight);
    if (aw / ah > aspect) {
      const h = ah;
      const w = h * aspect;
      return { x: (aw - w) / 2, y: 0, w, h };
    }
    const w = aw;
    const h = w / aspect;
    return { x: 0, y: (ah - h) / 2, w, h };
  }

  private cursorPosX(): number {
    const rect = this.getRenderedImageRect();
    return Math.max(0, rect.x + this.localCursorX * rect.w - 6);
  }

  private cursorPosY(): number {
    const rect = this.getRenderedImageRect();
    return Math.max(0, rect.y + this.localCursorY * rect.h - 6);
  }

  private cursorImagePosX(shape: CursorShapeInfo): number {
    const rect = this.getRenderedImageRect();
    return rect.x + this.localCursorX * rect.w - shape.hx * 0.75;
  }

  private cursorImagePosY(shape: CursorShapeInfo): number {
    const rect = this.getRenderedImageRect();
    return rect.y + this.localCursorY * rect.h - shape.hy * 0.75;
  }

  private cursorScreenX(): number {
    const rect = this.getRenderedImageRect();
    const ux = rect.x + this.localCursorX * rect.w;
    const cx = this.areaWidth / 2;
    return cx + (ux - cx) * this.zoom + this.panX;
  }

  private cursorScreenY(): number {
    const rect = this.getRenderedImageRect();
    const uy = rect.y + this.localCursorY * rect.h;
    const cy = this.areaHeight / 2;
    return cy + (uy - cy) * this.zoom + this.panY;
  }

  private applyClampedPan(rawX: number, rawY: number, z: number): void {
    if (z <= 1.02) {
      this.panX = 0;
      this.panY = 0;
      return;
    }
    const rect = this.getRenderedImageRect();
    const maxX = Math.max(0, (rect.w * z - this.areaWidth) / 2 + 28);
    const maxY = Math.max(0, (rect.h * z - this.areaHeight) / 2 + 28);
    this.panX = Math.max(-maxX, Math.min(maxX, rawX));
    this.panY = Math.max(-maxY, Math.min(maxY, rawY));
  }

  private localToNormalized(lx: number, ly: number): ImageRect {
    // onTouch lives on the untransformed outer Stack, so invert the wrapper
    // Stacks' center-pivot scale and screen-pixel translation directly:
    // screen = center + (ux - center) * zoom + pan
    const z = Math.max(1, this.zoom);
    const cx = this.areaWidth / 2;
    const cy = this.areaHeight / 2;
    const ux = cx + (lx - cx - this.panX) / z;
    const uy = cy + (ly - cy - this.panY) / z;
    const rect = this.getRenderedImageRect();
    const nx = this.clampNorm((ux - rect.x) / Math.max(1, rect.w));
    const ny = this.clampNorm((uy - rect.y) / Math.max(1, rect.h));
    return { x: nx, y: ny, w: rect.w, h: rect.h };
  }

  private handleTouch(ev: TouchEvent): void {
    // While keyboard-direct mode is on, tapping the remote screen should not
    // dismiss the soft keyboard mid-typing.
    if (this.showTextBridge && ev.type === TouchType.Down) {
      this.focusImeBox();
    }
    const active: TouchObject[] = [];
    for (let i = 0; i < ev.touches.length; i++) {
      const t = ev.touches[i];
      if (t.type !== TouchType.Up && t.type !== TouchType.Cancel) {
        active.push(t);
      }
    }

    if (active.length >= 2) {
      this.clearLongTimer();
      if (this.dragStartButtonDown && this.canControl && this.client) {
        this.client.sendMouse('up', this.localCursorX, this.localCursorY, 'left');
      }
      this.activeDrag = false;
      this.dragStartButtonDown = false;

      const a = active[0];
      const b = active[1];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;

      if (this.touchPhase !== 'two') {
        this.touchPhase = 'two';
        this.pinchStartDist = Math.max(10, dist);
        this.pinchLastDist = Math.max(10, dist);
        this.pinchLastMx = mx;
        this.pinchLastMy = my;
        this.pinchStartAt = Date.now();
        this.pinchMoved = false;
        this.pinchWheelAccum = 0;
        return;
      }

      const dMx = mx - this.pinchLastMx;
      const dMy = my - this.pinchLastMy;
      if (Math.abs(dist - this.pinchStartDist) > 10 || Math.hypot(dMx, dMy) > 3) {
        this.pinchMoved = true;
      }

      const prevZoom = Math.max(1, this.zoom);
      const ratio = dist / Math.max(10, this.pinchLastDist);
      const nextZoomRaw = Math.max(1, Math.min(3.5, prevZoom * ratio));
      const nextZoom = Number(nextZoomRaw.toFixed(2));

      if (Math.abs(dist - this.pinchStartDist) > 10 || prevZoom > 1.02) {
        const cx = this.areaWidth / 2;
        const cy = this.areaHeight / 2;
        const ux = cx + (this.pinchLastMx - this.panX - cx) / prevZoom;
        const uy = cy + (this.pinchLastMy - this.panY - cy) / prevZoom;
        const nextPanX = mx - cx - (ux - cx) * nextZoom;
        const nextPanY = my - cy - (uy - cy) * nextZoom;
        this.zoom = nextZoom;
        this.applyClampedPan(nextPanX, nextPanY, nextZoom);
      } else {
        this.pinchWheelAccum += dMy;
        if (this.canControl && this.client) {
          this.queueWheel(dMy);
        }
      }

      this.pinchLastDist = Math.max(10, dist);
      this.pinchLastMx = mx;
      this.pinchLastMy = my;
      return;
    }

    if (active.length === 1) {
      const t = active[0];
      if (this.touchPhase === 'two') {
        // One finger lifted after 2-finger pinch/tap; ignore remaining finger until released
        if (!this.pinchMoved && Date.now() - this.pinchStartAt < 320 && this.canControl && this.client) {
          if (this.touchMode === 'direct') {
            const pt = this.localToNormalized(this.pinchLastMx, this.pinchLastMy);
            this.client.sendMouse('click', pt.x, pt.y, 'right');
            this.showRipple(this.pinchLastMx, this.pinchLastMy, '#A78BFA');
          } else {
            this.client.sendMouse('click', this.localCursorX, this.localCursorY, 'right');
            this.showRipple(this.cursorScreenX(), this.cursorScreenY(), '#A78BFA');
          }
          this.pinchMoved = true;
        }
        this.touchPhase = 'ignore';
        return;
      }

      if (this.touchPhase === 'ignore') {
        return;
      }

      if (ev.type === TouchType.Down || this.touchPhase === 'idle') {
        const now = Date.now();
        this.touchPhase = 'one';
        this.downX = t.x;
        this.downY = t.y;
        this.lastX = t.x;
        this.lastY = t.y;
        this.downAt = now;
        this.moved = false;
        this.longFired = false;
        this.scrollAccumY = 0;

        const isDoubleTapHold =
          now - this.lastTapAt < 300 && Math.hypot(t.x - this.lastTapX, t.y - this.lastTapY) < 32;
        this.activeDrag = this.dragLock || (this.touchMode === 'trackpad' && isDoubleTapHold);
        this.dragStartButtonDown = false;

        this.clearLongTimer();
        if (!this.activeDrag && this.canControl && this.client) {
          this.longTimer = setTimeout(() => {
            if (this.touchPhase !== 'one' || this.moved || !this.canControl || !this.client) return;
            this.longFired = true;
            if (this.touchMode === 'direct') {
              const pt = this.localToNormalized(this.downX, this.downY);
              this.localCursorX = pt.x;
              this.localCursorY = pt.y;
              this.lastLocalCursorMs = Date.now();
              this.client.sendMouse('click', pt.x, pt.y, 'right');
              this.showRipple(this.downX, this.downY, '#A78BFA');
            } else {
              this.client.sendMouse('click', this.localCursorX, this.localCursorY, 'right');
              this.showRipple(this.cursorScreenX(), this.cursorScreenY(), '#A78BFA');
            }
          }, 420);
        }
        return;
      }

      if (ev.type === TouchType.Move) {
        const dx = t.x - this.lastX;
        const dy = t.y - this.lastY;
        this.lastX = t.x;
        this.lastY = t.y;

        if (!this.moved && Math.hypot(t.x - this.downX, t.y - this.downY) > 8) {
          this.moved = true;
          this.clearLongTimer();
          if (this.activeDrag && !this.dragStartButtonDown && this.canControl && this.client) {
            this.dragStartButtonDown = true;
            if (this.touchMode === 'direct') {
              const pt = this.localToNormalized(this.downX, this.downY);
              this.localCursorX = pt.x;
              this.localCursorY = pt.y;
              this.lastLocalCursorMs = Date.now();
              this.client.sendMouse('down', pt.x, pt.y, 'left');
            } else {
              this.client.sendMouse('down', this.localCursorX, this.localCursorY, 'left');
            }
          }
        }

        if (!this.moved || !this.canControl || !this.client) return;

        if (this.dragStartButtonDown) {
          const now = Date.now();
          if (this.touchMode === 'direct') {
            const pt = this.localToNormalized(t.x, t.y);
            this.localCursorX = pt.x;
            this.localCursorY = pt.y;
            this.lastLocalCursorMs = now;
            if (now - this.lastMoveSentMs >= 16) {
              this.lastMoveSentMs = now;
              this.client.sendMouse('move', pt.x, pt.y);
            }
          } else {
            const rect = this.getRenderedImageRect();
            const z = Math.max(1, this.zoom);
            this.localCursorX = this.clampNorm(this.localCursorX + (dx / Math.max(200, rect.w * z)) * 1.15);
            this.localCursorY = this.clampNorm(this.localCursorY + (dy / Math.max(160, rect.h * z)) * 1.15);
            this.lastLocalCursorMs = now;
            if (now - this.lastMoveSentMs >= 16) {
              this.lastMoveSentMs = now;
              this.client.sendMouse('move', this.localCursorX, this.localCursorY);
            }
          }
          return;
        }

        if (this.touchMode === 'direct') {
          if (this.zoom > 1.04) {
            this.applyClampedPan(this.panX + dx, this.panY + dy, this.zoom);
          } else {
            this.queueWheel(dy);
            this.scrollVelocityY = this.scrollVelocityY * 0.6 + (dy / 16) * 0.4;
            this.scrollMoved = true;
          }
        } else {
          const rect = this.getRenderedImageRect();
          const z = Math.max(1, this.zoom);
          const now = Date.now();
          this.localCursorX = this.clampNorm(this.localCursorX + (dx / Math.max(200, rect.w * z)) * 1.2);
          this.localCursorY = this.clampNorm(this.localCursorY + (dy / Math.max(160, rect.h * z)) * 1.2);
          this.lastLocalCursorMs = now;
          if (now - this.lastMoveSentMs >= 16) {
            this.lastMoveSentMs = now;
            this.client.sendMouse('move', this.localCursorX, this.localCursorY);
          }
        }
      }
      return;
    }

    // All fingers lifted (active.length === 0)
    this.clearLongTimer();
    if (this.dragStartButtonDown && this.canControl && this.client) {
      this.client.sendMouse('up', this.localCursorX, this.localCursorY, 'left');
      this.dragStartButtonDown = false;
      this.activeDrag = false;
      if (this.dragLock) {
        this.dragLock = false;
      }
      this.touchPhase = 'idle';
      return;
    }
    this.activeDrag = false;

    if (this.touchPhase === 'two') {
      if (!this.pinchMoved && Date.now() - this.pinchStartAt < 320 && this.canControl && this.client) {
        if (this.touchMode === 'direct') {
          const pt = this.localToNormalized(this.pinchLastMx, this.pinchLastMy);
          this.client.sendMouse('click', pt.x, pt.y, 'right');
          this.showRipple(this.pinchLastMx, this.pinchLastMy, '#A78BFA');
        } else {
          this.client.sendMouse('click', this.localCursorX, this.localCursorY, 'right');
          this.showRipple(this.cursorScreenX(), this.cursorScreenY(), '#A78BFA');
        }
      }
      this.touchPhase = 'idle';
      return;
    }

    if (ev.type === TouchType.Up || ev.type === TouchType.Cancel) {
      // Flick to scroll: continue with decaying wheel deltas like a native list.
      if (this.scrollMoved && this.touchPhase === 'one') {
        this.scrollMoved = false;
        this.startMomentum(this.scrollVelocityY);
      }
    }

    if (this.touchPhase === 'one' && !this.moved && !this.longFired && ev.type === TouchType.Up) {
      if (this.canControl && this.client) {
        const now = Date.now();
        if (this.touchMode === 'direct') {
          const pt = this.localToNormalized(this.downX, this.downY);
          this.localCursorX = pt.x;
          this.localCursorY = pt.y;
          this.lastLocalCursorMs = now;
          this.client.sendMouse('click', pt.x, pt.y, 'left');
          this.showRipple(this.downX, this.downY, '#38BDF8');
        } else {
          this.lastLocalCursorMs = now;
          this.client.sendMouse('click', this.localCursorX, this.localCursorY, 'left');
          this.showRipple(this.cursorScreenX(), this.cursorScreenY(), '#38BDF8');
        }
        this.lastTapAt = now;
        this.lastTapX = this.downX;
        this.lastTapY = this.downY;
      }
    }

    this.touchPhase = 'idle';
  }

  private fireHotkey(vk: number, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean): void {
    if (!this.canControl || !this.client) return;
    this.client.sendHotkey(
      vk,
      ctrl || this.ctrlSticky,
      alt || this.altSticky,
      shift || this.shiftSticky,
      meta || this.metaSticky
    );
    this.ctrlSticky = false;
    this.altSticky = false;
    this.shiftSticky = false;
    this.metaSticky = false;
  }

  private submitText(): void {
    if (!this.canControl || !this.client) return;
    // Enter on the soft keyboard becomes a real Enter keypress on the host.
    this.client.sendKey('tap', 0x0d);
    this.textInput = '';
  }

  /** IME-committed text (pre-edit / pinyin candidate阶段不会触发) -> 直接注入远端 */
  private forwardInsert(value: string): void {
    if (!this.canControl || !this.client || value.length === 0) return;
    this.client.sendText(value);
  }

  private forwardDelete(info: DeleteValue): void {
    if (!this.canControl || !this.client) return;
    if (info.direction === TextDeleteDirection.FORWARD) {
      this.client.sendKey('tap', 0x2e); // VK_DELETE
    } else {
      this.client.sendKey('tap', 0x08); // VK_BACK
    }
  }

  /** Raise the soft keyboard straight away so typing needs no extra tap. */
  private focusImeBox(): void {
    if (!this.showTextBridge) {
      this.showTextBridge = true;
    }
    setTimeout(() => {
      try {
        this.getUIContext().getFocusController().requestFocus('rd-ime-box');
      } catch {
        // Focus controller unavailable on older runtimes; user can tap the box.
      }
    }, 60);
  }

  build() {
    Column() {
      Stack({ alignContent: Alignment.Center }) {
        Stack({ alignContent: Alignment.Center }) {
          Stack({ alignContent: Alignment.Center }) {
            if (this.videoActive) {
              XComponent({
                id: 'rd-video-xcomp',
                type: XComponentType.SURFACE,
                controller: this.xCompController,
              })
                .width((this.videoRoiW > 0.01 ? this.videoRoiW : 1) * this.getRenderedImageRect().w)
                .height((this.videoRoiH > 0.01 ? this.videoRoiH : 1) * this.getRenderedImageRect().h)
                .offset({
                  x: this.videoRoiW > 0.01
                    ? (this.videoRoiX + this.videoRoiW * 0.5 - 0.5) * this.getRenderedImageRect().w
                    : 0,
                  y: this.videoRoiH > 0.01
                    ? (this.videoRoiY + this.videoRoiH * 0.5 - 0.5) * this.getRenderedImageRect().h
                    : 0,
                })
                .onLoad(() => {
                  this.xCompSurfaceId = this.xCompController.getXComponentSurfaceId();
                  this.xCompVideoW = 0;
                  this.xCompVideoH = 0;
                  if (this.bufferedVideoFrame !== null) {
                    const bf = this.bufferedVideoFrame;
                    this.handleVideoFrame(bf.data, bf.meta);
                  }
                })
                .onDestroy(() => {
                  this.xCompSurfaceId = '';
                  this.xCompVideoW = 0;
                  this.xCompVideoH = 0;
                  tsnetBridge.videoDestroy();
                })
                .hitTestBehavior(HitTestMode.None)
            } else if (this.pixelMap !== null) {
              // Canvas-based compositing: dirty-rect frames are drawn as patches
              // at 1:1 into the letterboxed rect; wrapper Stacks handle zoom/pan.
              Canvas(this.canvasCtx)
                .id('rd-screen-canvas')
                .width('100%')
                .height('100%')
                .onReady(() => {
                  this.canvasReady = true;
                  this.hasFullBaseline = false;
                  this.lastDrawRectKey = '';
                  const pmToDraw = this.directPixelMap ?? this.pixelMap;
                  const metaToDraw = this.directFrameMeta ?? this.frameMeta;
                  if (pmToDraw !== null) {
                    this.drawFrame(pmToDraw, metaToDraw);
                  }
                })
                .hitTestBehavior(HitTestMode.None)
            } else {
              Column({ space: 8 }) {
                LoadingProgress()
                  .width(36)
                  .height(36)
                  .color('#38BDF8')
                Text('等待远程桌面画面...')
                  .fontSize(13)
                  .fontColor('#94A3B8')
              }
            }

            if (this.frameMeta !== null && this.frameMeta.echoX >= 0) {
              // DEBUG crosshair: where the host received the pointer
              Stack() {
                Text('+')
                  .fontSize(22)
                  .fontColor('#FF3B30')
              }
              .position({
                x: this.getRenderedImageRect().x + this.frameMeta.echoX * this.getRenderedImageRect().w - 9,
                y: this.getRenderedImageRect().y + this.frameMeta.echoY * this.getRenderedImageRect().h - 13,
              })
              .hitTestBehavior(HitTestMode.None)
            }

            if ((this.videoActive || this.pixelMap !== null) && this.cursorShape !== null && this.cursorShape.png.length > 0) {
              Image(`data:image/png;base64,${this.cursorShape.png}`)
                .width(Math.max(12, (this.cursorShape.w || 32) * 0.75))
                .height(Math.max(12, (this.cursorShape.h || 32) * 0.75))
                .objectFit(ImageFit.Contain)
                .position({
                  x: this.cursorImagePosX(this.cursorShape),
                  y: this.cursorImagePosY(this.cursorShape),
                })
                .hitTestBehavior(HitTestMode.None)
            } else if (this.touchMode === 'trackpad' && (this.videoActive || this.pixelMap !== null)) {
              Circle({ width: 12, height: 12 })
                .fill('#38BDF8')
                .stroke('#FFFFFF')
                .strokeWidth(2)
                .position({
                  x: this.cursorPosX(),
                  y: this.cursorPosY(),
                })
                .hitTestBehavior(HitTestMode.None)
            }
          }
          .width('100%')
          .height('100%')
          .scale({ x: this.zoom, y: this.zoom, centerX: '50%', centerY: '50%' })
          .hitTestBehavior(HitTestMode.None)
        }
        .width('100%')
        .height('100%')
        .translate({ x: this.panX, y: this.panY })
        .hitTestBehavior(HitTestMode.None)

        if (this.rippleVisible) {
          Circle({ width: 32, height: 32 })
            .fill('#00000000')
            .stroke(this.rippleColor)
            .strokeWidth(2.5)
            .position({ x: this.rippleX, y: this.rippleY })
            .hitTestBehavior(HitTestMode.None)
        }

        if (this.showGuide) {
          Column({ space: 8 }) {
            Text('触控操作指南')
              .fontSize(15)
              .fontWeight(FontWeight.Bold)
              .fontColor('#F8FAFC')
            Text('• 单指轻点：左键点击（连点两下即双击）')
              .fontSize(12)
              .fontColor('#CBD5E1')
            Text('• 长按 / 双指轻点：鼠标右键')
              .fontSize(12)
              .fontColor('#CBD5E1')
            Text('• 单指上下滑：滚轮滚动（放大后拖动平移）')
              .fontSize(12)
              .fontColor('#CBD5E1')
            Text('• 双指捏合：缩放画面 · 「拖曳」键：拖窗口/框选')
              .fontSize(12)
              .fontColor('#CBD5E1')
            Button('知道了')
              .height(32)
              .fontSize(12)
              .backgroundColor('#38BDF8')
              .fontColor('#082F49')
              .borderRadius(8)
              .onClick(() => {
                this.showGuide = false;
              })
          }
          .width('84%')
          .constraintSize({ maxWidth: 320 })
          .padding(16)
          .backgroundColor('#EE0F172A')
          .borderRadius(14)
          .border({ width: 1, color: '#38BDF8' })
        }

        if (this.compactChrome) {
          Column({ space: 8 }) {
            if (this.orbMenuOpen) {
              Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.End }) {
                Button('展开栏')
                  .height(30)
                  .fontSize(11)
                  .backgroundColor('#1E3A5F')
                  .fontColor('#38BDF8')
                  .borderRadius(8)
                  .margin(3)
                  .onClick(() => {
                    this.orbMenuOpen = false;
                    this.onExitImmersive();
                  })
                Button(this.touchMode === 'direct' ? '直触' : '指针')
                  .height(30)
                  .fontSize(11)
                  .backgroundColor('#1A2232')
                  .fontColor('#E2E8F0')
                  .borderRadius(8)
                  .margin(3)
                  .onClick(() => {
                    this.touchMode = this.touchMode === 'direct' ? 'trackpad' : 'direct';
                    this.dragLock = false;
                  })
                Button(this.dragLock ? '拖曳中' : '拖曳')
                  .height(30)
                  .fontSize(11)
                  .backgroundColor(this.dragLock ? '#1E3A5F' : '#1A2232')
                  .fontColor(this.dragLock ? '#38BDF8' : '#E2E8F0')
                  .borderRadius(8)
                  .margin(3)
                  .onClick(() => {
                    this.dragLock = !this.dragLock;
                  })
                Button('右键')
                  .height(30)
                  .fontSize(11)
                  .backgroundColor('#1A2232')
                  .fontColor('#E2E8F0')
                  .borderRadius(8)
                  .margin(3)
                  .onClick(() => {
                    this.client?.sendMouse('click', this.localCursorX, this.localCursorY, 'right');
                  })
                Button(this.audioEnabled ? '声音开' : '声音')
                  .height(30)
                  .fontSize(11)
                  .backgroundColor(this.audioEnabled ? '#1E3A5F' : '#1A2232')
                  .fontColor(this.audioEnabled ? '#38BDF8' : '#E2E8F0')
                  .borderRadius(8)
                  .margin(3)
                  .onClick(() => {
                    this.onToggleAudio();
                  })
                Button('快捷键')
                  .height(30)
                  .fontSize(11)
                  .backgroundColor('#1A2232')
                  .fontColor('#E2E8F0')
                  .borderRadius(8)
                  .margin(3)
                  .onClick(() => {
                    this.orbMenuOpen = false;
                    this.showVirtualKeys = true;
                    this.onExitImmersive();
                  })
                Button('键盘')
                  .height(30)
                  .fontSize(11)
                  .backgroundColor('#1A2232')
                  .fontColor('#E2E8F0')
                  .borderRadius(8)
                  .margin(3)
                  .onClick(() => {
                    this.orbMenuOpen = false;
                    this.onExitImmersive();
                    this.focusImeBox();
                  })
                Button('断开')
                  .height(30)
                  .fontSize(11)
                  .backgroundColor('#451A22')
                  .fontColor('#FCA5A5')
                  .borderRadius(8)
                  .margin(3)
                  .onClick(() => {
                    this.orbMenuOpen = false;
                    this.onDisconnect();
                  })
              }
              .width(240)
              .padding(8)
              .backgroundColor('#E60F172A')
              .borderRadius(12)
              .border({ width: 1, color: '#253147' })
            }

            Button(this.orbMenuOpen ? '×' : '球')
              .width(44)
              .height(44)
              .fontSize(13)
              .fontWeight(FontWeight.Bold)
              .backgroundColor('#CC0F172A')
              .fontColor('#38BDF8')
              .borderRadius(22)
              .border({ width: 1.5, color: '#38BDF8' })
              .onClick(() => {
                this.orbMenuOpen = !this.orbMenuOpen;
              })
          }
          .alignItems(HorizontalAlign.End)
          .position({ right: 14, bottom: 18 })
        }
      }
      .width('100%')
      .layoutWeight(1)
      .backgroundColor('#05070B')
      .clip(true)
      .focusable(true)
      .onAreaChange((_oldVal: Area, newVal: Area) => {
        const w = Number(newVal.width);
        const h = Number(newVal.height);
        if (w > 0 && h > 0 && (Math.abs(w - this.areaWidth) > 0.5 || Math.abs(h - this.areaHeight) > 0.5)) {
          this.areaWidth = w;
          this.areaHeight = h;
          this.hasFullBaseline = false;
          this.lastDrawRectKey = '';
          this.client?.refreshFullFrame();
        }
      })
      .onTouch((ev: TouchEvent) => {
        this.handleTouch(ev);
      })
      .onKeyEvent((ev: KeyEvent) => {
        if (!this.canControl || !this.client) return;
        const vk = harmonyKeyToVk(ev.keyCode);
        if (vk <= 0) return;
        this.client.sendKey(ev.type === KeyType.Down ? 'down' : 'up', vk);
      })

      if (!this.compactChrome) {
        Column({ space: this.isLandscape && this.tier === 'phone' ? 5 : 8 }) {
          if (this.showTextBridge) {
            Row({ space: 8 }) {
              TextInput({
                text: this.textInput,
                placeholder: '键盘直连中：直接打字，字符实时到远端（回车=Enter）',
              })
                .id('rd-ime-box')
                .layoutWeight(1)
                .height(38)
                .fontSize(13)
                .fontColor('#E2E8F0')
                .placeholderColor('#38BDF8')
                .backgroundColor('#0B0F17')
                .borderRadius(8)
                .border({ width: 1, color: '#38BDF8' })
                .enterKeyType(EnterKeyType.Send)
                .onChange((val: string) => {
                  this.textInput = val;
                })
                .onWillInsert((info: InsertValue) => {
                  // Only IME-committed text reaches here (pre-edit/pinyin is skipped),
                  // reject locally so the box stays empty, and type it on the host.
                  this.forwardInsert(info.insertValue);
                  return false;
                })
                .onWillDelete((info: DeleteValue) => {
                  this.forwardDelete(info);
                  return false;
                })
                .onSubmit(() => {
                  this.submitText();
                })

              Button('收起')
                .height(38)
                .fontSize(12)
                .backgroundColor('#1A2232')
                .fontColor('#94A3B8')
                .borderRadius(8)
                .onClick(() => {
                  this.showTextBridge = false;
                })
            }
            .width('100%')
          }

          if (this.showVirtualKeys) {
            Column({ space: 6 }) {
              Scroll() {
                Row({ space: 6 }) {
                  Button('CTRL')
                    .height(30)
                    .fontSize(11)
                    .backgroundColor(this.ctrlSticky ? '#1E3A5F' : '#1A2232')
                    .fontColor(this.ctrlSticky ? '#38BDF8' : '#E2E8F0')
                    .borderRadius(6)
                    .onClick(() => { this.ctrlSticky = !this.ctrlSticky; })
                  Button('ALT')
                    .height(30)
                    .fontSize(11)
                    .backgroundColor(this.altSticky ? '#1E3A5F' : '#1A2232')
                    .fontColor(this.altSticky ? '#38BDF8' : '#E2E8F0')
                    .borderRadius(6)
                    .onClick(() => { this.altSticky = !this.altSticky; })
                  Button('SHIFT')
                    .height(30)
                    .fontSize(11)
                    .backgroundColor(this.shiftSticky ? '#1E3A5F' : '#1A2232')
                    .fontColor(this.shiftSticky ? '#38BDF8' : '#E2E8F0')
                    .borderRadius(6)
                    .onClick(() => { this.shiftSticky = !this.shiftSticky; })
                  Button('WIN')
                    .height(30)
                    .fontSize(11)
                    .backgroundColor(this.metaSticky ? '#1E3A5F' : '#1A2232')
                    .fontColor(this.metaSticky ? '#38BDF8' : '#E2E8F0')
                    .borderRadius(6)
                    .onClick(() => { this.metaSticky = !this.metaSticky; })
                  Button('←').height(30).fontSize(12).backgroundColor('#1A2232').fontColor('#E2E8F0').borderRadius(6)
                    .onClick(() => { this.fireHotkey(0x25, false, false, false, false); })
                  Button('↑').height(30).fontSize(12).backgroundColor('#1A2232').fontColor('#E2E8F0').borderRadius(6)
                    .onClick(() => { this.fireHotkey(0x26, false, false, false, false); })
                  Button('↓').height(30).fontSize(12).backgroundColor('#1A2232').fontColor('#E2E8F0').borderRadius(6)
                    .onClick(() => { this.fireHotkey(0x28, false, false, false, false); })
                  Button('→').height(30).fontSize(12).backgroundColor('#1A2232').fontColor('#E2E8F0').borderRadius(6)
                    .onClick(() => { this.fireHotkey(0x27, false, false, false, false); })
                }
              }
              .scrollable(ScrollDirection.Horizontal)
              .scrollBar(BarState.Off)
              .width('100%')

              Scroll() {
                Row({ space: 6 }) {
                  ForEach(QUICK_HOTKEYS, (hk: QuickHotkey) => {
                    Button(hk.label)
                      .height(30)
                      .fontSize(11)
                      .backgroundColor('#1A2232')
                      .fontColor('#E2E8F0')
                      .borderRadius(6)
                      .onClick(() => {
                        this.fireHotkey(hk.vk, hk.ctrl, hk.alt, hk.shift, hk.meta);
                      })
                  }, (hk: QuickHotkey) => hk.id)
                }
              }
              .scrollable(ScrollDirection.Horizontal)
              .scrollBar(BarState.Off)
              .width('100%')
            }
            .width('100%')
          }

          Scroll() {
            Row({ space: 8 }) {
              Button(this.touchMode === 'direct' ? '直触模式' : '指针模式')
                .height(34)
                .fontSize(12)
                .backgroundColor('#1E3A5F')
                .fontColor('#38BDF8')
                .borderRadius(8)
                .onClick(() => {
                  this.touchMode = this.touchMode === 'direct' ? 'trackpad' : 'direct';
                  this.dragLock = false;
                })

              Button(this.dragLock ? '拖曳中' : '拖曳')
                .height(34)
                .fontSize(12)
                .backgroundColor(this.dragLock ? '#1E3A5F' : '#1A2232')
                .fontColor(this.dragLock ? '#38BDF8' : '#E2E8F0')
                .borderRadius(8)
                .onClick(() => {
                  this.dragLock = !this.dragLock;
                })

              Button('右键')
                .height(34)
                .fontSize(12)
                .backgroundColor('#1A2232')
                .fontColor('#E2E8F0')
                .borderRadius(8)
                .onClick(() => {
                  this.client?.sendMouse('click', this.localCursorX, this.localCursorY, 'right');
                })

              Button('快捷键')
                .height(34)
                .fontSize(12)
                .backgroundColor(this.showVirtualKeys ? '#1E3A5F' : '#1A2232')
                .fontColor(this.showVirtualKeys ? '#38BDF8' : '#E2E8F0')
                .borderRadius(8)
                .onClick(() => {
                  this.showVirtualKeys = !this.showVirtualKeys;
                })

              Button(this.showTextBridge ? '键盘开' : '键盘')
                .height(34)
                .fontSize(12)
                .backgroundColor(this.showTextBridge ? '#1E3A5F' : '#1A2232')
                .fontColor(this.showTextBridge ? '#38BDF8' : '#E2E8F0')
                .borderRadius(8)
                .onClick(() => {
                  if (this.showTextBridge) {
                    this.showTextBridge = false;
                  } else {
                    this.focusImeBox();
                  }
                })

              if (this.zoom > 1.02) {
                Button(`重置 ${this.zoom}x`)
                  .height(34)
                  .fontSize(12)
                  .backgroundColor('#1A2232')
                  .fontColor('#34D399')
                  .borderRadius(8)
                  .onClick(() => {
                    this.zoom = 1;
                    this.panX = 0;
                    this.panY = 0;
                  })
              }

              Button('手势')
                .height(34)
                .fontSize(12)
                .backgroundColor(this.showGuide ? '#1E3A5F' : '#1A2232')
                .fontColor(this.showGuide ? '#38BDF8' : '#94A3B8')
                .borderRadius(8)
                .onClick(() => {
                  this.showGuide = !this.showGuide;
                })
            }
          }
          .scrollable(ScrollDirection.Horizontal)
          .scrollBar(BarState.Off)
          .width('100%')
        }
        .width('100%')
        .padding(this.isLandscape && this.tier === 'phone'
          ? { left: 10, right: 10, top: 4, bottom: 5 }
          : { left: 10, right: 10, top: 8, bottom: 10 })
        .backgroundColor('#121824')
        .border({ width: { top: 1 }, color: '#253147' })
      }
    }
    .width('100%')
    .height('100%')
  }
}
