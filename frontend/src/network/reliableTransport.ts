// Custom Reliable Transport Protocol over Unreliable WebRTC Data Channels
// Implements Go-Back-N / Selective Repeat hybrid with monotonic sequence numbers,
// explicit acknowledgements (ACKs), dynamic RTO with exponential backoff,
// receiver playout/reordering buffer, duplicate filtering, and real-time telemetry.

import type { TransportPacket, NetworkMetrics } from './types';

interface PendingPacket {
  packet: TransportPacket;
  timestamp: number;
  retries: number;
  rtoMs: number;
  timer: any;
}

export interface ReliableTransportConfig {
  initialRtoMs?: number;
  maxRtoMs?: number;
  maxRetries?: number;
  sendRaw: (packet: TransportPacket) => void;
  onDelivered: (packet: TransportPacket) => void;
  onAck?: (seq: number, rttMs: number) => void;
  onMetricsChange?: (metrics: NetworkMetrics) => void;
}

export class ReliableTransport {
  private sendNextSeq = 1;
  private expectedReceiveSeq = 1;
  private unackedQueue = new Map<number, PendingPacket>();
  private reorderBuffer = new Map<number, TransportPacket>();

  // Configuration
  private initialRtoMs: number;
  private maxRtoMs: number;
  private maxRetries: number;
  private sendRaw: (packet: TransportPacket) => void;
  private onDelivered: (packet: TransportPacket) => void;
  private onAck?: (seq: number, rttMs: number) => void;
  private onMetricsChange?: (metrics: NetworkMetrics) => void;

  // Telemetry & Metrics
  private metrics: NetworkMetrics = {
    packetsSent: 0,
    packetsReceived: 0,
    packetsAcked: 0,
    retransmissions: 0,
    duplicatesDropped: 0,
    outOfOrderReordered: 0,
    rttMs: 0,
    simulatedLossRate: 0.0,
  };

  // Smoothed RTT (SRTT) using Jacobson's Algorithm
  private srtt = 0;
  private rttvar = 0;

  constructor(config: ReliableTransportConfig) {
    this.initialRtoMs = config.initialRtoMs ?? 400;
    this.maxRtoMs = config.maxRtoMs ?? 3000;
    this.maxRetries = config.maxRetries ?? 6;
    this.sendRaw = config.sendRaw;
    this.onDelivered = config.onDelivered;
    this.onAck = config.onAck;
    this.onMetricsChange = config.onMetricsChange;
  }

  /**
   * Set simulated packet drop rate for demonstration (0.0 to 0.8)
   */
  public setSimulatedLossRate(rate: number) {
    this.metrics.simulatedLossRate = Math.max(0, Math.min(0.85, rate));
    this.emitMetrics();
  }

  public getMetrics(): NetworkMetrics {
    return { ...this.metrics };
  }

  /**
   * Sends a DATA or FILE_CHUNK packet reliably.
   * Assigns sequence number, registers retransmit timer, and transmits over channel.
   */
  public send(packet: Omit<TransportPacket, 'seq' | 'timestamp'>): number {
    const seq = this.sendNextSeq++;
    const fullPacket: TransportPacket = {
      ...packet,
      seq,
      timestamp: Date.now(),
    };

    const pending: PendingPacket = {
      packet: fullPacket,
      timestamp: fullPacket.timestamp,
      retries: 0,
      rtoMs: this.computeInitialRto(),
      timer: null,
    };

    this.unackedQueue.set(seq, pending);
    this.scheduleRetransmission(seq);

    this.metrics.packetsSent++;
    this.emitMetrics();

    this.transmit(fullPacket);
    return seq;
  }

  /**
   * Transmit packet with optional simulated drop
   */
  private transmit(packet: TransportPacket) {
    if (this.metrics.simulatedLossRate > 0 && Math.random() < this.metrics.simulatedLossRate) {
      // Intentionally drop packet locally to simulate noisy network
      return;
    }
    this.sendRaw(packet);
  }

  /**
   * Dispatches incoming packet received from the WebRTC data channel.
   */
  public handleIncoming(packet: TransportPacket) {
    if (packet.type === 'ACK') {
      this.handleAck(packet);
    } else if (packet.type === 'DATA' || packet.type === 'FILE_CHUNK') {
      this.handleData(packet);
    } else if (packet.type === 'HEARTBEAT') {
      // Respond to heartbeat if needed
    }
  }

