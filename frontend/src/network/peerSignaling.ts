// -----------------------------------------------------------------------------

// CipherLink - Self-Hosted WebSocket Signaling + WebRTC DataChannel

// Voice and video calling have been completely removed.

// -----------------------------------------------------------------------------



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



import type {

  TransportPacket,

  NetworkMetrics,

  ConnectionStatus,

} from './types';



import { normalizeId } from '../crypto/crockford';



// -----------------------------------------------------------------------------

// Constants

// -----------------------------------------------------------------------------



const SIGNALING_URL: string =

  import.meta.env.VITE_SIGNALING_URL || 'ws\://localhost:8000/ws';



// -----------------------------------------------------------------------------

// ICE / STUN / TURN configuration

// -----------------------------------------------------------------------------



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



  // Public TURN fallback

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



  // Metered TURN

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



// -----------------------------------------------------------------------------

// Public Types

// -----------------------------------------------------------------------------



export interface IncomingRequest {

  callerId: string;

  callerDisplayName: string;



  // Kept for compatibility with existing UI code.

  peerTrysteroId: string;



  accept: () => Promise<void>;

  reject: (reason?: string) => void;

}



export interface SignalingCallbacks {

  onStatusChange: (

    status: ConnectionStatus,

    detail?: string

  ) => void;



  onIncomingRequest: (

    request: IncomingRequest

  ) => void;



  onConnected: (peerInfo: {

    peerId: string;

    safetyNumber: string;

    sessionKey: CryptoKey;

    reliableTransport: ReliableTransport;

  }) => void;



  onDisconnected: () => void;



  onMessageReceived: (

    text: string,

    timestamp: number,

    seq: number

  ) => void;



  onFileChunkReceived: (

    packet: TransportPacket

  ) => void;



  onMetricsChange: (

    metrics: NetworkMetrics

  ) => void;

}



// -----------------------------------------------------------------------------

// SignalingSocket

// -----------------------------------------------------------------------------



class SignalingSocket {

  private ws: WebSocket | null = null;



  private messageHandler:

    ((msg: Record<string, unknown>) => void) | null = null;



  private openHandlers: (() => void)[] = [];



  constructor(private url: string) { }



  connect(): Promise<void> {

    return new Promise((resolve, reject) => {

      const ws = new WebSocket(this.url);



      this.ws = ws;



      ws.onopen = () => {

        console.log(

          '[SignalingSocket] Connected to',

          this.url

        );



        this.openHandlers.forEach((handler) => handler());



        resolve();

      };



      ws.onerror = (event) => {

        console.error(

          '[SignalingSocket] Error',

          event

        );



        reject(

          new Error(

            'Failed to connect to signaling server'

          )

        );

      };



      ws.onmessage = (event: MessageEvent) => {

        try {

          const msg =

            JSON.parse(

              event.data as string

            ) as Record<string, unknown>;



          if (this.messageHandler) {

            this.messageHandler(msg);

          }

        } catch {

          console.warn(

            '[SignalingSocket] Invalid JSON from server'

          );

        }

      };



      ws.onclose = () => {

        console.log(

          '[SignalingSocket] Disconnected'

        );

      };

    });

  }



  onMessage(

    handler: (msg: Record<string, unknown>) => void

  ) {

    this.messageHandler = handler;

  }



  send(

    payload: Record<string, unknown>

  ) {

    if (

      this.ws &&

      this.ws.readyState === WebSocket.OPEN

    ) {

      this.ws.send(

        JSON.stringify(payload)

      );

    } else {

      console.warn(

        '[SignalingSocket] Cannot send â€” socket not open'

      );

    }

  }



  close() {

    this.ws?.close();

    this.ws = null;

  }



  get isOpen() {

    return (

      this.ws?.readyState === WebSocket.OPEN

    );

  }

}



// -----------------------------------------------------------------------------

// PeerSessionManager

