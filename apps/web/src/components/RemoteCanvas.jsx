import React, { useEffect, useRef, useState } from 'react';
import { MSG } from '../lib/protocol.js';
import { QUICK_HOTKEYS, eventToVk } from '../lib/keymap.js';

export function RemoteCanvas({
  tier,
  isTouch,
  transport,
  frameRef,
  frameQueueRef,
  frameTick,
  videoRef,
  canControl,
  immersive = false,
  onToggleImmersive,
  onDisconnect,
  onZoomChange,
  onDropFiles,
  dropUploadProgress = null,
  onCancelDropUpload,
  pointerLockTrigger = 0,
  onPointerLockChange,
  onNotify,
}) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const lastMoveSentRef = useRef(0);
  const virtualCursorRef = useRef({ x: 0.5, y: 0.5 });

  // Mobile/Tablet controls
  const [touchMode, setTouchMode] = useState('direct');
  const [dragLock, setDragLock] = useState(false);
  const [ripple, setRipple] = useState(null);
  const [showVirtualKeys, setShowVirtualKeys] = useState(false);
  const [showTextBridge, setShowTextBridge] = useState(false);
  const [showGuide, setShowGuide] = useState(() => {
    try {
      return isTouch && localStorage.getItem('rd_gesture_guide_seen') !== '1';
    } catch {
      return false;
    }
  });
  const [orbOpen, setOrbOpen] = useState(false);
  const [directKeyboard, setDirectKeyboard] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [stickyMods, setStickyMods] = useState({ ctrl: false, alt: false, shift: false, meta: false });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [cursorUi, setCursorUi] = useState({ x: 0.5, y: 0.5 });
  const [cursorShape, setCursorShape] = useState(null);
  const [dragOverFiles, setDragOverFiles] = useState(false);
  const [pointerLocked, setPointerLocked] = useState(false);

  const stageRef = useRef(null);
  const roiTimerRef = useRef(0);
  const roiActiveRef = useRef(false);
  const lastRoiKeyRef = useRef('');
  const imeRef = useRef(null);
  const composingRef = useRef(false);
  const gestureRef = useRef(null);
  const longTimerRef = useRef(null);
  const rippleTimerRef = useRef(null);
  const drawingChainRef = useRef(Promise.resolve());
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    zoomRef.current = zoom;
    panRef.current = pan;
    // Ask the host for native-resolution frames while zoomed in.
    onZoomChange?.(zoom);

    window.clearTimeout(roiTimerRef.current);
    if (zoom <= 1.4) {
      if (roiActiveRef.current) {
        roiActiveRef.current = false;
        lastRoiKeyRef.current = '';
        transport?.sendJson({ type: MSG.SCREEN_CONFIG, roi: null, hiRes: false });
      }
      return;
    }
    if (zoom <= 1.8) return;
    // Re-requesting the ROI while the user is still panning makes the host force
    // a keyframe every time, which shows up as stutter. Activate quickly the
    // first time, then wait for the pan to settle before moving the region.
    const settleMs = roiActiveRef.current ? 550 : 140;
    roiTimerRef.current = window.setTimeout(() => {
      const stage = stageRef.current;
      const canvas = canvasRef.current;
      if (!stage || !canvas || zoomRef.current <= 1.8) return;
      const sr = stage.getBoundingClientRect();
      const cr = canvas.getBoundingClientRect();
      if (cr.width <= 0 || cr.height <= 0) return;
      const pad = 0.08;
      const tlX = (sr.left - cr.left) / cr.width;
      const tlY = (sr.top - cr.top) / cr.height;
      const brX = (sr.right - cr.left) / cr.width;
      const brY = (sr.bottom - cr.top) / cr.height;
      // Coarser grid: a 1/25 step keeps the region stable while panning instead
      // of re-cutting a keyframe on every ~38px of movement.
      const snap = (v) => Math.round(v * 25) / 25;
      const rx = Math.max(0, Math.min(0.8, snap(tlX - pad)));
      const ry = Math.max(0, Math.min(0.8, snap(tlY - pad)));
      const rw = Math.max(0.2, Math.min(1 - rx, snap(brX - rx + pad)));
      const rh = Math.max(0.2, Math.min(1 - ry, snap(brY - ry + pad)));
      const key = `${rx.toFixed(2)}:${ry.toFixed(2)}:${rw.toFixed(2)}:${rh.toFixed(2)}`;
      if (key === lastRoiKeyRef.current) return;
      lastRoiKeyRef.current = key;
      roiActiveRef.current = true;
      transport?.sendJson({ type: MSG.SCREEN_CONFIG, roi: { x: rx, y: ry, w: rw, h: rh }, hiRes: true });
    }, settleMs);
  }, [zoom, pan, onZoomChange, transport]);

  useEffect(() => {
    setTouchMode('direct');
    setDragLock(false);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [tier]);

  // Hand the canvas to the H.264 decoder (it draws decoded frames directly).
  useEffect(() => {
    videoRef?.current?.attach(canvasRef.current);
  }, [videoRef]);

  useEffect(() => {
    const onLockChange = () => {
      const locked = Boolean(canvasRef.current && document.pointerLockElement === canvasRef.current);
      setPointerLocked(locked);
      onPointerLockChange?.(locked);
    };
    document.addEventListener('pointerlockchange', onLockChange);
    return () => document.removeEventListener('pointerlockchange', onLockChange);
  }, [onPointerLockChange]);

  useEffect(() => {
    if (pointerLockTrigger <= 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (document.pointerLockElement === canvas) {
      document.exitPointerLock?.();
    } else {
      try {
        canvas.requestPointerLock?.();
      } catch {
        onNotify?.('当前浏览器不支持鼠标锁定');
      }
    }
  }, [pointerLockTrigger, onNotify]);

  // Draw incoming full or dirty-rect JPEG frames sequentially onto canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const queued = frameQueueRef?.current?.length
      ? frameQueueRef.current.splice(0)
      : (frameRef.current ? [frameRef.current] : []);
    if (queued.length === 0) return;

    const decodeAndDraw = async (item) => {
      const { meta, jpegBytes } = item;
      if (typeof meta?.cursorX === 'number' && typeof meta?.cursorY === 'number') {
        virtualCursorRef.current = { x: meta.cursorX, y: meta.cursorY };
        setCursorUi({ x: meta.cursorX, y: meta.cursorY });
      }
      if (meta?.cursorShape && meta.cursorShape.png) {
        setCursorShape(meta.cursorShape);
      }
      // H.264 or unchanged cursor-only frames carry no JPEG.
      if (!jpegBytes || jpegBytes.byteLength === 0) return;
      const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
      const drawAt = (drawable) => {
        const dirty = meta?.dirty;
        // A patch for a different frame size (scale/zoom changed) cannot be
        // placed yet: resize + clear, then let the following strips fill in.
        if (dirty && meta?.width > 0 && meta?.height > 0 && (canvas.width !== meta.width || canvas.height !== meta.height)) {
          canvas.width = meta.width;
          canvas.height = meta.height;
          canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
        }
        if (
          dirty &&
          meta?.width > 0 &&
          meta?.height > 0 &&
          canvas.width === meta.width &&
          canvas.height === meta.height
        ) {
          canvas.getContext('2d').drawImage(drawable, dirty.x, dirty.y);
          return;
        }
        if (meta?.roi && meta.fullWidth > 0 && meta.fullHeight > 0) {
          if (canvas.width !== meta.fullWidth || canvas.height !== meta.fullHeight) {
            canvas.width = meta.fullWidth;
            canvas.height = meta.fullHeight;
          }
          canvas.getContext('2d').drawImage(
            drawable,
            meta.roi.x * canvas.width,
            meta.roi.y * canvas.height,
            meta.roi.w * canvas.width,
            meta.roi.h * canvas.height,
          );
          return;
        }
        const targetW = meta?.width || drawable.width;
        const targetH = meta?.height || drawable.height;
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }
        canvas.getContext('2d').drawImage(drawable, 0, 0);
      };

      if (typeof createImageBitmap === 'function') {
        const bmp = await createImageBitmap(blob);
        try {
          drawAt(bmp);
        } finally {
          bmp.close();
        }
      } else {
        const url = URL.createObjectURL(blob);
        try {
          await new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
              drawAt(img);
              resolve();
            };
            img.onerror = resolve;
            img.src = url;
          });
        } finally {
          URL.revokeObjectURL(url);
        }
      }
    };

    drawingChainRef.current = drawingChainRef.current
      .then(async () => {
        for (const item of queued) {
          await decodeAndDraw(item);
        }
      })
      .catch(() => {});
  }, [frameTick, frameRef, frameQueueRef]);

  const clientToNormalized = (clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0.5, y: 0.5 };
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { x: 0.5, y: 0.5 };
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return { x, y };
  };

  const buttonName = (btn) => {
    if (btn === 2) return 'right';
    if (btn === 1) return 'middle';
    return 'left';
  };

  // Desktop mouse handlers
  const handleMouseMove = (e) => {
    if (!canControl || isTouch) return;
    if (document.pointerLockElement === canvasRef.current) {
      const dx = Math.round(e.movementX || 0);
      const dy = Math.round(e.movementY || 0);
      if (dx !== 0 || dy !== 0) {
        transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'move_rel', dx, dy });
      }
      return;
    }
    const now = performance.now();
    if (now - lastMoveSentRef.current < 16) return;
    lastMoveSentRef.current = now;
    const { x, y } = clientToNormalized(e.clientX, e.clientY);
    transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'move', x, y });
  };

  const handleMouseDown = (e) => {
    if (!canControl || isTouch) return;
    // Keep the hidden IME sink focused (do not let the canvas steal focus away).
    e.preventDefault();
    if (document.pointerLockElement === canvasRef.current) {
      transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'down', button: buttonName(e.button) });
      return;
    }
    focusIme(false);
    const { x, y } = clientToNormalized(e.clientX, e.clientY);
    transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'down', x, y, button: buttonName(e.button) });
  };

  const handleMouseUp = (e) => {
    if (!canControl || isTouch) return;
    if (document.pointerLockElement === canvasRef.current) {
      transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'up', button: buttonName(e.button) });
      return;
    }
    const { x, y } = clientToNormalized(e.clientX, e.clientY);
    transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'up', x, y, button: buttonName(e.button) });
  };

  const handleWheel = (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const nextZoom = Math.max(1, Math.min(4, Number((zoomRef.current + (e.deltaY < 0 ? 0.25 : -0.25)).toFixed(2))));
      zoomRef.current = nextZoom;
      setZoom(nextZoom);
      if (nextZoom <= 1.02) {
        panRef.current = { x: 0, y: 0 };
        setPan({ x: 0, y: 0 });
      }
      return;
    }
    if (!canControl) return;
    const { x, y } = clientToNormalized(e.clientX, e.clientY);
    const deltaY = Math.max(-240, Math.min(240, Math.round(-e.deltaY)));
    transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'wheel', x, y, deltaY });
  };

  // Desktop keyboard handler
  const handleKeyDown = (e) => {
    if (!canControl) return;
    const vk = eventToVk(e);
    if (!vk) return;
    e.preventDefault();
    transport.sendJson({ type: MSG.INPUT_KEY, action: 'down', vk, code: e.code });
  };

  const handleKeyUp = (e) => {
    if (!canControl) return;
    const vk = eventToVk(e);
    if (!vk) return;
    e.preventDefault();
    transport.sendJson({ type: MSG.INPUT_KEY, action: 'up', vk, code: e.code });
  };

  // Touch helpers & handlers (Direct Touch default + Pointer/Trackpad + Focal Pinch Zoom)
  const clearLongTimer = () => {
    if (longTimerRef.current) {
      clearTimeout(longTimerRef.current);
      longTimerRef.current = null;
    }
  };

  useEffect(() => () => {
    clearLongTimer();
    if (rippleTimerRef.current) {
      clearTimeout(rippleTimerRef.current);
      rippleTimerRef.current = null;
    }
  }, []);

  const showRippleAtClient = (clientX, clientY, color = '#38BDF8') => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    setRipple({ x: clientX - rect.left, y: clientY - rect.top, color });
    if (rippleTimerRef.current) clearTimeout(rippleTimerRef.current);
    rippleTimerRef.current = setTimeout(() => {
      setRipple(null);
      rippleTimerRef.current = null;
    }, 240);
  };

  const showRippleAtCursor = (color = '#38BDF8') => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    showRippleAtClient(
      rect.left + virtualCursorRef.current.x * rect.width,
      rect.top + virtualCursorRef.current.y * rect.height,
      color,
    );
  };

  const clampPan = (rawX, rawY, nextZoom) => {
    if (nextZoom <= 1.02) return { x: 0, y: 0 };
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return { x: rawX, y: rawY };
    const sr = stage.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    const curZ = Math.max(1, zoomRef.current);
    const baseW = cr.width / curZ;
    const baseH = cr.height / curZ;
    const maxX = Math.max(0, (baseW * nextZoom - sr.width) / 2 + 28);
    const maxY = Math.max(0, (baseH * nextZoom - sr.height) / 2 + 28);
    return {
      x: Math.max(-maxX, Math.min(maxX, rawX)),
      y: Math.max(-maxY, Math.min(maxY, rawY)),
    };
  };

  const wheelPendingRef = useRef(0);
  const wheelTimerRef = useRef(0);
  const momentumTimerRef = useRef(0);

  /**
   * Smooth wheel: dragging maps to continuous sub-notch wheel deltas instead of
   * jumping one full 120-unit notch every 18px, and a short momentum tail makes
   * it feel like touch scrolling (mouse wheels stay discrete, this does not).
   */
  const queueWheel = (dyPx) => {
    wheelPendingRef.current += dyPx;
    if (wheelTimerRef.current) return;
    wheelTimerRef.current = window.setTimeout(() => {
      wheelTimerRef.current = 0;
      const px = wheelPendingRef.current;
      wheelPendingRef.current = 0;
      const delta = Math.max(-240, Math.min(240, Math.round(px * 3)));
      if (delta !== 0) {
        transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'wheel', deltaY: delta });
      }
    }, 12);
  };

  const startMomentum = (velocityY) => {
    window.clearTimeout(momentumTimerRef.current);
    let v = velocityY;
    const step = () => {
      v *= 0.82;
      if (Math.abs(v) < 0.06) return;
      queueWheel(v * 16);
      momentumTimerRef.current = window.setTimeout(step, 16);
    };
    momentumTimerRef.current = window.setTimeout(step, 16);
  };

  const handleTouchStart = (e) => {
    if (!canControl) return;
    // A new touch stops any scroll momentum from the previous flick.
    window.clearTimeout(momentumTimerRef.current);
    momentumTimerRef.current = 0;
    // Keep the IME sink focused while direct keyboard mode is on, so tapping
    // the remote screen does not dismiss the soft keyboard mid-typing.
    if (directKeyboard) focusIme(false);
    const touches = e.touches;
    const now = Date.now();

    if (touches.length >= 2) {
      clearLongTimer();
      const prev = gestureRef.current;
      if (prev?.buttonDown) {
        transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'up', button: 'left' });
      }
      const [a, b] = touches;
      const dist = Math.max(10, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY));
      const midX = (a.clientX + b.clientX) / 2;
      const midY = (a.clientY + b.clientY) / 2;
      gestureRef.current = {
        phase: 'two',
        startDist: dist,
        lastDist: dist,
        lastMidX: midX,
        lastMidY: midY,
        startAt: now,
        moved: false,
        wheelAccum: 0,
      };
      return;
    }

    if (touches.length === 1) {
      if (gestureRef.current?.phase === 'two' || gestureRef.current?.phase === 'ignore') {
        return;
      }
      const t = touches[0];
      const prevTapAt = gestureRef.current?.lastTapAt || 0;
      const prevTapX = gestureRef.current?.lastTapX || 0;
      const prevTapY = gestureRef.current?.lastTapY || 0;
      const isDoubleTapHold =
        now - prevTapAt < 300 && Math.hypot(t.clientX - prevTapX, t.clientY - prevTapY) < 32;
      const activeDrag = dragLock || (touchMode === 'trackpad' && isDoubleTapHold);

      gestureRef.current = {
        phase: 'one',
        startX: t.clientX,
        startY: t.clientY,
        lastX: t.clientX,
        lastY: t.clientY,
        startAt: now,
        moved: false,
        longFired: false,
        activeDrag,
        buttonDown: false,
        scrollAccumY: 0,
        scrollVy: 0,
        scrollMoved: false,
        lastTapAt: prevTapAt,
        lastTapX: prevTapX,
        lastTapY: prevTapY,
      };

      clearLongTimer();
      if (!activeDrag) {
        longTimerRef.current = setTimeout(() => {
          const g = gestureRef.current;
          if (!g || g.phase !== 'one' || g.moved) return;
          g.longFired = true;
          if (touchMode === 'direct') {
            const { x, y } = clientToNormalized(g.startX, g.startY);
            virtualCursorRef.current = { x, y };
            setCursorUi({ x, y });
            transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'click', x, y, button: 'right' });
            showRippleAtClient(g.startX, g.startY, '#A78BFA');
          } else {
            transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'click', button: 'right' });
            showRippleAtCursor('#A78BFA');
          }
        }, 420);
      }
    }
  };

  const handleTouchMove = (e) => {
    if (!canControl || !gestureRef.current) return;
    const g = gestureRef.current;
    const touches = e.touches;

    if (touches.length >= 2) {
      if (g.phase !== 'two') return;
      const [a, b] = touches;
      const dist = Math.max(10, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY));
      const midX = (a.clientX + b.clientX) / 2;
      const midY = (a.clientY + b.clientY) / 2;
      const dMidX = midX - g.lastMidX;
      const dMidY = midY - g.lastMidY;

      if (Math.abs(dist - g.startDist) > 10 || Math.hypot(dMidX, dMidY) > 3) {
        g.moved = true;
      }

      const prevZoom = Math.max(1, zoomRef.current);
      const nextZoom = Number(
        Math.max(1, Math.min(4, prevZoom * (dist / Math.max(10, g.lastDist)))).toFixed(2),
      );

      if (Math.abs(dist - g.startDist) > 10 || prevZoom > 1.02) {
        const stage = stageRef.current;
        if (stage) {
          const sr = stage.getBoundingClientRect();
          const cx = sr.left + sr.width / 2;
          const cy = sr.top + sr.height / 2;
          const curPan = panRef.current;
          const ux = (g.lastMidX - cx - curPan.x) / prevZoom;
          const uy = (g.lastMidY - cy - curPan.y) / prevZoom;
          const nextPan = clampPan(midX - cx - ux * nextZoom, midY - cy - uy * nextZoom, nextZoom);
          zoomRef.current = nextZoom;
          panRef.current = nextPan;
          setZoom(nextZoom);
          setPan(nextPan);
        }
      } else {
        queueWheel(dMidY);
      }

      g.lastDist = dist;
      g.lastMidX = midX;
      g.lastMidY = midY;
      return;
    }

    if (g.phase === 'one' && touches.length === 1) {
      const t = touches[0];
      const dx = t.clientX - g.lastX;
      const dy = t.clientY - g.lastY;
      g.lastX = t.clientX;
      g.lastY = t.clientY;

      if (!g.moved && Math.hypot(t.clientX - g.startX, t.clientY - g.startY) > 8) {
        g.moved = true;
        clearLongTimer();
        if (g.activeDrag && !g.buttonDown) {
          g.buttonDown = true;
          if (touchMode === 'direct') {
            const { x, y } = clientToNormalized(g.startX, g.startY);
            virtualCursorRef.current = { x, y };
            setCursorUi({ x, y });
            transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'down', x, y, button: 'left' });
          } else {
            transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'down', button: 'left' });
          }
        }
      }

      if (!g.moved) return;

      if (g.buttonDown) {
        if (touchMode === 'direct') {
          const { x, y } = clientToNormalized(t.clientX, t.clientY);
          virtualCursorRef.current = { x, y };
          setCursorUi({ x, y });
          const now = performance.now();
          if (now - lastMoveSentRef.current >= 16) {
            lastMoveSentRef.current = now;
            transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'move', x, y });
          }
        } else {
          const gain = 1.5;
          transport.sendJson({
            type: MSG.INPUT_MOUSE,
            action: 'move_rel',
            dx: Math.round(dx * gain),
            dy: Math.round(dy * gain),
          });
          const nextX = Math.max(0, Math.min(1, virtualCursorRef.current.x + (dx * gain) / 1280));
          const nextY = Math.max(0, Math.min(1, virtualCursorRef.current.y + (dy * gain) / 720));
          virtualCursorRef.current = { x: nextX, y: nextY };
          setCursorUi({ x: nextX, y: nextY });
        }
        return;
      }

      if (touchMode === 'direct') {
        if (zoomRef.current > 1.04) {
          const nextPan = clampPan(panRef.current.x + dx, panRef.current.y + dy, zoomRef.current);
          panRef.current = nextPan;
          setPan(nextPan);
        } else {
          queueWheel(dy);
          g.scrollVy = g.scrollVy * 0.6 + (dy / 16) * 0.4;
          g.scrollMoved = true;
        }
      } else {
        const gain = 1.55;
        transport.sendJson({
          type: MSG.INPUT_MOUSE,
          action: 'move_rel',
          dx: Math.round(dx * gain),
          dy: Math.round(dy * gain),
        });
        const nextX = Math.max(0, Math.min(1, virtualCursorRef.current.x + (dx * gain) / 1280));
        const nextY = Math.max(0, Math.min(1, virtualCursorRef.current.y + (dy * gain) / 720));
        virtualCursorRef.current = { x: nextX, y: nextY };
        setCursorUi({ x: nextX, y: nextY });
      }
    }
  };

  const handleTouchEnd = (e) => {
    if (!canControl || !gestureRef.current) return;
    const g = gestureRef.current;

    // Touch-scroll momentum so flicking feels like a native list, not a notched wheel.
    if (g.scrollMoved && !g.buttonDown && g.phase !== 'two') {
      g.scrollMoved = false;
      startMomentum(g.scrollVy);
    }

    if (e.touches.length === 1 && g.phase === 'two') {
      if (!g.moved && Date.now() - g.startAt < 320) {
        if (touchMode === 'direct') {
          const { x, y } = clientToNormalized(g.lastMidX, g.lastMidY);
          transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'click', x, y, button: 'right' });
          showRippleAtClient(g.lastMidX, g.lastMidY, '#A78BFA');
        } else {
          transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'click', button: 'right' });
          showRippleAtCursor('#A78BFA');
        }
        g.moved = true;
      }
      g.phase = 'ignore';
      return;
    }

    if (e.touches.length > 0) return;

    clearLongTimer();
    if (g.buttonDown) {
      transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'up', button: 'left' });
      if (dragLock) setDragLock(false);
      gestureRef.current = null;
      return;
    }

    if (g.phase === 'two') {
      if (!g.moved && Date.now() - g.startAt < 320) {
        if (touchMode === 'direct') {
          const { x, y } = clientToNormalized(g.lastMidX, g.lastMidY);
          transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'click', x, y, button: 'right' });
          showRippleAtClient(g.lastMidX, g.lastMidY, '#A78BFA');
        } else {
          transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'click', button: 'right' });
          showRippleAtCursor('#A78BFA');
        }
      }
      gestureRef.current = null;
      return;
    }

    if (g.phase === 'one' && !g.moved && !g.longFired) {
      const now = Date.now();
      if (touchMode === 'direct') {
        const { x, y } = clientToNormalized(g.startX, g.startY);
        virtualCursorRef.current = { x, y };
        setCursorUi({ x, y });
        transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'click', x, y, button: 'left' });
        showRippleAtClient(g.startX, g.startY, '#38BDF8');
      } else {
        transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'click', button: 'left' });
        showRippleAtCursor('#38BDF8');
      }
      gestureRef.current = { lastTapAt: now, lastTapX: g.startX, lastTapY: g.startY };
      return;
    }

    gestureRef.current = null;
  };

  const handleTouchCancel = () => {
    clearLongTimer();
    if (gestureRef.current?.buttonDown) {
      transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'up', button: 'left' });
      if (dragLock) setDragLock(false);
    }
    gestureRef.current = null;
  };

  const sendHotkey = (vk, mods = {}) => {
    if (!canControl) return;
    const merged = {
      ctrl: Boolean(mods.ctrl || stickyMods.ctrl),
      alt: Boolean(mods.alt || stickyMods.alt),
      shift: Boolean(mods.shift || stickyMods.shift),
      meta: Boolean(mods.meta || stickyMods.meta),
    };
    transport.sendJson({ type: MSG.INPUT_HOTKEY, vk, mods: merged });
    if (stickyMods.ctrl || stickyMods.alt || stickyMods.shift || stickyMods.meta) {
      setStickyMods({ ctrl: false, alt: false, shift: false, meta: false });
    }
  };

  // ---- Direct keyboard / IME bridge: type straight into the remote screen,
  // No separate "send" step. A hidden textarea holds focus so Chinese IME
  // composition works, then the committed characters are injected as Unicode.
  const SPECIAL_KEY_VK = {
    Enter: 0x0d,
    Tab: 0x09,
    Backspace: 0x08,
    Delete: 0x2e,
    Escape: 0x1b,
    ArrowLeft: 0x25,
    ArrowUp: 0x26,
    ArrowRight: 0x27,
    ArrowDown: 0x28,
    Home: 0x24,
    End: 0x23,
    PageUp: 0x21,
    PageDown: 0x22,
    Insert: 0x2d,
  };

  const focusIme = (announce = true) => {
    const el = imeRef.current;
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
    } catch {
      try {
        el.focus();
      } catch {}
    }
    if (announce) setDirectKeyboard(true);
  };

  const blurIme = () => {
    composingRef.current = false;
    setDirectKeyboard(false);
    try {
      imeRef.current?.blur();
    } catch {}
  };

  const flushImeText = () => {
    const el = imeRef.current;
    if (!el || !canControl || composingRef.current) return;
    const text = el.value;
    if (!text) return;
    el.value = '';
    transport.sendJson({ type: MSG.INPUT_TEXT, text });
  };

  const handleImeKeyDown = (e) => {
    if (!canControl) return;
    if (e.isComposing || composingRef.current || e.keyCode === 229) return;
    const hasMod = e.ctrlKey || e.altKey || e.metaKey;
    const specialVk = SPECIAL_KEY_VK[e.key];
    if (specialVk && !hasMod) {
      e.preventDefault();
      transport.sendJson({ type: MSG.INPUT_KEY, action: 'tap', vk: specialVk });
      return;
    }
    if (hasMod) {
      const vk = eventToVk(e);
      if (!vk) return;
      e.preventDefault();
      sendHotkey(vk, { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
    }
    // Plain printable keys fall through to the `input` event (IME-safe).
  };

  const sendTextToHost = (e) => {
    e.preventDefault();
    if (!canControl || !textInput) return;
    transport.sendJson({ type: MSG.INPUT_TEXT, text: textInput });
    setTextInput('');
    onNotify?.('已发送文本到远端光标');
  };

  const toggleSticky = (mod) => {
    setStickyMods((prev) => ({ ...prev, [mod]: !prev[mod] }));
  };

  const hasFrame = Boolean(frameRef.current);

  return (
    <div className={`canvas-workspace tier-${tier}`} ref={containerRef}>
      <textarea
        ref={imeRef}
        className="remote-ime-input"
        aria-hidden="true"
        tabIndex={-1}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          flushImeText();
        }}
        onInput={() => {
          if (!composingRef.current) flushImeText();
        }}
        onKeyDown={handleImeKeyDown}
        onBlur={() => {
          composingRef.current = false;
          setDirectKeyboard(false);
        }}
      />
      <div
        ref={stageRef}
        className="canvas-stage"
        onContextMenu={(e) => e.preventDefault()}
        onDragOver={(e) => {
          if (e.dataTransfer?.types?.includes('Files')) {
            e.preventDefault();
            if (!dragOverFiles) setDragOverFiles(true);
          }
        }}
        onDragLeave={() => setDragOverFiles(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOverFiles(false);
          const files = e.dataTransfer?.files;
          if (files && files.length > 0) {
            void onDropFiles?.(files);
          }
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
      >
        {!hasFrame && (
          <div className="canvas-placeholder">
            <div className="spinner" />
            <p>正在等待远端画面首帧...</p>
          </div>
        )}
        {dragOverFiles && (
          <div className="rd-drop-overlay">
            <span>松开鼠标即可上传文件到远端电脑</span>
          </div>
        )}
        {pointerLocked && (
          <div className="rd-pointer-lock-pill">
            <span>鼠标相对锁定中（游戏视角模式）· 按 Esc 退出</span>
          </div>
        )}
        {dropUploadProgress && (
          <div className="rd-upload-progress" onMouseDown={(e) => e.stopPropagation()}>
            <div className="rd-upload-progress-head">
              <strong>正在上传 ({dropUploadProgress.index}/{dropUploadProgress.count})</strong>
              <button type="button" className="btn-ghost" onClick={() => onCancelDropUpload?.()}>
                取消
              </button>
            </div>
            <div className="rd-upload-progress-name">{dropUploadProgress.fileName}</div>
            <div className="rd-upload-progress-bar">
              <div
                className="rd-upload-progress-fill"
                style={{
                  width: `${dropUploadProgress.total > 0 ? Math.min(100, Math.round((dropUploadProgress.sent / dropUploadProgress.total) * 100)) : 100}%`,
                }}
              />
            </div>
            <div className="rd-upload-progress-meta">
              <span>{(dropUploadProgress.sent / (1024 * 1024)).toFixed(2)} MB / {(dropUploadProgress.total / (1024 * 1024)).toFixed(2)} MB</span>
              <span>{dropUploadProgress.total > 0 ? Math.min(100, Math.round((dropUploadProgress.sent / dropUploadProgress.total) * 100)) : 100}%</span>
            </div>
          </div>
        )}
        <div
          className="canvas-transform"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          <canvas
            ref={canvasRef}
            tabIndex={0}
            className={`remote-canvas ${canControl && cursorShape?.png && !isTouch && touchMode !== 'trackpad' ? 'has-remote-cursor' : ''}`}
            onMouseMove={handleMouseMove}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onWheel={handleWheel}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
          />
          {hasFrame && cursorShape?.png && (
            <img
              src={`data:image/png;base64,${cursorShape.png}`}
              alt=""
              className="rd-remote-cursor"
              draggable={false}
              style={{
                left: `${cursorUi.x * 100}%`,
                top: `${cursorUi.y * 100}%`,
                width: `${cursorShape.w || 32}px`,
                height: `${cursorShape.h || 32}px`,
                marginLeft: `${-(cursorShape.hx || 0)}px`,
                marginTop: `${-(cursorShape.hy || 0)}px`,
              }}
            />
          )}
          {hasFrame && touchMode === 'trackpad' && !cursorShape?.png && (
            <div
              className="virtual-cursor"
              style={{ left: `${cursorUi.x * 100}%`, top: `${cursorUi.y * 100}%` }}
            />
          )}
        </div>
        {ripple && (
          <div
            className="touch-ripple"
            style={{ left: `${ripple.x}px`, top: `${ripple.y}px`, borderColor: ripple.color }}
          />
        )}

        {directKeyboard && (
          <div className="ime-mode-chip" onTouchStart={(e) => e.stopPropagation()}>
            <span>键盘直连中 · 直接在画面上打字，中文输入法也可用，无需点发送</span>
            <button type="button" className="btn-ghost" onClick={blurIme}>
              关闭
            </button>
          </div>
        )}

        {showGuide && (
          <div className="gesture-guide-card" onTouchStart={(e) => e.stopPropagation()}>
            <strong>触控操作指南</strong>
            <p>单指轻点：左键点击 · 长按 / 双指轻点：右键</p>
            <p>单指上下滑：滚轮滚动（放大后拖动平移）</p>
            <p>双指捏合：缩放画面 · 「拖曳」按钮：拖窗口/框选</p>
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setShowGuide(false);
                try {
                  localStorage.setItem('rd_gesture_guide_seen', '1');
                } catch {}
              }}
            >
              知道了
            </button>
          </div>
        )}

        {immersive && (
          <div
            className="floating-orb-wrap"
            onTouchStart={(e) => e.stopPropagation()}
            onMouseDown={(e) => {
              if (directKeyboard) e.preventDefault();
            }}
          >
            {orbOpen && (
              <div className="floating-orb-menu">
                <button
                  type="button"
                  className="dock-btn"
                  onClick={() => {
                    setOrbOpen(false);
                    onToggleImmersive?.();
                  }}
                >
                  展开栏
                </button>
                <button
                  type="button"
                  className={`dock-btn ${touchMode === 'direct' ? 'active' : ''}`}
                  onClick={() => {
                    setTouchMode((m) => (m === 'trackpad' ? 'direct' : 'trackpad'));
                    setDragLock(false);
                  }}
                >
                  {touchMode === 'direct' ? '直触' : '指针'}
                </button>
                <button
                  type="button"
                  className={`dock-btn ${dragLock ? 'active' : ''}`}
                  onClick={() => setDragLock((v) => !v)}
                >
                  {dragLock ? '拖曳中' : '拖曳'}
                </button>
                <button
                  type="button"
                  className="dock-btn"
                  onClick={() => transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'click', button: 'right' })}
                >
                  右键
                </button>
                <button
                  type="button"
                  className="dock-btn"
                  onClick={() => {
                    setOrbOpen(false);
                    focusIme();
                  }}
                >
                  键盘
                </button>
                <button
                  type="button"
                  className="dock-btn"
                  onClick={() => {
                    setOrbOpen(false);
                    onToggleImmersive?.();
                    setShowVirtualKeys(true);
                  }}
                >
                  快捷键
                </button>
                <button
                  type="button"
                  className="dock-btn"
                  onClick={() => {
                    setOrbOpen(false);
                    onToggleImmersive?.();
                    setShowTextBridge(true);
                  }}
                >
                  粘贴
                </button>
                {onDisconnect && (
                  <button type="button" className="btn-danger-ghost" onClick={onDisconnect}>
                    断开
                  </button>
                )}
              </div>
            )}
            <button
              type="button"
              className="floating-orb-btn"
              onClick={() => setOrbOpen((v) => !v)}
              title="快捷悬浮球"
            >
              {orbOpen ? '×' : '球'}
            </button>
          </div>
        )}
      </div>

      {/* Adaptive Touch / Virtual Input Controls (always visible on Phone/Tablet unless immersive) */}
      {!immersive && (tier !== 'desktop' || isTouch || showVirtualKeys || showTextBridge) && (
        <div
          className="touch-dock"
          onMouseDown={(e) => {
            // In direct-keyboard mode, keep focus on the IME sink so tapping a
            // dock button never dismisses the soft keyboard mid-typing.
            if (directKeyboard) e.preventDefault();
          }}
        >
          {showTextBridge && (
            <form className="text-bridge-bar" onSubmit={sendTextToHost}>
              <input
                type="text"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder="粘贴一整段文字后回车，插入到远端光标处（日常打字请用「键盘」按钮）"
              />
              <button type="submit" className="btn-primary">插入</button>
              <button type="button" className="btn-ghost" onClick={() => setShowTextBridge(false)}>收起</button>
            </form>
          )}

          {showVirtualKeys && (
            <div className="virtual-keys-drawer">
              <div className="mod-row">
                {['ctrl', 'alt', 'shift', 'meta'].map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`vkey-btn ${stickyMods[m] ? 'active' : ''}`}
                    onClick={() => toggleSticky(m)}
                  >
                    {m === 'meta' ? 'Win' : m.toUpperCase()}
                  </button>
                ))}
                <button type="button" className="vkey-btn" onClick={() => sendHotkey(0x25)}>←</button>
                <button type="button" className="vkey-btn" onClick={() => sendHotkey(0x26)}>↑</button>
                <button type="button" className="vkey-btn" onClick={() => sendHotkey(0x28)}>↓</button>
                <button type="button" className="vkey-btn" onClick={() => sendHotkey(0x27)}>→</button>
              </div>
              <div className="hotkey-row">
                {QUICK_HOTKEYS.map((hk) => (
                  <button
                    key={hk.id}
                    type="button"
                    className="vkey-btn"
                    onClick={() => sendHotkey(hk.vk, hk.mods)}
                  >
                    {hk.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="dock-toolbar">
            <button
              type="button"
              className={`dock-btn ${touchMode === 'direct' ? 'active' : ''}`}
              onClick={() => {
                setTouchMode((m) => (m === 'trackpad' ? 'direct' : 'trackpad'));
                setDragLock(false);
              }}
            >
              {touchMode === 'direct' ? '直触模式' : '指针模式'}
            </button>

            <button
              type="button"
              className={`dock-btn ${dragLock ? 'active' : ''}`}
              onClick={() => setDragLock((v) => !v)}
            >
              {dragLock ? '拖曳中' : '拖曳'}
            </button>

            <button
              type="button"
              className="dock-btn"
              onClick={() => transport.sendJson({ type: MSG.INPUT_MOUSE, action: 'click', button: 'right' })}
            >
              右键
            </button>

            <button
              type="button"
              className={`dock-btn ${showVirtualKeys ? 'active' : ''}`}
              onClick={() => setShowVirtualKeys((v) => !v)}
            >
              快捷键
            </button>

            <button
              type="button"
              className={`dock-btn ${directKeyboard ? 'active' : ''}`}
              onClick={() => (directKeyboard ? blurIme() : focusIme())}
              title="直接在画面上输入文字与中文（无需点发送）"
            >
              键盘
            </button>

            <button
              type="button"
              className={`dock-btn ${showTextBridge ? 'active' : ''}`}
              onClick={() => setShowTextBridge((v) => !v)}
              title="粘贴一整段文字到远端"
            >
              粘贴
            </button>

            {zoom > 1.02 && (
              <button
                type="button"
                className="dock-btn"
                onClick={() => {
                  zoomRef.current = 1;
                  panRef.current = { x: 0, y: 0 };
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                }}
              >
                重置 {zoom}×
              </button>
            )}

            <button
              type="button"
              className="dock-btn"
              onClick={() => setShowGuide((v) => !v)}
              title="查看触控手势说明"
            >
              手势
            </button>

            {onToggleImmersive && (
              <button
                type="button"
                className="dock-btn"
                onClick={() => {
                  setOrbOpen(false);
                  onToggleImmersive();
                }}
              >
                收起
              </button>
            )}
          </div>
        </div>
      )}

      {tier === 'desktop' && !isTouch && !showVirtualKeys && !showTextBridge && (
        <div
          className="desktop-floating-tools"
          onMouseDown={(e) => {
            if (directKeyboard) e.preventDefault();
          }}
        >
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              const nz = zoomRef.current >= 2 ? 1 : Number((zoomRef.current + 0.5).toFixed(2));
              zoomRef.current = nz;
              setZoom(nz);
              if (nz <= 1.02) {
                panRef.current = { x: 0, y: 0 };
                setPan({ x: 0, y: 0 });
              }
            }}
            title="Ctrl+滚轮缩放视口（放大自动启用超清 ROI）"
          >
            {zoom > 1.02 ? `${zoom}×` : '放大'}
          </button>
          <button type="button" className="btn-ghost" onClick={() => focusIme()} title="直接在画面上输入文字">
            键盘
          </button>
          <button type="button" className="btn-ghost" onClick={() => setShowVirtualKeys(true)}>
            组合键
          </button>
          <button type="button" className="btn-ghost" onClick={() => setShowTextBridge(true)}>
            粘贴文本
          </button>
        </div>
      )}
    </div>
  );
}
