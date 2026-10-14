// Referral codes — one unique code per contact, auto-generated.
//
// Codes are 8 characters from an unambiguous alphabet (no 0/O,
// 1/I/L) so they survive being read aloud or retyped from a
// screenshot. Uniqueness is enforced per account by the DB unique
// index; generation retries on collision.

import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const REFERRAL_CODE_LENGTH = 8;

/** Generate a random referral code (not guaranteed unique — the
 *  caller retries on unique-violation). */
export function generateReferralCode(): string {
  const bytes = randomBytes(REFERRAL_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return code;
}

/** Normalize a user-supplied code for lookup (uppercase, trimmed). */
export function normalizeReferralCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = code.trim().toUpperCase();
  return /^[A-Z2-9]{4,16}$/.test(c) ? c : null;
}
