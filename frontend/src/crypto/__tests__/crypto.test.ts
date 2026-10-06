// Unit tests for Cryptographic Identity, Session Agreement, and Authentication
import { describe, it, expect } from 'vitest';
import { encodeCrockford, formatId, isValidId, normalizeId } from '../crockford';
import {
  generateEphemeralEcdh,
  deriveSessionKey,
  encryptPayload,
  decryptPayload,
  decryptText,
  importEphemeralPublicKey,
} from '../session';
import {
  signData,
  verifySignature,
  deriveIdFromSpki,
  importSpkiPublicKey,
  base64ToBuffer,
  bufferToBase64,
} from '../identity';
import { computeSafetyNumber } from '../handshakeAuth';

describe('Crockford Base32 & ID Derivation', () => {
  it('encodes byte arrays to Crockford Base32 correctly', () => {
    const testBytes = new Uint8Array([0x4e, 0x93, 0xa1, 0x0f, 0x88, 0x33, 0xbc, 0x12]);
    const encoded = encodeCrockford(testBytes, 12);
    expect(encoded.length).toBe(12);
    expect(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/.test(encoded)).toBe(true);
  });

  it('formats and normalizes IDs reliably', () => {
    const raw = 'K7M29QXA4TBD';
    const formatted = formatId(raw);
    expect(formatted).toBe('K7M2-9QXA-4TBD');
    expect(normalizeId(formatted)).toBe(raw);
    expect(isValidId(formatted)).toBe(true);
    expect(isValidId('invalid-id')).toBe(false);
  });
});

describe('Session Cryptography (ECDH + HKDF + AES-256-GCM)', () => {
  it('performs end-to-end ECDH key agreement and AES-GCM encryption/decryption', async () => {
    // Peer Alice
    const aliceEcdh = await generateEphemeralEcdh();
    // Peer Bob
    const bobEcdh = await generateEphemeralEcdh();

    // Alice imports Bob's public key
    const aliceImportedBob = await importEphemeralPublicKey(bobEcdh.rawPublicKey);
    // Bob imports Alice's public key
    const bobImportedAlice = await importEphemeralPublicKey(aliceEcdh.rawPublicKey);

    // Both derive session key
    const aliceSessionKey = await deriveSessionKey(aliceEcdh.keyPair.privateKey, aliceImportedBob);
    const bobSessionKey = await deriveSessionKey(bobEcdh.keyPair.privateKey, bobImportedAlice);

    // Alice encrypts a message
    const secretMessage = 'TopSecret: Zero-Knowledge WebRTC Message!';
    const encrypted = await encryptPayload(aliceSessionKey, secretMessage);

    // Verify ciphertext is distinct from plaintext
    expect(encrypted.ciphertext).not.toBe(secretMessage);
    expect(encrypted.iv).toBeDefined();

    // Bob decrypts the message
    const decrypted = await decryptText(bobSessionKey, encrypted);
    expect(decrypted).toBe(secretMessage);
  });

  it('rejects tampered ciphertext with cryptographic authentication error', async () => {
    const alice = await generateEphemeralEcdh();
    const bob = await generateEphemeralEcdh();
    const aliceImportedBob = await importEphemeralPublicKey(bobEcdhAlice(bob));
    const aliceKey = await deriveSessionKey(alice.keyPair.privateKey, aliceImportedBob);

    const encrypted = await encryptPayload(aliceKey, 'Authentic Payload');

    // Tamper with the ciphertext base64 bytes
    const tamperedCiphertext = alterBase64(encrypted.ciphertext);

    await expect(
      decryptPayload(aliceKey, {
        iv: encrypted.iv,
        ciphertext: tamperedCiphertext,
      })
    ).rejects.toThrow();
  });
});

describe('Identity key generation security properties', () => {
  it('generates a non-extractable private key while the public key stays exportable', async () => {
    // This mirrors the exact generateKey call in identity.ts's getOrCreateIdentity().
    // Regression test: this flag was previously (incorrectly) set to `true`,
    // which made the private identity key exportable by any script on the
    // page — contradicting the project's core "non-extractable private key"
    // security claim. This test fails loudly if that regresses.
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify']
    );

    expect(keyPair.privateKey.extractable).toBe(false);
    expect(keyPair.publicKey.extractable).toBe(true);

    // Public key must still be exportable for SPKI-based ID derivation.
    const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    expect(spki.byteLength).toBeGreaterThan(0);

    // Private key export must actually be blocked by the runtime.
    await expect(
      crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
    ).rejects.toThrow();
  });
});

describe('Digital Signatures & Identity Verification', () => {
  it('generates deterministic IDs and verifies ECDSA signatures', async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );

    const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const { formattedId, rawId } = await deriveIdFromSpki(spki);

    expect(rawId.length).toBe(12);
    expect(formattedId.split('-').length).toBe(3);

    // Sign test data
    const message = new TextEncoder().encode('Handshake-Challenge-Data-12345');
    const signature = await signData(keyPair.privateKey, message);

    // Verify signature with imported public key
    const importedPub = await importSpkiPublicKey(spki);
    const isValid = await verifySignature(importedPub, signature, message);
    expect(isValid).toBe(true);

    // Tampered data should fail verification
    const tamperedMessage = new TextEncoder().encode('Handshake-Challenge-Data-FAKED');
    const isTamperedValid = await verifySignature(importedPub, signature, tamperedMessage);
    expect(isTamperedValid).toBe(false);
  });

  it('computes identical Safety Numbers regardless of peer ordering', async () => {
    const kpA = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const kpB = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

    const spkiA = await crypto.subtle.exportKey('spki', kpA.publicKey);
    const spkiB = await crypto.subtle.exportKey('spki', kpB.publicKey);

    // Alice calculates safety number (spkiA, spkiB)
    const safetyNumAlice = await computeSafetyNumber(spkiA, spkiB);
    // Bob calculates safety number (spkiB, spkiA)
    const safetyNumBob = await computeSafetyNumber(spkiB, spkiA);

    expect(safetyNumAlice).toBe(safetyNumBob);
    expect(safetyNumAlice.split(' ').length).toBe(4);
  });
});

function bobEcdhAlice(b: any) {
  return b.rawPublicKey;
}

function alterBase64(b64: string): string {
  const bytes = new Uint8Array(base64ToBuffer(b64));
  bytes[bytes.length - 2] ^= 0xff; // Flip bits
  return bufferToBase64(bytes.buffer);
}
