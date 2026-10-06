// Cryptographic Identity Layer using Web Crypto API and IndexedDB
// Implements ECDSA P-256 identity key pair with non-extractable private keys
// and deterministic Crockford Base32 ID derivation from SHA-256(SPKI).

import { openDB, type IDBPDatabase } from 'idb';
import { encodeCrockford, formatId } from './crockford';

const DB_NAME = 'CipherLink_Keystore';
const DB_VERSION = 1;
const STORE_NAME = 'identity_keys';
const IDENTITY_RECORD_KEY = 'user_identity';

export interface UserIdentity {
  id: string; // Formatted 12-char ID, e.g. K7M2-9QXA-4TBD
  rawId: string; // 12-char unformatted ID
  fingerprint: string; // Full SHA-256 hex fingerprint
  publicKeySpki: ArrayBuffer; // Exported SPKI for public key sharing
  publicKeyBase64: string; // Base64 SPKI
  keyPair: CryptoKeyPair; // CryptoKey pair (private key is non-extractable)
  createdAt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Converts ArrayBuffer to Base64
 */
export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Converts Base64 to ArrayBuffer
 */
export function base64ToBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Converts ArrayBuffer to formatted hex string
 */
export function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Deterministically derives the 12-char Crockford ID and SHA-256 fingerprint from an SPKI ArrayBuffer.
 */
export async function deriveIdFromSpki(spkiBuffer: ArrayBuffer): Promise<{
  rawId: string;
  formattedId: string;
  fingerprint: string;
}> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', spkiBuffer);
  const hashBytes = new Uint8Array(hashBuffer);

  const rawId = encodeCrockford(hashBytes, 12);
  const formattedId = formatId(rawId);
  const fingerprint = bufferToHex(hashBuffer);

  return { rawId, formattedId, fingerprint };
}

/**
 * Initializes or loads the cryptographic identity from IndexedDB.
 * Generates an ECDSA P-256 keypair on first run, marked as non-extractable for private key.
 */
export async function getOrCreateIdentity(): Promise<UserIdentity> {
  const db = await getDb();
  const existing = await db.get(STORE_NAME, IDENTITY_RECORD_KEY);

  if (existing && existing.keyPair?.privateKey && existing.keyPair?.publicKey) {
    try {
      const spki = await crypto.subtle.exportKey('spki', existing.keyPair.publicKey);
      const { rawId, formattedId, fingerprint } = await deriveIdFromSpki(spki);
      return {
        id: formattedId,
        rawId,
        fingerprint,
        publicKeySpki: spki,
        publicKeyBase64: bufferToBase64(spki),
        keyPair: existing.keyPair,
        createdAt: existing.createdAt || Date.now(),
      };
    } catch {
      // Key may have been invalid, regenerate
    }
  }

  // Generate fresh ECDSA P-256 key pair
  // Private key is strictly NON-EXTRACTABLE (false) for browser security
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    // false here correctly makes the PRIVATE key non-extractable.
    // Per the Web Crypto spec, the public key of a generated key pair is
    // always extractable regardless of this flag (it's not sensitive data),
    // so SPKI export below for ID derivation / sharing with peers still
    // works correctly — verified empirically, not just from the spec text.
    false,
    ['sign', 'verify']
  );

  // Export SPKI of public key to derive ID
  const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
  const { rawId, formattedId, fingerprint } = await deriveIdFromSpki(spki);

  const record = {
    keyPair,
    createdAt: Date.now(),
  };

  await db.put(STORE_NAME, record, IDENTITY_RECORD_KEY);

  return {
    id: formattedId,
    rawId,
    fingerprint,
    publicKeySpki: spki,
    publicKeyBase64: bufferToBase64(spki),
    keyPair,
    createdAt: record.createdAt,
  };
}

/**
 * Reset identity (for testing or user privacy reset)
 */
export async function resetIdentity(): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_NAME, IDENTITY_RECORD_KEY);
}

/**
 * Signs arbitrary data using the identity's private key.
 */
export async function signData(privateKey: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
  return await crypto.subtle.sign(
    {
      name: 'ECDSA',
      hash: { name: 'SHA-256' },
    },
    privateKey,
    data
  );
}

/**
 * Verifies a digital signature against an SPKI public key.
 */
export async function verifySignature(
  publicKey: CryptoKey,
  signature: ArrayBuffer,
  data: ArrayBuffer
): Promise<boolean> {
  return await crypto.subtle.verify(
    {
      name: 'ECDSA',
      hash: { name: 'SHA-256' },
    },
    publicKey,
    signature,
    data
  );
}

/**
 * Imports an external SPKI ArrayBuffer into an ECDSA CryptoKey for verification.
 */
export async function importSpkiPublicKey(spkiBuffer: ArrayBuffer): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'spki',
    spkiBuffer,
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['verify']
  );
}
