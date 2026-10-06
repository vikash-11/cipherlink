// Peer-to-Peer Encrypted File Transfer (Phase 5)
// Chunks files into 16KB blocks, encrypts each chunk with AES-256-GCM,
// transmits reliably via sequence numbers, and verifies SHA-256 checksum on reassembly.

import { encryptPayload, decryptPayload } from '../crypto/session';
import type { ReliableTransport } from './reliableTransport';
import type { TransportPacket, FileTransferState } from './types';
import { bufferToHex } from '../crypto/identity';

export const CHUNK_SIZE = 16 * 1024; // 16 KB chunks

export interface FileMetadata {
  fileId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  totalChunks: number;
  checksum: string;
}

export class FileTransferManager {
  private reliableTransport: ReliableTransport;
  private sessionKey: CryptoKey;
  private activeTransfers = new Map<
    string,
    {
      meta: FileMetadata;
      chunks: Map<number, Uint8Array>;
      isIncoming: boolean;
      status: 'transferring' | 'verifying' | 'completed' | 'failed';
    }
  >();

  private onProgressCallback?: (state: FileTransferState) => void;

  constructor(reliableTransport: ReliableTransport, sessionKey: CryptoKey) {
    this.reliableTransport = reliableTransport;
    this.sessionKey = sessionKey;
  }

  public setOnProgress(cb: (state: FileTransferState) => void) {
    this.onProgressCallback = cb;
  }

  /**
   * Calculates SHA-256 checksum of an entire file ArrayBuffer
   */
  public static async computeFileChecksum(buffer: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return bufferToHex(hashBuffer);
  }

  /**
   * Chunks, encrypts, and sends a file over the reliable transport channel.
   */
  public async sendFile(file: File): Promise<string> {
    const fileId = 'file-' + Math.random().toString(36).substring(2, 10);
    const arrayBuffer = await file.arrayBuffer();
    const checksum = await FileTransferManager.computeFileChecksum(arrayBuffer);
    const totalChunks = Math.ceil(arrayBuffer.byteLength / CHUNK_SIZE);

    const meta: FileMetadata = {
      fileId,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || 'application/octet-stream',
      totalChunks,
      checksum,
    };

    this.activeTransfers.set(fileId, {
      meta,
      chunks: new Map(),
      isIncoming: false,
      status: 'transferring',
    });

    this.emitProgress(fileId, 0);

    // Read and dispatch chunks sequentially
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, arrayBuffer.byteLength);
      const chunkBytes = new Uint8Array(arrayBuffer.slice(start, end));

      // Encrypt chunk individually with AES-GCM
      const encryptedChunk = await encryptPayload(this.sessionKey, chunkBytes);

      // Transmit through reliable transport
      this.reliableTransport.send({
        type: 'FILE_CHUNK',
        payload: encryptedChunk,
        chunkMeta: {
          fileId,
          chunkIndex: i,
          totalChunks,
          checksum,
          fileName: meta.fileName,
          fileType: meta.fileType,
          fileSize: meta.fileSize,
        },
      });

      this.emitProgress(fileId, ((i + 1) / totalChunks) * 100);

      // Brief yield to avoid starving the main event loop
      if (i % 8 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    const rec = this.activeTransfers.get(fileId);
    if (rec) rec.status = 'completed';
    this.emitProgress(fileId, 100);

    return fileId;
  }

  /**
   * Processes an incoming encrypted FILE_CHUNK packet.
   */
  public async handleIncomingChunk(packet: TransportPacket): Promise<void> {
    if (!packet.chunkMeta || !packet.payload) return;

    const { fileId, chunkIndex, totalChunks, checksum, fileName, fileType, fileSize } = packet.chunkMeta;

    let transfer = this.activeTransfers.get(fileId);
    if (!transfer) {
      transfer = {
        meta: {
          fileId,
          fileName: fileName || `file_${fileId.slice(-6)}`,
          fileSize: fileSize ?? totalChunks * CHUNK_SIZE,
          fileType: fileType || 'application/octet-stream',
          totalChunks,
          checksum,
        },
        chunks: new Map(),
        isIncoming: true,
        status: 'transferring',
      };
      this.activeTransfers.set(fileId, transfer);
    }

    // Decrypt the chunk
    try {
      const decryptedBytes = await decryptPayload(this.sessionKey, packet.payload);
      transfer.chunks.set(chunkIndex, decryptedBytes);

      const progress = (transfer.chunks.size / totalChunks) * 100;
      this.emitProgress(fileId, progress);

      // Check if all chunks have arrived
      if (transfer.chunks.size === totalChunks) {
        transfer.status = 'verifying';
        this.emitProgress(fileId, 100);

        // Reassemble file buffer in order
        let totalLength = 0;
        for (let i = 0; i < totalChunks; i++) {
          totalLength += transfer.chunks.get(i)!.byteLength;
        }

        const assembledBuffer = new Uint8Array(totalLength);
        let offset = 0;
        for (let i = 0; i < totalChunks; i++) {
          const chunk = transfer.chunks.get(i)!;
          assembledBuffer.set(chunk, offset);
          offset += chunk.byteLength;
        }

        // Verify SHA-256 Checksum
        const computedChecksum = await FileTransferManager.computeFileChecksum(assembledBuffer.buffer);
        if (computedChecksum.toLowerCase() !== checksum.toLowerCase()) {
          transfer.status = 'failed';
          this.emitProgress(fileId, 100, undefined, 'Checksum verification failed! File corrupted.');
          return;
        }

        // Create Blob URL for download
        const blob = new Blob([assembledBuffer], { type: transfer.meta.fileType });
        const blobUrl = URL.createObjectURL(blob);

        transfer.status = 'completed';
        this.emitProgress(fileId, 100, blobUrl);
      }
    } catch (err: any) {
      console.error('Failed to decrypt file chunk', chunkIndex, err);
    }
  }

  private emitProgress(
    fileId: string,
    percent: number,
    blobUrl?: string,
    errorMsg?: string
  ) {
    const t = this.activeTransfers.get(fileId);
    if (!t || !this.onProgressCallback) return;

    this.onProgressCallback({
      fileId,
      fileName: t.meta.fileName,
      fileSize: t.meta.fileSize,
      fileType: t.meta.fileType,
      totalChunks: t.meta.totalChunks,
      receivedChunks: t.chunks.size,
      progressPercent: Math.round(percent),
      sha256Checksum: t.meta.checksum,
      status: t.status,
      isIncoming: t.isIncoming,
      blobUrl,
    });
  }
}
