// ============================================================
// Inbound webhook HMAC verification — pure, server-side.
//
// Lead providers sign their deliveries with a per-source secret we
// issue at source-creation time. We accept the two common wire
// formats:
//
//   X-Signature: sha256=<hex>        (Justdial / generic)
//   X-Signature: <hex>                (bare hex)
//
// The signed message is the raw request body bytes — never a
// re-serialized copy — and the compare is constant-time.
// ============================================================

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Verify `header` (either `sha256=<hex>` or bare `<hex>`) against
 * `rawBody` using `secret`. Returns false on any malformed input.
 */
export function verifyInboundHmac(
  header: string | null,
  rawBody: string,
  secret: string,
): boolean {
  if (!header || !secret) return false;
  const presented = header.startsWith('sha256=')
    ? header.slice('sha256='.length).trim().toLowerCase()
    : header.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(presented)) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
}

/**
 * Generate a new per-source secret (64 hex chars = 256 bits).
 * Returned to the creator exactly once; stored encrypted.
 */
export function generateSourceSecret(): string {
  return randomBytes(32).toString('hex');
}
