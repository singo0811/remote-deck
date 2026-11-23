import { useEffect, useState } from 'react';

export function detectDeviceEnvironment(override = 'auto') {
  const width = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const height = typeof window !== 'undefined' ? window.innerHeight : 800;
  const isCoarsePointer = typeof window !== 'undefined'
    ? window.matchMedia?.('(pointer: coarse)').matches ?? false
    : false;
  const isTouch = typeof navigator !== 'undefined'
    ? (navigator.maxTouchPoints || 0) > 0 || isCoarsePointer
    : false;
  const isLandscape = width > height;

  let detectedTier = 'desktop';
  if (width <= 720 || (isCoarsePointer && isLandscape && height <= 500)) {
    detectedTier = 'phone';
  } else if (width <= 1024 || (isCoarsePointer && width <= 1180)) {
    detectedTier = 'tablet';
  }

  const tier = override && override !== 'auto' ? override : detectedTier;
  return {
    tier,
    detectedTier,
    width,
    height,
    isCoarsePointer,
    isTouch,
    isLandscape,
  };
}

export function useDeviceEnvironment(override = 'auto') {
  const [env, setEnv] = useState(() => detectDeviceEnvironment(override));

  useEffect(() => {
    const update = () => setEnv(detectDeviceEnvironment(override));
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, [override]);

  return env;
}
