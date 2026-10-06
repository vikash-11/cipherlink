// Self-Hosted WebSocket Signaling Transport for CipherLink
// Replaces Trystero's BitTorrent/Nostr rendezvous with a direct FastAPI WebSocket server.
//
// Architecture change:
//   BEFORE: Trystero joinRoom → BitTorrent/Nostr trackers → WebRTC DataChannel
//   AFTER:  WebSocket to VITE_SIGNALING_URL → WebRTC DataChannel
//
// What stays EXACTLY THE SAME:
//   - RTCPeerConnection + ICE/STUN/TURN config (TURN_CONFIG unchanged)
//   - Phase-3 identity-bound handshake (ECDSA challenge/response)
//   - ECDH session key derivation + AES-256-GCM transport
//   - ReliableTransport protocol over RTCDataChannel
//   - All callbacks: onConnected, onDisconnected, onMessageReceived, etc.
//   - sendChatMessage, addMediaStream
//
// WebSocket lifecycle decision:
//   The signaling WebSocket stays OPEN after ICE reaches connected/completed.
//   Rationale: keeping it open lets the server know you're still online for
//   future incoming connections without needing a re-register round-trip.
//   On explicit disconnect() the WS is kept alive (you remain registered).
//   On destroy() (app teardown) the WS is closed, deregistering you.

import {
  type UserIdentity,
  bufferToBase64,
  base64ToBuffer,
  deriveIdFromSpki,
} from '../crypto/identity';
import {
  generateEphemeralEcdh,
  deriveSessionKey,
  importEphemeralPublicKey,
  encryptPayload,
  decryptPayload,
} from '../crypto/session';
import {
  generateChallenge,
  signHandshakeChallenge,
  verifyHandshakeResponse,
  computeSafetyNumber,
} from '../crypto/handshakeAuth';
import { ReliableTransport } from './reliableTransport';
import type { TransportPacket, NetworkMetrics, ConnectionStatus } from './types';
import { normalizeId } from '../crypto/crockford';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIGNALING_URL: string =
  import.meta.env.VITE_SIGNALING_URL || 'ws://localhost:8000/ws';

/**
 * ICE / STUN / TURN servers for cross-network WebRTC connectivity.
 * Multiple STUN servers across providers maximise NAT traversal success.
 * TURN servers ensure connectivity even through symmetric NATs.
 * NOTE: This config is intentionally UNCHANGED from the Trystero version.
 */
const TURN_CONFIG: RTCIceServer[] = [
  // Google STUN
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  // Cloudflare STUN
  { urls: 'stun:stun.cloudflare.com:3478' },
  // Twilio STUN
  { urls: 'stun:global.stun.twilio.com:3478' },
  // Metered STUN
  { urls: 'stun:stun.relay.metered.ca:80' },
  // Public TURN fallback — Open Relay Project (covers symmetric NATs)
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  // Metered TURN — additional coverage
  {
    urls: 'turn:a.relay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:a.relay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:a.relay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export interface IncomingRequest {
  callerId: string;
  callerDisplayName: string;
  /** Kept for API compatibility — now represents the caller's peer ID */
  peerTrysteroId: string;
  accept: () => Promise<void>;
  reject: (reason?: string) => void;
}

export interface SignalingCallbacks {
  onStatusChange: (status: ConnectionStatus, detail?: string) => void;
  onIncomingRequest: (request: IncomingRequest) => void;
  onConnected: (peerInfo: {
    peerId: string;
    safetyNumber: string;
    sessionKey: CryptoKey;
    reliableTransport: ReliableTransport;
  }) => void;
  onDisconnected: () => void;
  onMessageReceived: (text: string, timestamp: number, seq: number) => void;
  onFileChunkReceived: (packet: TransportPacket) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onMetricsChange: (metrics: NetworkMetrics) => void;
}

// ---------------------------------------------------------------------------
// SignalingSocket — thin wrapper around the server WebSocket
// ---------------------------------------------------------------------------

class SignalingSocket {
  private ws: WebSocket | null = null;
  private messageHandler: ((msg: Record<string, unknown>) => void) | null = null;
  private openHandlers: (() => void)[] = [];

  constructor(private url: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.onopen = () => {
        console.log('[SignalingSocket] Connected to', this.url);
        this.openHandlers.forEach((h) => h());
        resolve();
      };

      ws.onerror = (e) => {
        console.error('[SignalingSocket] Error', e);
        reject(new Error('Failed to connect to signaling server'));
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string) as Record<string, unknown>;
          if (this.messageHandler) this.messageHandler(msg);
        } catch {
          console.warn('[SignalingSocket] Invalid JSON from server');
        }
      };

      ws.onclose = () => {
        console.log('[SignalingSocket] Disconnected');
      };
    });
  }

  onMessage(handler: (msg: Record<string, unknown>) => void) {
    this.messageHandler = handler;
  }

  send(payload: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    } else {
      console.warn('[SignalingSocket] Cannot send — socket not open');
    }
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

