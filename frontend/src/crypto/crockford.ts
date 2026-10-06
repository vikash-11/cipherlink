// Crockford Base32 implementation for human-readable cryptographic IDs
// Alphabet excludes I, L, O, U to prevent visual confusion and offensive words.

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Encode an ArrayBuffer or Uint8Array into a Crockford Base32 string.
 */
export function encodeCrockford(bytes: Uint8Array, targetLength = 12): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;

    while (bits >= 5) {
      output += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
      if (output.length === targetLength) {
        return output;
      }
    }
  }

  if (bits > 0 && output.length < targetLength) {
    output += CROCKFORD_ALPHABET[(value << (5 - bits)) & 31];
  }

  while (output.length < targetLength) {
    output += '0';
  }

  return output.slice(0, targetLength);
}

/**
 * Format a 12-char Crockford ID into grouped chunks: XXXX-XXXX-XXXX
 */
export function formatId(rawId: string): string {
  const clean = rawId.toUpperCase().replace(/[^0-9A-Z]/g, '');
  const parts: string[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    parts.push(clean.slice(i, i + 4));
  }
  return parts.join('-');
}

/**
 * Normalize and validate an entered ID (removes dashes, uppercase, converts aliases I/L->1, O->0).
 */
export function normalizeId(input: string): string {
  return input
    .toUpperCase()
    .replace(/-/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .trim();
}

/**
 * Validate that an ID has exactly 12 Crockford Base32 characters.
 */
export function isValidId(input: string): boolean {
  const norm = normalizeId(input);
  if (norm.length !== 12) return false;
  return /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/.test(norm);
}
