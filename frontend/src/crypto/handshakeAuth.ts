// Mutual Handshake Authentication & Anti-MITM Channel Hardening
// Implements bilateral challenge-response, identity key verification,
// DTLS fingerprint signature binding, and Signal-style Safety Number derivation.

import {
  signData,
  verifySignature,
  importSpkiPublicKey,
  deriveIdFromSpki,
  bufferToBase64,
  base64ToBuffer,
  type UserIdentity,
} from './identity';

export interface HandshakeHello {
  type: 'HANDSHAKE_HELLO';
  senderId: string;
  identitySpkiBase64: string;
  ephemeralEcdhRawBase64: string;
  challengeBase64: string;
  dtlsFingerprint?: string;
}

export interface HandshakeResponse {
  type: 'HANDSHAKE_RESPONSE';
  senderId: string;
  identitySpkiBase64: string;
  ephemeralEcdhRawBase64: string;
  challengeBase64: string;
  signatureBase64: string;
  dtlsFingerprint?: string;
}

export interface HandshakeConfirm {
  type: 'HANDSHAKE_CONFIRM';
  signatureBase64: string;
}

/**
 * Creates a 32-byte cryptographically secure random challenge
 */
export function generateChallenge(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Constructs the canonical binary transcript buffer to sign during handshake.
 * Transcript includes: peer's challenge + local identity SPKI + local ephemeral ECDH + DTLS fingerprint + context string
 */
export function buildTranscriptToSign(
  challenge: Uint8Array,
  localIdentitySpki: ArrayBuffer,
  localEphemeralRaw: ArrayBuffer,
  dtlsFingerprint = ''
): ArrayBuffer {
  const context = new TextEncoder().encode('CipherLink-Handshake-Auth-v1:' + dtlsFingerprint);
  const totalLength = challenge.byteLength + localIdentitySpki.byteLength + localEphemeralRaw.byteLength + context.byteLength;
  const buffer = new Uint8Array(totalLength);

  let offset = 0;
  buffer.set(challenge, offset);
  offset += challenge.byteLength;

  buffer.set(new Uint8Array(localIdentitySpki), offset);
  offset += localIdentitySpki.byteLength;

  buffer.set(new Uint8Array(localEphemeralRaw), offset);
  offset += localEphemeralRaw.byteLength;

  buffer.set(context, offset);

  return buffer.buffer;
}

/**
 * Signs the challenge transcript with the local identity private key.
 */
export async function signHandshakeChallenge(
  identity: UserIdentity,
  remoteChallenge: Uint8Array,
  localEphemeralRaw: ArrayBuffer,
  dtlsFingerprint = ''
): Promise<string> {
  const transcript = buildTranscriptToSign(
    remoteChallenge,
    identity.publicKeySpki,
    localEphemeralRaw,
    dtlsFingerprint
  );
  const signature = await signData(identity.keyPair.privateKey, transcript);
  return bufferToBase64(signature);
}

/**
 * Verifies that:
 * 1. The remote identity public key hashes to the dialed/expected ID.
 * 2. The remote signature correctly signs (our challenge + their keys + DTLS fingerprint).
 */
export async function verifyHandshakeResponse(params: {
  expectedId: string;
  remoteIdentitySpkiBase64: string;
  remoteEphemeralRawBase64: string;
  localChallenge: Uint8Array;
  signatureBase64: string;
  dtlsFingerprint?: string;
}): Promise<{ valid: boolean; reason?: string }> {
  try {
    const spkiBuffer = base64ToBuffer(params.remoteIdentitySpkiBase64);
    const { formattedId, rawId } = await deriveIdFromSpki(spkiBuffer);

    // Verify Dialed ID match
    const cleanExpected = params.expectedId.replace(/-/g, '').toUpperCase();
    if (rawId !== cleanExpected && formattedId !== params.expectedId) {
      return {
        valid: false,
        reason: `Identity mismatch: Dialed ID ${params.expectedId} does not match public key hash ${formattedId}`,
      };
    }

    const remotePubKey = await importSpkiPublicKey(spkiBuffer);
    const ephemeralRaw = base64ToBuffer(params.remoteEphemeralRawBase64);
    const signature = base64ToBuffer(params.signatureBase64);

    const transcript = buildTranscriptToSign(
      params.localChallenge,
      spkiBuffer,
      ephemeralRaw,
      params.dtlsFingerprint || ''
    );

    const isValidSig = await verifySignature(remotePubKey, signature, transcript);
    if (!isValidSig) {
      return {
        valid: false,
        reason: 'Cryptographic signature verification failed! Possible MITM attack.',
      };
    }

    return { valid: true };
  } catch (err: any) {
    return { valid: false, reason: `Verification error: ${err.message}` };
  }
}

/**
 * Computes a Signal-style Safety Number (SAS) for out-of-band visual verification.
 * Deterministically combines sorted identity SPKIs and generates formatted 12-digit number (e.g. 84210 59281 37190).
 */
export async function computeSafetyNumber(
  localSpki: ArrayBuffer,
  remoteSpki: ArrayBuffer
): Promise<string> {
  const localBase64 = bufferToBase64(localSpki);
  const remoteBase64 = bufferToBase64(remoteSpki);

  // Lexicographically sort to ensure both sides compute the exact same number regardless of who initiated
  const sorted = [localBase64, remoteBase64].sort();
  const combined = new TextEncoder().encode(`CipherLink-SafetyNumber:${sorted[0]}:${sorted[1]}`);

  const hashBuffer = await crypto.subtle.digest('SHA-512', combined);
  const hashBytes = new Uint8Array(hashBuffer);

  // Generate 6 blocks of 5 digits = 30 digits (or 3 blocks of 5 digits = 15 digits)
  const blocks: string[] = [];
  for (let i = 0; i < 4; i++) {
    // Take 4 bytes per block and modulo 100000
    const val =
      ((hashBytes[i * 4] << 24) |
        (hashBytes[i * 4 + 1] << 16) |
        (hashBytes[i * 4 + 2] << 8) |
        hashBytes[i * 4 + 3]) >>>
      0;
    blocks.push((val % 100000).toString().padStart(5, '0'));
  }

  return blocks.join(' ');
}