// ---------------------------------------------------------------------------
// PeerSessionManager
// ---------------------------------------------------------------------------

export class PeerSessionManager {
  private localIdentity: UserIdentity;
  private callbacks: SignalingCallbacks;

  // Signaling WebSocket
  private signalingSocket: SignalingSocket;
  private signalingReady = false;

  // WebRTC
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;

  // Session state
  private sessionKey: CryptoKey | null = null;
  private reliableTransport: ReliableTransport | null = null;
  private safetyNumber = '';
  private remotePeerId = '';
  private status: ConnectionStatus = 'disconnected';

  // Ephemeral keys for active handshake
  private ephemeralKeyPair: {
    keyPair: CryptoKeyPair;
    rawPublicKey: ArrayBuffer;
    base64PublicKey: string;
  } | null = null;
  private localChallenge: Uint8Array | null = null;

  // Callee-side confirmation gate: true only once the caller's
  // handshake_confirm signature has been verified.
  private callerConfirmedOk = false;
  // Holds the DataChannel if it opens before the caller's confirmation
  // arrives, so it isn't trusted/used until verification completes.
  private pendingDataChannel: RTCDataChannel | null = null;

  // Pending handshake state (callee side, before accept)
  private pendingCallerInfo: {
    callerId: string;
    callerSpkiBase64: string;
    callerEphemeralBase64: string;
    callerChallengeBase64: string;
  } | null = null;

  // Retained after accept, until the caller's HANDSHAKE_CONFIRM is verified.
  // This is what lets the callee actually prove the caller holds the private
  // key for the identity they claimed — not just that the SPKI hashes to it.
  private awaitingCallerConfirm: {
    callerId: string;
    callerSpkiBase64: string;
    callerEphemeralBase64: string;
  } | null = null;

  constructor(localIdentity: UserIdentity, callbacks: SignalingCallbacks) {
    this.localIdentity = localIdentity;
    this.callbacks = callbacks;
    this.signalingSocket = new SignalingSocket(SIGNALING_URL);
  }

  // ---------------------------------------------------------------------------
  // Public accessors (unchanged API surface)
  // ---------------------------------------------------------------------------

  public getStatus(): ConnectionStatus { return this.status; }
  public getSessionKey(): CryptoKey | null { return this.sessionKey; }
  public getSafetyNumber(): string { return this.safetyNumber; }
  public getRemotePeerId(): string { return this.remotePeerId; }
  public getReliableTransport(): ReliableTransport | null { return this.reliableTransport; }

  private setStatus(status: ConnectionStatus, detail?: string) {
    this.status = status;
    this.callbacks.onStatusChange(status, detail);
  }

  // ---------------------------------------------------------------------------
  // startListening — connect to signaling server and register local ID
  // ---------------------------------------------------------------------------

