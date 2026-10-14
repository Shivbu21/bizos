import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { generateSourceSecret, verifyInboundHmac } from './hmac';

const SECRET = 'test-secret-123';

function signed(body: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
}

describe('verifyInboundHmac', () => {
  it('accepts a valid sha256= header', () => {
    const body = '{"name":"Asha"}';
    expect(verifyInboundHmac(signed(body), body, SECRET)).toBe(true);
  });

  it('accepts a bare hex header', () => {
    const body = '{"name":"Asha"}';
    const bare = signed(body).slice('sha256='.length);
    expect(verifyInboundHmac(bare, body, SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = '{"name":"Asha"}';
    expect(verifyInboundHmac(signed(body), '{"name":"Bob"}', SECRET)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const body = '{"name":"Asha"}';
    expect(verifyInboundHmac(signed(body), body, 'wrong-secret')).toBe(false);
  });

  it('rejects malformed headers', () => {
    expect(verifyInboundHmac(null, 'x', SECRET)).toBe(false);
    expect(verifyInboundHmac('', 'x', SECRET)).toBe(false);
    expect(verifyInboundHmac('sha256=zzz', 'x', SECRET)).toBe(false);
    expect(verifyInboundHmac('not-hex-at-all', 'x', SECRET)).toBe(false);
  });

  it('rejects when the secret is empty', () => {
    const body = 'x';
    expect(verifyInboundHmac(signed(body), body, '')).toBe(false);
  });
});

describe('generateSourceSecret', () => {
  it('generates 64 hex chars', () => {
    expect(generateSourceSecret()).toMatch(/^[0-9a-f]{64}$/);
  });
});