// -----------------------------------------------------------------------------



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



  private reliableTransport:

    ReliableTransport | null = null;



  private safetyNumber = '';



  private remotePeerId = '';



  private status: ConnectionStatus =

    'disconnected';



  // Ephemeral keys

  private ephemeralKeyPair: {

    keyPair: CryptoKeyPair;

    rawPublicKey: ArrayBuffer;

    base64PublicKey: string;

  } | null = null;



  private localChallenge:

    Uint8Array | null = null;



  // Caller confirmation

  private callerConfirmedOk = false;



  private pendingDataChannel:

    RTCDataChannel | null = null;



  // Pending handshake

  private pendingCallerInfo: {

    callerId: string;

    callerSpkiBase64: string;

    callerEphemeralBase64: string;

    callerChallengeBase64: string;

  } | null = null;



  private awaitingCallerConfirm: {

    callerId: string;

    callerSpkiBase64: string;

    callerEphemeralBase64: string;

  } | null = null;



  constructor(

    localIdentity: UserIdentity,

    callbacks: SignalingCallbacks

  ) {

    this.localIdentity = localIdentity;

    this.callbacks = callbacks;



    this.signalingSocket =

      new SignalingSocket(

        SIGNALING_URL

      );

  }



  // ---------------------------------------------------------------------------

  // Public accessors

  // ---------------------------------------------------------------------------



  public getStatus(): ConnectionStatus {

    return this.status;

  }



  public getSessionKey(): CryptoKey | null {

    return this.sessionKey;

  }



  public getSafetyNumber(): string {

    return this.safetyNumber;

  }



  public getRemotePeerId(): string {

    return this.remotePeerId;

  }



  public getReliableTransport():

    ReliableTransport | null {

    return this.reliableTransport;

  }



  // ---------------------------------------------------------------------------

  // Status

  // ---------------------------------------------------------------------------



  private setStatus(

    status: ConnectionStatus,

    detail?: string

  ) {

    this.status = status;



    this.callbacks.onStatusChange(

      status,

      detail

    );

  }



  // ---------------------------------------------------------------------------

  // Start listening

  // ---------------------------------------------------------------------------



  public async startListening(): Promise<void> {

    try {

      await this.signalingSocket.connect();



      this.signalingReady = true;



      const localId = normalizeId(

        this.localIdentity.id

      );



      console.log(

        '[Signaling] Registering local ID:',

        localId

      );



      this.signalingSocket.send({

        type: 'register',

        id: localId,

      });



      this.signalingSocket.onMessage(

        (msg) =>

          this.handleSignalingMessage(msg)

      );

    } catch (err: any) {

      this.setStatus(

        'failed',

        `Cannot reach signaling server: ${err.message}`

      );

    }

  }



  // ---------------------------------------------------------------------------

  // Signaling message dispatch

  // ---------------------------------------------------------------------------



  private async handleSignalingMessage(

    msg: Record<string, unknown>

  ) {

    const type = msg.type as string;



    switch (type) {

      case 'registered':

        console.log(

          '[Signaling] Registered as',

          msg.id

        );

        break;



      case 'connect_request':

        await this.handleIncomingConnectRequest(

          msg

        );

        break;



      case 'connect_response':

        await this.handleConnectResponse(

          msg

        );

        break;



      case 'handshake_confirm':

        await this.handleHandshakeConfirm(

          msg

        );

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

        console.warn(

          '[Signaling] Server error:',

          msg.message

        );



        if (

          msg.message ===

          'peer not available'

        ) {

          this.setStatus(

            'failed',

            'Peer is not online. Verify their ID and that they have the app open.'

          );

        }



        break;



      default:

        console.log(

          '[Signaling] Unknown message type:',

          type

        );

    }

  }



  // ---------------------------------------------------------------------------

  // Incoming connect request

  // ---------------------------------------------------------------------------



  private async handleIncomingConnectRequest(

    msg: Record<string, unknown>

  ) {

    const callerId = normalizeId(

      msg.from as string

    );



    const callerSpkiBase64 =

      msg.callerSpkiBase64 as string;



    const callerEphemeralBase64 =

      msg.callerEphemeralBase64 as string;



    const callerChallengeBase64 =

      msg.callerChallengeBase64 as string;



    // Verify caller ID against SPKI.

    const callerSpki =

      base64ToBuffer(

        callerSpkiBase64

      );



    const { formattedId } =

      await deriveIdFromSpki(

        callerSpki

      );



    if (

      normalizeId(formattedId) !==

      normalizeId(callerId)

    ) {

      console.warn(

        '[Handshake] Caller ID does not match SPKI',

        {

          callerId,

          formattedId,

        }

      );



      this.signalingSocket.send({

        type: 'connect_response',

        to: callerId,

        accepted: false,

        reason:

          'Identity signature verification failed',

      });



      return;

    }



    this.pendingCallerInfo = {

      callerId,

      callerSpkiBase64,

      callerEphemeralBase64,

      callerChallengeBase64,

    };



    this.remotePeerId = callerId;



    this.callbacks.onIncomingRequest({

      callerId,

      callerDisplayName:

        `Peer ${callerId.slice(0, 4)}`,

      peerTrysteroId: callerId,



      accept: async () =>

        this.acceptIncoming(),



      reject: (

        reason = 'User declined connection'

      ) => {

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



  // ---------------------------------------------------------------------------

  // Accept incoming request

  // ---------------------------------------------------------------------------



  private async acceptIncoming(): Promise<void> {

    const info =

      this.pendingCallerInfo;



    if (!info) return;



    this.pendingCallerInfo = null;



    const {

      callerId,

      callerSpkiBase64,

      callerEphemeralBase64,

      callerChallengeBase64,

    } = info;



    this.setStatus(

      'authenticating',

      'Authenticating peer handshake...'

    );



    this.awaitingCallerConfirm = {

      callerId,

      callerSpkiBase64,

      callerEphemeralBase64,

    };



    // Generate ephemeral ECDH key pair.

    this.ephemeralKeyPair =

      await generateEphemeralEcdh();



    this.localChallenge =

      generateChallenge();



    // Sign caller's challenge.

    const callerChallengeBytes =

      new Uint8Array(

        base64ToBuffer(

          callerChallengeBase64

        )

      );



    const signatureBase64 =

      await signHandshakeChallenge(

        this.localIdentity,

        callerChallengeBytes,

        this.ephemeralKeyPair.rawPublicKey

      );



    // Import caller ephemeral key.

    const callerEphemeralKey =

      await importEphemeralPublicKey(

        base64ToBuffer(

          callerEphemeralBase64

        )

      );



    // Derive shared session key.

    this.sessionKey =

      await deriveSessionKey(

        this.ephemeralKeyPair.keyPair.privateKey,

        callerEphemeralKey

      );



    // Compute safety number.

    const callerSpki =

      base64ToBuffer(

        callerSpkiBase64

      );



    this.safetyNumber =

      await computeSafetyNumber(

        this.localIdentity.publicKeySpki,

        callerSpki

      );



    // Send acceptance.

    this.signalingSocket.send({

      type: 'connect_response',

      to: normalizeId(callerId),



      accepted: true,



      responderId:

        normalizeId(

          this.localIdentity.id

        ),



      responderSpkiBase64:

        this.localIdentity.publicKeyBase64,



      responderEphemeralBase64:

        this.ephemeralKeyPair

          .base64PublicKey,



      challengeBase64:

        bufferToBase64(

          this.localChallenge.buffer

        ),



      signatureBase64,

    });



    // Build WebRTC peer connection.

    await this.buildPeerConnection(false);

  }



  // ---------------------------------------------------------------------------

  // Connect to peer

  // ---------------------------------------------------------------------------



  public async connectToPeer(

    targetId: string

  ): Promise<void> {

    const cleanTargetId =

      normalizeId(targetId);



    const localId =

      normalizeId(

        this.localIdentity.id

      );



    if (

      !cleanTargetId ||

      cleanTargetId === localId

    ) {

      throw new Error(

        'Cannot dial own ID or empty ID'

      );

    }



    if (!this.signalingReady) {

      throw new Error(

        'Signaling server not connected yet. Please wait a moment.'

      );

    }



    this.setStatus(

      'signaling',

      `Requesting connection to ${targetId}...`

    );



    this.remotePeerId =

      cleanTargetId;



    // Generate ephemeral ECDH keypair.

    this.ephemeralKeyPair =

      await generateEphemeralEcdh();



    this.localChallenge =

      generateChallenge();



    console.log(

      '[Signaling] Sending connect request:',

      {

        from: localId,

        to: cleanTargetId,

      }

    );



    this.signalingSocket.send({

      type: 'connect_request',



      from: localId,



      to: cleanTargetId,



      callerSpkiBase64:

        this.localIdentity.publicKeyBase64,



      callerEphemeralBase64:

        this.ephemeralKeyPair

          .base64PublicKey,



      callerChallengeBase64:

        bufferToBase64(

          this.localChallenge.buffer

        ),

    });



    this.setStatus(

      'signaling',

      'Waiting for peer to accept...'

    );

  }



  // ---------------------------------------------------------------------------

  // Connect response

  // ---------------------------------------------------------------------------



  private async handleConnectResponse(

    msg: Record<string, unknown>

  ) {

    const accepted =

      msg.accepted as boolean;



    if (!accepted) {

      this.setStatus(

        'rejected',

        (msg.reason as string) ||

        'Peer declined connection request'

      );



      this.remotePeerId = '';



      return;

    }



    this.setStatus(

      'authenticating',

      'Peer accepted. Verifying cryptographic credentials...'

    );



    const responderId =

      normalizeId(

        msg.responderId as string

      );



    const responderSpkiBase64 =

      msg.responderSpkiBase64 as string;



    const responderEphemeralBase64 =

      msg.responderEphemeralBase64 as string;



    const challengeBase64 =

      msg.challengeBase64 as string;



    const signatureBase64 =

      msg.signatureBase64 as string;



    // Authenticate responder.

    const authResult =

      await verifyHandshakeResponse({

        expectedId:

          normalizeId(

            this.remotePeerId

          ),



        remoteIdentitySpkiBase64:

          responderSpkiBase64,



        remoteEphemeralRawBase64:

          responderEphemeralBase64,



        localChallenge:

          this.localChallenge!,



        signatureBase64,

      });



    if (!authResult.valid) {

      this.setStatus(

        'failed',

        `Handshake validation failed: ${authResult.reason}`

      );



      return;

    }



    // Use normalized authenticated responder ID.

    this.remotePeerId =

      responderId;



    // Derive shared session key.

    const responderEphemeralKey =

      await importEphemeralPublicKey(

        base64ToBuffer(

          responderEphemeralBase64

        )

      );



    this.sessionKey =

      await deriveSessionKey(

        this.ephemeralKeyPair!

          .keyPair.privateKey,

        responderEphemeralKey

      );



    // Compute safety number.

    const remoteSpkiBuffer =

      base64ToBuffer(

        responderSpkiBase64

      );



    this.safetyNumber =

      await computeSafetyNumber(

        this.localIdentity.publicKeySpki,

        remoteSpkiBuffer

      );



    // Sign responder's challenge.

    const responderChallengeBytes =

      new Uint8Array(

        base64ToBuffer(

          challengeBase64

        )

      );



    const myConfirmSignature =

      await signHandshakeChallenge(

        this.localIdentity,

        responderChallengeBytes,

        this.ephemeralKeyPair!

          .rawPublicKey

      );



    // Send confirmation.

    this.signalingSocket.send({

      type: 'handshake_confirm',



      to: normalizeId(

        this.remotePeerId

      ),



      confirmSignatureBase64:

        myConfirmSignature,

    });



    // Caller creates WebRTC offer.

    await this.buildPeerConnection(true);

  }



  // ---------------------------------------------------------------------------

  // Handshake confirmation

  // ---------------------------------------------------------------------------



  private async handleHandshakeConfirm(

    msg: Record<string, unknown>

  ): Promise<void> {

    const pending =

      this.awaitingCallerConfirm;



    if (

      !pending ||

      !this.localChallenge

    ) {

      console.warn(

        '[Handshake] Received confirm with no pending verification â€” ignoring'

      );



      return;

    }



    const confirmSignatureBase64 =

      msg.confirmSignatureBase64 as string;



    const authResult =

      await verifyHandshakeResponse({

        expectedId:

          normalizeId(

            pending.callerId

          ),



        remoteIdentitySpkiBase64:

          pending.callerSpkiBase64,



        remoteEphemeralRawBase64:

          pending.callerEphemeralBase64,



        localChallenge:

          this.localChallenge,



        signatureBase64:

          confirmSignatureBase64,

      });



    this.awaitingCallerConfirm = null;



    if (!authResult.valid) {

      this.disconnect(

        `Caller confirmation failed: ${authResult.reason}. Possible MITM â€” connection aborted.`

      );



      return;

    }



    this.callerConfirmedOk = true;



    // Release pending DataChannel.

    if (this.pendingDataChannel) {

      const dc =

        this.pendingDataChannel;



      this.pendingDataChannel = null;



      this.initializeReliableTransport(

        dc

      );

    }

  }



  // ---------------------------------------------------------------------------

  // WebRTC peer connection

  // ---------------------------------------------------------------------------



  private async buildPeerConnection(

    isOfferer: boolean

  ): Promise<void> {

    this.closeRtc();



    const pc =

      new RTCPeerConnection({

        iceServers: TURN_CONFIG,

      });



    this.pc = pc;



    // ICE candidate trickle.

    pc.onicecandidate = (event) => {

      if (event.candidate) {

        this.signalingSocket.send({

          type: 'ice_candidate',



          to: normalizeId(

            this.remotePeerId

          ),



          payload:

            event.candidate.toJSON(),

        });

      }

    };



    pc.onconnectionstatechange = () => {

      console.log(

        '[WebRTC] Connection state:',

        pc.connectionState

      );



      if (

        pc.connectionState ===

        'failed'

      ) {

        this.disconnect(

          'WebRTC connection failed'

        );

      }

    };



    // IMPORTANT:

    // No pc.ontrack handler.

    // CipherLink no longer supports voice/video calls.



    if (isOfferer) {

      // Caller creates DataChannel.

      const dc =

        pc.createDataChannel(

          'cipherlink-reliable',

          {

            ordered: true,

          }

        );



      this.setupDataChannel(dc);



      const offer =

        await pc.createOffer();



      await pc.setLocalDescription(

        offer

      );



      this.signalingSocket.send({

        type: 'sdp_offer',



        to: normalizeId(

          this.remotePeerId

        ),



        payload: {

          sdp: offer.sdp,

          type: offer.type,

        },

      });

    } else {

      // Callee waits for DataChannel.

      pc.ondatachannel = (

        event

      ) => {

        this.setupDataChannel(

          event.channel

        );

      };

    }

  }



  // ---------------------------------------------------------------------------

  // SDP Offer

  // ---------------------------------------------------------------------------



  private async handleSdpOffer(

    msg: Record<string, unknown>

  ) {

    if (!this.pc) {

      console.warn(

        '[WebRTC] Received SDP offer but no peer connection â€” ignoring'

      );



      return;

    }



    const payload =

      msg.payload as RTCSessionDescriptionInit;



    await this.pc.setRemoteDescription(

      payload

    );



    const answer =

      await this.pc.createAnswer();



    await this.pc.setLocalDescription(

      answer

    );



    const senderId =

      normalizeId(

        (msg.from as string) ||

        this.remotePeerId

      );



    this.signalingSocket.send({

      type: 'sdp_answer',



      to: senderId,



      from: normalizeId(

        this.localIdentity.id

      ),



      payload: {

        sdp: answer.sdp,

        type: answer.type,

      },

    });

  }



  // ---------------------------------------------------------------------------

  // SDP Answer

  // ---------------------------------------------------------------------------



  private async handleSdpAnswer(

    msg: Record<string, unknown>

  ) {

    if (!this.pc) return;



    const payload =

      msg.payload as RTCSessionDescriptionInit;



    await this.pc.setRemoteDescription(

      payload

    );

  }



  // ---------------------------------------------------------------------------

  // ICE Candidate

  // ---------------------------------------------------------------------------



  private async handleIceCandidate(

    msg: Record<string, unknown>

  ) {

    if (!this.pc) return;



    try {

      await this.pc.addIceCandidate(

        msg.payload as RTCIceCandidateInit

      );

    } catch (e) {

      console.warn(

        '[WebRTC] Failed to add ICE candidate',

        e

      );

    }

  }



  // ---------------------------------------------------------------------------

  // DataChannel

  // ---------------------------------------------------------------------------



  private setupDataChannel(

    dc: RTCDataChannel

  ) {

    this.dataChannel = dc;



    dc.onopen = () => {

      console.log(

        '[DataChannel] Open'

      );



      // Wait for caller confirmation.

      if (

        this.awaitingCallerConfirm

      ) {

        console.log(

          '[DataChannel] Open but awaiting caller confirmation â€” holding'

        );



        this.pendingDataChannel = dc;



        return;

      }



      this.initializeReliableTransport(

        dc

      );

    };



    dc.onerror = (event) => {

      console.error(

        '[DataChannel] Error',

        event

      );

    };



    dc.onclose = () => {

      if (

        this.status ===

        'connected'

      ) {

        this.disconnect(

          'DataChannel closed'

        );

      }

    };

  }



  // ---------------------------------------------------------------------------

  // ReliableTransport

  // ---------------------------------------------------------------------------



  private initializeReliableTransport(

    dc: RTCDataChannel

  ) {

    if (this.reliableTransport) {

      this.reliableTransport.destroy();

    }



    this.reliableTransport =

      new ReliableTransport({

        initialRtoMs: 200,

        maxRtoMs: 4000,

        maxRetries: 8,



        sendRaw: (

          packet: TransportPacket

        ) => {

          if (

            dc.readyState ===

            'open'

          ) {

            dc.send(

              JSON.stringify(packet)

            );

          }

        },



        onDelivered:

          async (

            packet: TransportPacket

          ) => {

            if (

              packet.type === 'DATA' &&

              packet.payload &&

              this.sessionKey

            ) {

              try {

                const decryptedBytes =

                  await decryptPayload(

                    this.sessionKey,

                    packet.payload

                  );



                const text =

                  new TextDecoder()

                    .decode(

                      decryptedBytes

                    );



                this.callbacks.onMessageReceived(

                  text,

                  packet.timestamp,

                  packet.seq || 0

                );

              } catch (err: any) {

                console.error(

                  '[PeerSignaling] Decryption failed for DATA packet seq',

                  packet.seq,

                  err

                );

              }

            } else if (

              packet.type ===

              'FILE_CHUNK'

            ) {

              this.callbacks.onFileChunkReceived(

                packet

              );

            }

          },



        onMetricsChange:

          (

            metrics: NetworkMetrics

          ) => {

            this.callbacks.onMetricsChange(

              metrics

            );

          },

      });



    // Raw DataChannel messages.

    dc.onmessage = (

      event: MessageEvent

    ) => {

      try {

        const packet =

          JSON.parse(

            event.data as string

          ) as TransportPacket;



        if (

          this.reliableTransport

        ) {

          this.reliableTransport.handleIncoming(

            packet

          );

        }

      } catch {

        console.warn(

          '[DataChannel] Failed to parse packet'

        );

      }

    };



    this.setStatus(

      'connected'

    );



    this.callbacks.onConnected({

      peerId:

        this.remotePeerId,



      safetyNumber:

        this.safetyNumber,



      sessionKey:

        this.sessionKey!,



      reliableTransport:

        this.reliableTransport,

    });

  }



  // ---------------------------------------------------------------------------

  // Send chat message

  // ---------------------------------------------------------------------------



  public async sendChatMessage(

    text: string

  ): Promise<number | null> {

    if (

      !this.sessionKey ||

      !this.reliableTransport

    ) {

      throw new Error(

        'Cannot send message: Not connected or session key missing'

      );

    }



    const encrypted =

      await encryptPayload(

        this.sessionKey,

        text

      );



    return this.reliableTransport.send({

      type: 'DATA',

      payload: encrypted,

    });

  }



  // ---------------------------------------------------------------------------

  // Close WebRTC

  // ---------------------------------------------------------------------------



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



  // ---------------------------------------------------------------------------

  // Disconnect

  // ---------------------------------------------------------------------------



  public disconnect(

    reason = 'Disconnected'

  ): void {

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



    this.setStatus(

      'disconnected',

      reason

    );



    this.callbacks.onDisconnected();

  }



  // ---------------------------------------------------------------------------

  // Destroy

  // ---------------------------------------------------------------------------



  public destroy(): void {

    this.disconnect();



    this.signalingSocket.close();



    this.signalingReady = false;

  }

}



// -----------------------------------------------------------------------------

// Utility â€” backward compatibility

// -----------------------------------------------------------------------------



export async function deriveRoomName(

  id: string

): Promise<string> {

  const norm =

    normalizeId(id);



  const data =

    new TextEncoder().encode(

      `cipherlink:room:v1:${norm}`

    );



  const hash =

    await crypto.subtle.digest(

      'SHA-256',

      data

    );



  const hex =

    Array.from(

      new Uint8Array(hash)

    )

      .map(

        (b) =>

          b

            .toString(16)

            .padStart(2, '0')

      )

      .join('');



  return `cl-${hex.slice(0, 16)}`;

}