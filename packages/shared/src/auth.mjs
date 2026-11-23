import crypto from 'node:crypto';

/**
 * Generate a readable device ID such as "RD-4829-7310".
 */
export function generateDeviceId() {
  const a = crypto.randomInt(1000, 10000);
  const b = crypto.randomInt(1000, 10000);
  return `RD-${a}-${b}`;
}

/**
 * Generate an easy-to-type pairing PIN (default 8 chars, excluding ambiguous 0/O/1/I).
 */
export function generatePairingPin(length = 8) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return out;
}

export function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Compute HMAC-SHA256 proof for challenge-response auth without sending secret over wire.
 */
export function computeChallengeProof(secret, nonce, deviceId) {
  return crypto
    .createHmac('sha256', String(secret))
    .update(`${deviceId}:${nonce}`)
    .digest('hex');
}

export function verifyChallengeProof(secret, nonce, deviceId, providedProof) {
  if (!secret || !nonce || !deviceId || typeof providedProof !== 'string') {
    return false;
  }
  const expected = computeChallengeProof(secret, nonce, deviceId);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(providedProof.trim().toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Hash a secret for relay/device registration lookup without storing raw PIN on relay.
 */
export function hashDeviceSecret(secret, deviceId) {
  return crypto
    .createHmac('sha256', `remote-deck-device:${deviceId}`)
    .update(String(secret))
    .digest('hex');
}

/**
 * Derive a salted scrypt digest for long-term fixed access passwords.
 */
export function hashFixedPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const clean = String(password || '');
  if (!clean) return '';
  const derived = crypto.scryptSync(clean, salt, 32).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyFixedPassword(password, stored) {
  if (!password || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, expectedHex] = stored.split(':', 2);
  if (!salt || !expectedHex) return false;
  const derived = crypto.scryptSync(String(password), salt, 32);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Sign a short-lived session token (URL-safe base64 payload + HMAC signature).
 */
export function signSessionToken(payload, signingKey, ttlMs = 3600_000) {
  const full = {
    ...payload,
    iat: Date.now(),
    exp: Date.now() + ttlMs,
  };
  const encoded = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', String(signingKey))
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySessionToken(token, signingKey) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.', 2);
  if (!encoded || !sig) return null;
  const expected = crypto
    .createHmac('sha256', String(signingKey))
    .update(encoded)
    .digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.exp !== 'number' || Date.now() > parsed.exp) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