  /**
   * Handles incoming ACK packet from peer.
   */
  private handleAck(packet: TransportPacket) {
    if (typeof packet.ackSeq !== 'number') return;
    const seq = packet.ackSeq;
    const pending = this.unackedQueue.get(seq);

    if (pending) {
      // Clear timeout timer
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      this.unackedQueue.delete(seq);

      // Compute Round Trip Time (RTT) sample
      const sampleRtt = Date.now() - pending.timestamp;
      this.updateRtt(sampleRtt);

      this.metrics.packetsAcked++;
      this.emitMetrics();

      if (this.onAck) {
        this.onAck(seq, sampleRtt);
      }
    }
  }

  /**
   * Handles incoming DATA / FILE_CHUNK packet:
   * 1. Immediately sends ACK.
   * 2. Deduplicates.
   * 3. Buffers out-of-order packets.
   * 4. In-order playout delivery to application.
   */
  private handleData(packet: TransportPacket) {
    if (typeof packet.seq !== 'number') return;
    const seq = packet.seq;
    this.metrics.packetsReceived++;

    // Step 1: Send immediate ACK back to sender
    const ackPacket: TransportPacket = {
      type: 'ACK',
      ackSeq: seq,
      timestamp: Date.now(),
    };
    this.transmit(ackPacket);

    // Step 2: Check sequence number against expected sequence
    if (seq < this.expectedReceiveSeq) {
      // Duplicate packet already delivered earlier
      this.metrics.duplicatesDropped++;
      this.emitMetrics();
      return;
    }

    if (seq === this.expectedReceiveSeq) {
      // Exact in-order packet!
      this.expectedReceiveSeq++;
      this.onDelivered(packet);

      // Check if buffered out-of-order packets can now be delivered sequentially
      while (this.reorderBuffer.has(this.expectedReceiveSeq)) {
        const nextPacket = this.reorderBuffer.get(this.expectedReceiveSeq)!;
        this.reorderBuffer.delete(this.expectedReceiveSeq);
        this.expectedReceiveSeq++;
        this.onDelivered(nextPacket);
      }

      this.emitMetrics();
    } else {
      // seq > this.expectedReceiveSeq: Out-of-order packet!
      // Missing packet(s) occurred before this one; buffer this packet
      if (!this.reorderBuffer.has(seq)) {
        this.reorderBuffer.set(seq, packet);
        this.metrics.outOfOrderReordered++;
        this.emitMetrics();
      }
    }
  }

  /**
   * Retransmission scheduler with exponential backoff
   */
  private scheduleRetransmission(seq: number) {
    const pending = this.unackedQueue.get(seq);
    if (!pending) return;

    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    pending.timer = setTimeout(() => {
      this.triggerRetransmit(seq);
    }, pending.rtoMs);
  }

  private triggerRetransmit(seq: number) {
    const pending = this.unackedQueue.get(seq);
    if (!pending) return;

    if (pending.retries >= this.maxRetries) {
      // Exhausted retries, clean up
      this.unackedQueue.delete(seq);
      return;
    }

    pending.retries++;
    this.metrics.retransmissions++;

    // Exponential backoff
    pending.rtoMs = Math.min(this.maxRtoMs, Math.round(pending.rtoMs * 1.5));
    this.scheduleRetransmission(seq);
    this.emitMetrics();

    // Resend packet over channel
    this.transmit(pending.packet);
  }

  /**
   * Jacobson's Algorithm for Smoothed RTT & RTO calculation
   */
  private updateRtt(sampleRtt: number) {
    if (this.srtt === 0) {
      this.srtt = sampleRtt;
      this.rttvar = sampleRtt / 2;
    } else {
      const alpha = 0.125;
      const beta = 0.25;
      this.rttvar = (1 - beta) * this.rttvar + beta * Math.abs(this.srtt - sampleRtt);
      this.srtt = (1 - alpha) * this.srtt + alpha * sampleRtt;
    }
    this.metrics.rttMs = Math.round(this.srtt);
  }

  private computeInitialRto(): number {
    if (this.srtt === 0) return this.initialRtoMs;
    // RTO = SRTT + max(G, 4 * RTTVAR)
    const rto = this.srtt + Math.max(100, 4 * this.rttvar);
    return Math.min(this.maxRtoMs, Math.max(this.initialRtoMs, Math.round(rto)));
  }

  private emitMetrics() {
    if (this.onMetricsChange) {
      this.onMetricsChange(this.getMetrics());
    }
  }

  /**
   * Cleanup all timers when connection terminates
   */
  public destroy() {
    for (const pending of this.unackedQueue.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
    }
    this.unackedQueue.clear();
    this.reorderBuffer.clear();
  }
}
