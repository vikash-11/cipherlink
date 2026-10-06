// Unit tests for Custom Reliable Transport Protocol
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReliableTransport } from '../reliableTransport';
import type { TransportPacket } from '../types';

describe('ReliableTransport Protocol', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('assigns monotonic sequence numbers and receives ACKs', () => {
    const rawOut: TransportPacket[] = [];
    const delivered: TransportPacket[] = [];
    const ackEvents: { seq: number; rtt: number }[] = [];

    const sender = new ReliableTransport({
      initialRtoMs: 300,
      sendRaw: (pkt) => rawOut.push(pkt),
      onDelivered: (pkt) => delivered.push(pkt),
      onAck: (seq, rtt) => ackEvents.push({ seq, rtt }),
    });

    const seq1 = sender.send({ type: 'DATA' });
    const seq2 = sender.send({ type: 'DATA' });

    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
    expect(rawOut.length).toBe(2);
    expect(rawOut[0].seq).toBe(1);
    expect(rawOut[1].seq).toBe(2);

    // Simulate receiver sending ACK back for seq 1
    sender.handleIncoming({
      type: 'ACK',
      ackSeq: 1,
      timestamp: Date.now(),
    });

    expect(ackEvents.length).toBe(1);
    expect(ackEvents[0].seq).toBe(1);
    expect(sender.getMetrics().packetsAcked).toBe(1);
  });

  it('delivers packets strictly in-order despite out-of-order arrival', () => {
    const deliveredAtReceiver: number[] = [];
    const receiverAcks: TransportPacket[] = [];

    const receiver = new ReliableTransport({
      sendRaw: (pkt) => receiverAcks.push(pkt),
      onDelivered: (pkt) => {
        if (pkt.seq) deliveredAtReceiver.push(pkt.seq);
      },
    });

    // Packet 2 arrives BEFORE Packet 1 (network out-of-order reordering)
    receiver.handleIncoming({
      type: 'DATA',
      seq: 2,
      timestamp: 1000,
    });

    // Packet 2 should be buffered in reorderBuffer, NOT delivered yet
    expect(deliveredAtReceiver).toEqual([]);
    expect(receiver.getMetrics().outOfOrderReordered).toBe(1);

    // Receiver should have still sent ACK for seq 2 (Selective ACK)
    expect(receiverAcks.some((a) => a.ackSeq === 2)).toBe(true);

    // Now Packet 1 arrives!
    receiver.handleIncoming({
      type: 'DATA',
      seq: 1,
      timestamp: 1000,
    });

    // Both Packet 1 and Packet 2 should now be drained sequentially in order!
    expect(deliveredAtReceiver).toEqual([1, 2]);
  });

  it('safely drops duplicate packets and re-ACKs to unblock sender', () => {
    const delivered: number[] = [];
    const acks: TransportPacket[] = [];

    const receiver = new ReliableTransport({
      sendRaw: (pkt) => acks.push(pkt),
      onDelivered: (pkt) => {
        if (pkt.seq) delivered.push(pkt.seq);
      },
    });

    receiver.handleIncoming({ type: 'DATA', seq: 1, timestamp: 1000 });
    expect(delivered).toEqual([1]);

    // Same packet 1 arrives again (e.g. sender retransmitted due to delayed ACK)
    receiver.handleIncoming({ type: 'DATA', seq: 1, timestamp: 1000 });

    // Should NOT deliver packet 1 again
    expect(delivered).toEqual([1]);
    expect(receiver.getMetrics().duplicatesDropped).toBe(1);

    // But should have sent ACK again
    expect(acks.filter((a) => a.ackSeq === 1).length).toBe(2);
  });

  it('automatically retransmits lost packets upon RTO timeout', () => {
    const sentPackets: TransportPacket[] = [];

    const sender = new ReliableTransport({
      initialRtoMs: 200,
      maxRetries: 3,
      sendRaw: (pkt) => sentPackets.push(pkt),
      onDelivered: () => {},
    });

    sender.send({ type: 'DATA' });
    expect(sentPackets.length).toBe(1);
    expect(sentPackets[0].seq).toBe(1);

    // Fast-forward clock by 250ms past initial RTO (200ms)
    vi.advanceTimersByTime(250);

    // Should have retransmitted packet 1
    expect(sentPackets.length).toBe(2);
    expect(sentPackets[1].seq).toBe(1);
    expect(sender.getMetrics().retransmissions).toBe(1);

    // Fast-forward with exponential backoff (200 * 1.5 = 300ms)
    vi.advanceTimersByTime(350);
    expect(sentPackets.length).toBe(3);
    expect(sender.getMetrics().retransmissions).toBe(2);
  });
});