  public async startListening(): Promise<void> {
    try {
      await this.signalingSocket.connect();
      this.signalingReady = true;

      // Register with the signaling server
      this.signalingSocket.send({ type: 'register', id: this.localIdentity.id });

      // Route all incoming signaling messages
      this.signalingSocket.onMessage((msg) => this.handleSignalingMessage(msg));
    } catch (err: any) {
      this.setStatus('failed', `Cannot reach signaling server: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Signaling message dispatch
  // ---------------------------------------------------------------------------

  private async handleSignalingMessage(msg: Record<string, unknown>) {
    const type = msg.type as string;

    switch (type) {
      case 'registered':
        console.log('[Signaling] Registered as', msg.id);
        break;

      case 'connect_request':
        await this.handleIncomingConnectRequest(msg);
        break;

      case 'connect_response':
        await this.handleConnectResponse(msg);
        break;

      case 'handshake_confirm':
        await this.handleHandshakeConfirm(msg);
        break;

      case 'sdp_offer':
        await this.handleSdpOffer(msg);
        break;

      case 'sdp_answer':
        await this.handleSdpAnswer(msg);
        break;

      case 'ice_candidate':
        await this.handleIceCandidate(msg);
        break;

      case 'error':
        console.warn('[Signaling] Server error:', msg.message);
        if (msg.message === 'peer not available') {
          this.setStatus('failed', 'Peer is not online. Verify their ID and that they have the app open.');
        }
        break;

      default:
        console.log('[Signaling] Unknown message type:', type);
    }
  }

  // ---------------------------------------------------------------------------
  // Incoming connect_request (callee side — we are being dialled)
  // ---------------------------------------------------------------------------

  private async handleIncomingConnectRequest(msg: Record<string, unknown>) {
    const callerId = msg.from as string;
    const callerSpkiBase64 = msg.callerSpkiBase64 as string;
    const callerEphemeralBase64 = msg.callerEphemeralBase64 as string;
    const callerChallengeBase64 = msg.callerChallengeBase64 as string;

    // Verify caller's ID matches their SPKI
    const callerSpki = base64ToBuffer(callerSpkiBase64);
    const { formattedId } = await deriveIdFromSpki(callerSpki);
    if (formattedId !== callerId) {
      this.signalingSocket.send({
        type: 'connect_response',
        to: callerId,
        accepted: false,
        reason: 'Identity signature verification failed',
      });
      return;
    }

    // Stash caller's data so the accept callback can use it
    this.pendingCallerInfo = { callerId, callerSpkiBase64, callerEphemeralBase64, callerChallengeBase64 };
    this.remotePeerId = callerId;

    this.callbacks.onIncomingRequest({
      callerId,
      callerDisplayName: `Peer ${callerId.slice(0, 4)}`,
      peerTrysteroId: callerId,           // compatibility alias
      accept: async () => this.acceptIncoming(),
      reject: (reason = 'User declined connection') => {
        this.pendingCallerInfo = null;
        this.signalingSocket.send({
          type: 'connect_response',
          to: callerId,
          accepted: false,
          reason,
        });
      },
    });
  }

  private async acceptIncoming(): Promise<void> {
    const info = this.pendingCallerInfo;
    if (!info) return;
    this.pendingCallerInfo = null;

    const { callerId, callerSpkiBase64, callerEphemeralBase64, callerChallengeBase64 } = info;
    this.setStatus('authenticating', 'Authenticating peer handshake...');

    // Retain what we need to verify the caller's confirmation signature once
    // it arrives — this is the step that proves the caller actually holds
    // the private key for the identity they claimed, not just that their
    // SPKI hashes to the dialed ID.
    this.awaitingCallerConfirm = { callerId, callerSpkiBase64, callerEphemeralBase64 };

    // Generate our ephemeral ECDH key pair + local challenge
    this.ephemeralKeyPair = await generateEphemeralEcdh();
    this.localChallenge = generateChallenge();

    // Sign caller's challenge with our long-term identity key
    const callerChallengeBytes = new Uint8Array(base64ToBuffer(callerChallengeBase64));
    const signatureBase64 = await signHandshakeChallenge(
      this.localIdentity,
      callerChallengeBytes,
      this.ephemeralKeyPair.rawPublicKey,
    );

    // Import caller ephemeral key and derive shared session key
    const callerEphemeralKey = await importEphemeralPublicKey(base64ToBuffer(callerEphemeralBase64));
    this.sessionKey = await deriveSessionKey(
      this.ephemeralKeyPair.keyPair.privateKey,
      callerEphemeralKey,
    );

    // Compute safety number
    const callerSpki = base64ToBuffer(callerSpkiBase64);
    this.safetyNumber = await computeSafetyNumber(this.localIdentity.publicKeySpki, callerSpki);

    // Send acceptance + credentials back to caller via signaling server
    this.signalingSocket.send({
      type: 'connect_response',
      to: callerId,
      accepted: true,
      responderId: this.localIdentity.id,
      responderSpkiBase64: this.localIdentity.publicKeyBase64,
      responderEphemeralBase64: this.ephemeralKeyPair.base64PublicKey,
      challengeBase64: bufferToBase64(this.localChallenge.buffer),
      signatureBase64,
    });

    // Now build WebRTC peer connection (callee = non-offer side)
    await this.buildPeerConnection(false /* isOfferer */);
  }

  // ---------------------------------------------------------------------------
  // connectToPeer — caller side (we are dialling)
  // ---------------------------------------------------------------------------

  public async connectToPeer(targetId: string): Promise<void> {
    const cleanTargetId = normalizeId(targetId);
    if (!cleanTargetId || cleanTargetId === normalizeId(this.localIdentity.id)) {
      throw new Error('Cannot dial own ID or empty ID');
    }

    if (!this.signalingReady) {
      throw new Error('Signaling server not connected yet. Please wait a moment.');
    }

    this.setStatus('signaling', `Requesting connection to ${targetId}...`);
    this.remotePeerId = targetId;

    // Generate local ephemeral ECDH keypair + challenge
    this.ephemeralKeyPair = await generateEphemeralEcdh();
    this.localChallenge = generateChallenge();

    // Send connect request to server — server forwards to target if online
    this.signalingSocket.send({
      type: 'connect_request',
      from: this.localIdentity.id,
      to: cleanTargetId,
      callerSpkiBase64: this.localIdentity.publicKeyBase64,
      callerEphemeralBase64: this.ephemeralKeyPair.base64PublicKey,
      callerChallengeBase64: bufferToBase64(this.localChallenge.buffer),
    });

    this.setStatus('signaling', 'Waiting for peer to accept...');
  }

  // ---------------------------------------------------------------------------
  // connect_response handler (caller side — peer accepted or rejected us)
  // ---------------------------------------------------------------------------

  private async handleConnectResponse(msg: Record<string, unknown>) {
    const accepted = msg.accepted as boolean;

    if (!accepted) {
      this.setStatus('rejected', (msg.reason as string) || 'Peer declined connection request');
      this.remotePeerId = '';
      return;
    }

    this.setStatus('authenticating', 'Peer accepted. Verifying cryptographic credentials...');

    const responderId = msg.responderId as string;
    const responderSpkiBase64 = msg.responderSpkiBase64 as string;
    const responderEphemeralBase64 = msg.responderEphemeralBase64 as string;
    const challengeBase64 = msg.challengeBase64 as string;
    const signatureBase64 = msg.signatureBase64 as string;

    // Authenticate responder: verify signature of our challenge + ID match
    const authResult = await verifyHandshakeResponse({
      expectedId: this.remotePeerId,
      remoteIdentitySpkiBase64: responderSpkiBase64,
      remoteEphemeralRawBase64: responderEphemeralBase64,
      localChallenge: this.localChallenge!,
      signatureBase64,
    });

    if (!authResult.valid) {
      this.setStatus('failed', `Handshake validation failed: ${authResult.reason}`);
      return;
    }

    // Derive shared session key via ECDH + HKDF
    const responderEphemeralKey = await importEphemeralPublicKey(base64ToBuffer(responderEphemeralBase64));
    this.sessionKey = await deriveSessionKey(
      this.ephemeralKeyPair!.keyPair.privateKey,
      responderEphemeralKey,
    );

    // Compute safety number
    const remoteSpkiBuffer = base64ToBuffer(responderSpkiBase64);
    this.safetyNumber = await computeSafetyNumber(this.localIdentity.publicKeySpki, remoteSpkiBuffer);

    // Sign responder's challenge (confirmation step)
    const responderChallengeBytes = new Uint8Array(base64ToBuffer(challengeBase64));
    const myConfirmSignature = await signHandshakeChallenge(
      this.localIdentity,
      responderChallengeBytes,
      this.ephemeralKeyPair!.rawPublicKey,
    );

    // Send confirmation — server relays to callee.
    // This is a distinct message type (not a reused 'connect_response') so
    // the callee can route it to a dedicated verifier instead of silently
    // mis-parsing it as another accept/reject message.
    this.signalingSocket.send({
      type: 'handshake_confirm',
      to: this.remotePeerId,
      confirmSignatureBase64: myConfirmSignature,
    });

    // Build WebRTC peer connection — caller is the offerer
    await this.buildPeerConnection(true /* isOfferer */);
  }

  // ---------------------------------------------------------------------------
  // handshake_confirm handler (callee side — proves the caller actually
  // holds the private key for the identity they claimed, closing the gap
  // where only hash(SPKI) == dialed ID was previously checked)
  // ---------------------------------------------------------------------------

  private async handleHandshakeConfirm(msg: Record<string, unknown>): Promise<void> {
    const pending = this.awaitingCallerConfirm;
    if (!pending || !this.localChallenge) {
      console.warn('[Handshake] Received confirm with no pending verification — ignoring');
      return;
    }

    const confirmSignatureBase64 = msg.confirmSignatureBase64 as string;

    const authResult = await verifyHandshakeResponse({
      expectedId: pending.callerId,
      remoteIdentitySpkiBase64: pending.callerSpkiBase64,
      remoteEphemeralRawBase64: pending.callerEphemeralBase64,
      localChallenge: this.localChallenge,
      signatureBase64: confirmSignatureBase64,
    });

    this.awaitingCallerConfirm = null;

    if (!authResult.valid) {
      // The caller could not prove possession of the private key for the
      // identity they claimed — treat this exactly like a failed handshake,
      // even if ICE/DataChannel negotiation already started.
      this.disconnect(`Caller confirmation failed: ${authResult.reason}. Possible MITM — connection aborted.`);
      return;
    }

    this.callerConfirmedOk = true;

    // If the DataChannel already opened while we were waiting on this
    // confirmation, it was held back — release it now.
    if (this.pendingDataChannel) {
      const dc = this.pendingDataChannel;
      this.pendingDataChannel = null;
      this.initializeReliableTransport(dc);
    }
  }

  // ---------------------------------------------------------------------------
  // WebRTC peer connection
  // ---------------------------------------------------------------------------

  private async buildPeerConnection(isOfferer: boolean): Promise<void> {
    // Clean up any existing connection
    this.closeRtc();

    const pc = new RTCPeerConnection({ iceServers: TURN_CONFIG });
    this.pc = pc;

    // ICE candidate trickle — send candidates via signaling server
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalingSocket.send({
          type: 'ice_candidate',
          to: this.remotePeerId,
          payload: event.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state:', pc.connectionState);
      if (pc.connectionState === 'failed') {
        this.disconnect('WebRTC connection failed');
      }
    };

    // Remote media streams (for calls)
    pc.ontrack = (event) => {
      if (event.streams[0]) {
        this.callbacks.onRemoteStream(event.streams[0]);
      }
    };

    if (isOfferer) {
      // Caller creates DataChannel and sends SDP offer
      const dc = pc.createDataChannel('cipherlink-reliable', { ordered: true });
      this.setupDataChannel(dc);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.signalingSocket.send({
        type: 'sdp_offer',
        to: this.remotePeerId,
        payload: { sdp: offer.sdp, type: offer.type },
      });
    } else {
      // Callee waits for DataChannel from the offerer
      pc.ondatachannel = (event) => {
        this.setupDataChannel(event.channel);
      };
    }
  }

  private async handleSdpOffer(msg: Record<string, unknown>) {
    if (!this.pc) {
      console.warn('[WebRTC] Received SDP offer but no peer connection — ignoring');
      return;
    }
    const payload = msg.payload as RTCSessionDescriptionInit;
    await this.pc.setRemoteDescription(payload);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    this.signalingSocket.send({
      type: 'sdp_answer',
      to: msg.from as string || this.remotePeerId,
      payload: { sdp: answer.sdp, type: answer.type },
    });
  }

  private async handleSdpAnswer(msg: Record<string, unknown>) {
    if (!this.pc) return;
    const payload = msg.payload as RTCSessionDescriptionInit;
    await this.pc.setRemoteDescription(payload);
  }

  private async handleIceCandidate(msg: Record<string, unknown>) {
    if (!this.pc) return;
    try {
      await this.pc.addIceCandidate(msg.payload as RTCIceCandidateInit);
    } catch (e) {
      console.warn('[WebRTC] Failed to add ICE candidate', e);
    }
  }

  // ---------------------------------------------------------------------------
  // DataChannel setup — replaces Trystero's relDataAction
  // ---------------------------------------------------------------------------

  private setupDataChannel(dc: RTCDataChannel) {
    this.dataChannel = dc;

    dc.onopen = () => {
      console.log('[DataChannel] Open');

      // Callee side: if we're still waiting on the caller's handshake_confirm
      // signature, don't trust/initialize the channel yet — hold it until
      // handleHandshakeConfirm verifies it (or aborts the connection).
      if (this.awaitingCallerConfirm) {
        console.log('[DataChannel] Open but awaiting caller confirmation — holding');
        this.pendingDataChannel = dc;
        return;
      }

      this.initializeReliableTransport(dc);
    };

    dc.onerror = (e) => {
      console.error('[DataChannel] Error', e);
    };

    dc.onclose = () => {
      if (this.status === 'connected') {
        this.disconnect('DataChannel closed');
      }
    };
  }

  // ---------------------------------------------------------------------------
  // ReliableTransport — identical to the Trystero version, different raw send
  // ---------------------------------------------------------------------------

  private initializeReliableTransport(dc: RTCDataChannel) {
    if (this.reliableTransport) {
      this.reliableTransport.destroy();
    }

    this.reliableTransport = new ReliableTransport({
      initialRtoMs: 200,
      maxRtoMs: 4000,
      maxRetries: 8,
      sendRaw: (packet: TransportPacket) => {
        if (dc.readyState === 'open') {
          dc.send(JSON.stringify(packet));
        }
      },
      onDelivered: async (packet: TransportPacket) => {
        if (packet.type === 'DATA' && packet.payload && this.sessionKey) {
          try {
            const decryptedBytes = await decryptPayload(this.sessionKey, packet.payload);
            const text = new TextDecoder().decode(decryptedBytes);
            this.callbacks.onMessageReceived(text, packet.timestamp, packet.seq || 0);
          } catch (err: any) {
            console.error('[PeerSignaling] Decryption failed for DATA packet seq', packet.seq, err);
          }
        } else if (packet.type === 'FILE_CHUNK') {
          this.callbacks.onFileChunkReceived(packet);
        }
      },
      onMetricsChange: (metrics: NetworkMetrics) => {
        this.callbacks.onMetricsChange(metrics);
      },
    });

    // Wire raw DataChannel messages into the ReliableTransport
    dc.onmessage = (event: MessageEvent) => {
      try {
        const packet = JSON.parse(event.data as string) as TransportPacket;
        if (this.reliableTransport) {
          this.reliableTransport.handleIncoming(packet);
        }
      } catch {
        console.warn('[DataChannel] Failed to parse packet');
      }
    };

    this.setStatus('connected');
    this.callbacks.onConnected({
      peerId: this.remotePeerId,
      safetyNumber: this.safetyNumber,
      sessionKey: this.sessionKey!,
      reliableTransport: this.reliableTransport,
    });
  }

  // ---------------------------------------------------------------------------
  // Public methods (unchanged API surface)
  // ---------------------------------------------------------------------------

  public async sendChatMessage(text: string): Promise<number | null> {
    if (!this.sessionKey || !this.reliableTransport) {
      throw new Error('Cannot send message: Not connected or session key missing');
    }
    const encrypted = await encryptPayload(this.sessionKey, text);
    return this.reliableTransport.send({ type: 'DATA', payload: encrypted });
  }

  public addMediaStream(stream: MediaStream): void {
    if (this.pc) {
      stream.getTracks().forEach((track) => this.pc!.addTrack(track, stream));
    }
  }

  public removeMediaStream(stream: MediaStream): void {
    if (this.pc) {
      const senders = this.pc.getSenders();
      stream.getTracks().forEach((track) => {
        const sender = senders.find((s) => s.track === track);
        if (sender) this.pc!.removeTrack(sender);
      });
    }
  }

  private closeRtc() {
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
  }

  public disconnect(reason = 'Disconnected'): void {
    if (this.reliableTransport) {
      this.reliableTransport.destroy();
      this.reliableTransport = null;
    }
    this.closeRtc();
    this.sessionKey = null;
    this.safetyNumber = '';
    this.remotePeerId = '';
    this.ephemeralKeyPair = null;
    this.localChallenge = null;
    this.pendingCallerInfo = null;
    this.awaitingCallerConfirm = null;
    this.callerConfirmedOk = false;
    this.pendingDataChannel = null;
    this.setStatus('disconnected', reason);
    this.callbacks.onDisconnected();
  }

  public destroy(): void {
    this.disconnect();
    // Close signaling WebSocket on full teardown — deregisters from server
    this.signalingSocket.close();
    this.signalingReady = false;
  }
}

// ---------------------------------------------------------------------------
// Utility — kept for backward-compatibility (was used externally in tests)
// ---------------------------------------------------------------------------
export async function deriveRoomName(id: string): Promise<string> {
  const norm = normalizeId(id);
  const data = new TextEncoder().encode(`cipherlink:room:v1:${norm}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `cl-${hex.slice(0, 16)}`;
}
