// Ephemeral Session Key Exchange and AES-256-GCM Packet Encryption
// Uses ECDH (P-256) + HKDF-SHA256 key derivation with fresh 96-bit random IV per message.

import { bufferToBase64, base64ToBuffer } from './identity';

export interface EphemeralKeyPair {
  keyPair: CryptoKeyPair;
  rawPublicKey: ArrayBuffer;
  base64PublicKey: string;
}

export interface EncryptedPayload {
  iv: string; // Base64 12-byte IV
  ciphertext: string; // Base64 ciphertext + GCM tag
}

/**
 * Generates an ephemeral ECDH key pair for forward-secret session key agreement.
 */
export async function generateEphemeralEcdh(): Promise<EphemeralKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true,
    ['deriveKey', 'deriveBits']
  );

  const rawPublicKey = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const base64PublicKey = bufferToBase64(rawPublicKey);

  return { keyPair, rawPublicKey, base64PublicKey };
}

/**
 * Imports an external ephemeral public key (raw 65-byte uncompressed P-256 point).
 */
export async function importEphemeralPublicKey(rawBytes: ArrayBuffer): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    rawBytes,
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true,
    []
  );
}

/**
 * Derives a shared 256-bit AES-GCM session key using ECDH + HKDF-SHA256.
 * Incorporates a salt and info string for domain separation.
 */
export async function deriveSessionKey(
  localPrivateKey: CryptoKey,
  remotePublicKey: CryptoKey,
  saltStr = 'CipherLink-Handshake-v1',
  infoStr = 'AES-256-GCM-SessionKey'
): Promise<CryptoKey> {
  // Step 1: Derive shared secret bits via ECDH
  const sharedBits = await crypto.subtle.deriveBits(
    {
      name: 'ECDH',
      public: remotePublicKey,
    },
    localPrivateKey,
    256
  );

  // Step 2: Import shared secret into HKDF
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    sharedBits,
    { name: 'HKDF' },
    false,
    ['deriveKey']
  );

  const encoder = new TextEncoder();
  const salt = encoder.encode(saltStr);
  const info = encoder.encode(infoStr);

  // Step 3: Derive AES-GCM 256-bit key using HKDF-SHA256
  return await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info,
    },
    hkdfKey,
    {
      name: 'AES-GCM',
      length: 256,
    },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts arbitrary text or data with AES-256-GCM using a fresh 12-byte random IV.
 */
export async function encryptPayload(
  sessionKey: CryptoKey,
  plaintext: string | Uint8Array
): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = typeof plaintext === 'string'
    ? new TextEncoder().encode(plaintext)
    : plaintext;

  const ciphertextBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    sessionKey,
    data
  );

  return {
    iv: bufferToBase64(iv.buffer),
    ciphertext: bufferToBase64(ciphertextBuffer),
  };
}

/**
 * Decrypts an AES-256-GCM encrypted payload. Throws if authentication tag or ciphertext is tampered.
 */
export async function decryptPayload(
  sessionKey: CryptoKey,
  payload: EncryptedPayload
): Promise<Uint8Array> {
  const ivBuffer = base64ToBuffer(payload.iv);
  const ciphertextBuffer = base64ToBuffer(payload.ciphertext);

  const decryptedBuffer = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: new Uint8Array(ivBuffer),
    },
    sessionKey,
    ciphertextBuffer
  );

  return new Uint8Array(decryptedBuffer);
}

/**
 * Convenience helper to decrypt payload directly to string.
 */
export async function decryptText(
  sessionKey: CryptoKey,
  payload: EncryptedPayload
): Promise<string> {
  const bytes = await decryptPayload(sessionKey, payload);
  return new TextDecoder().decode(bytes);
}
