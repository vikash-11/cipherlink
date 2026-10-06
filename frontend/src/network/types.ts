// Protocol Types for CipherLink End-to-End P2P System

import type { EncryptedPayload } from '../crypto/session';

export type PacketType = 'DATA' | 'ACK' | 'HEARTBEAT' | 'FILE_CHUNK';

export interface TransportPacket {
  type: PacketType;
  seq?: number; // Sequence number for DATA and FILE_CHUNK
  ackSeq?: number; // Acknowledged sequence number
  timestamp: number; // For RTT calculation
  payload?: EncryptedPayload; // Used by DATA packets
  chunkMeta?: {
    fileId: string;
    chunkIndex: number;
    totalChunks: number;
    checksum: string;
    fileName: string;
    fileType: string;
    fileSize: number;
  };
}

export interface NetworkMetrics {
  packetsSent: number;
  packetsReceived: number;
  packetsAcked: number;
  retransmissions: number;
  duplicatesDropped: number;
  outOfOrderReordered: number;
  rttMs: number;
  simulatedLossRate: number; // 0.0 to 0.8 (0% to 80%)
}

export interface ChatMessage {
  id: string;
  seq: number;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: number;
  isSelf: boolean;
  status: 'sending' | 'sent' | 'delivered' | 'failed';
  retransmits: number;
  rtt?: number;
}

export interface FileTransferState {
  fileId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  totalChunks: number;
  receivedChunks: number;
  progressPercent: number;
  sha256Checksum: string;
  status: 'transferring' | 'completed' | 'verifying' | 'failed';
  isIncoming: boolean;
  blobUrl?: string;
}

export type ConnectionStatus =
  | 'disconnected'
  | 'signaling'
  | 'authenticating'
  | 'connected'
  | 'rejected'
  | 'failed';
