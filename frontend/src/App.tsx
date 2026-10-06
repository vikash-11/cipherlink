import React, { useState, useEffect, useRef } from 'react';
import { Navbar } from './ui/Navbar';
import { IdentityCard } from './ui/IdentityCard';
import { ConnectionModal } from './ui/ConnectionModal';
import { ChatView } from './ui/ChatView';
import { LandingPage } from './ui/LandingPage';
import { FileTransferModal } from './ui/FileTransferModal';
import { CallView } from './ui/CallView';

import {
  getOrCreateIdentity,
  resetIdentity,
  type UserIdentity,
} from './crypto/identity';
import {
  PeerSessionManager,
  type IncomingRequest,
} from './network/peerSignaling';
import { FileTransferManager } from './network/fileTransfer';
import { MediaCallManager } from './network/mediaCalls';
import type {
  ChatMessage,
  ConnectionStatus,
  FileTransferState,
  NetworkMetrics,
} from './network/types';

export const App: React.FC = () => {
  // Identity State
  const [identity, setIdentity] = useState<UserIdentity | null>(null);

  // Connection & Session State
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [statusDetail, setStatusDetail] = useState<string>('');
  const [connectedPeerId, setConnectedPeerId] = useState<string>('');
  const [safetyNumber, setSafetyNumber] = useState<string>('');
  const [incomingRequest, setIncomingRequest] = useState<IncomingRequest | null>(null);

  // Messaging & File State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeTransfer, setActiveTransfer] = useState<FileTransferState | null>(null);

  // Media Call State
  const [isCallOpen, setIsCallOpen] = useState<boolean>(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isScreenSharing, setIsScreenSharing] = useState<boolean>(false);

  // Modal Visibility
  const [isIdentityOpen, setIsIdentityOpen] = useState<boolean>(false);
  const [isConnectModalOpen, setIsConnectModalOpen] = useState<boolean>(false);
  const [isFileModalOpen, setIsFileModalOpen] = useState<boolean>(false);

  // References to managers
  const peerManagerRef = useRef<PeerSessionManager | null>(null);
  const fileManagerRef = useRef<FileTransferManager | null>(null);
  const mediaManagerRef = useRef<MediaCallManager | null>(null);
  // sessionKeyRef mirrors the active session key so handlers can access it without closure staleness
  const sessionKeyRef = useRef<CryptoKey | null>(null);
  // connectedPeerIdRef mirrors connectedPeerId for use inside stable callbacks (avoids stale closures)
  const connectedPeerIdRef = useRef<string>('');

  // Initialize Cryptographic Identity on load
  useEffect(() => {
    let isMounted = true;
    getOrCreateIdentity().then((id) => {
      if (isMounted) {
        setIdentity(id);
      }
    });

    return () => {
      isMounted = false;
    };
  }, []);

  // Initialize Peer Session Manager once identity is ready
  useEffect(() => {
    if (!identity) return;

    const manager = new PeerSessionManager(identity, {
      onStatusChange: (status, detail) => {
        setConnectionStatus(status);
        if (detail) setStatusDetail(detail);
      },
      onIncomingRequest: (req) => {
        setIncomingRequest(req);
      },
      onConnected: ({ peerId, safetyNumber: sn, sessionKey, reliableTransport }) => {
        setConnectedPeerId(peerId);
        connectedPeerIdRef.current = peerId; // keep ref in sync
        setSafetyNumber(sn);
        setIsConnectModalOpen(false);
        setIncomingRequest(null);
        sessionKeyRef.current = sessionKey;

        // Initialize File Transfer Manager for this session
        const ftm = new FileTransferManager(reliableTransport, sessionKey);
        ftm.setOnProgress((state) => {
          setActiveTransfer({ ...state });
        });
        fileManagerRef.current = ftm;

        // System message confirming handshake completion
        setMessages([
          {
            id: 'handshake-' + Date.now(),
            seq: 0,
            senderId: 'SYSTEM',
            text: `🔒 Peer connection verified! Bilateral ECDH session key established. Signal Safety Number: ${sn}`,
            timestamp: Date.now(),
            isSelf: false,
            status: 'delivered',
            retransmits: 0,
          },
        ]);
      },
      // Fix #6: clear ALL session state on disconnect so old messages never leak into the next session
      onDisconnected: () => {
        setConnectedPeerId('');
        connectedPeerIdRef.current = ''; // keep ref in sync
        setSafetyNumber('');
        setMessages([]);
        setActiveTransfer(null);
        fileManagerRef.current = null;
        sessionKeyRef.current = null;
      },
      onMessageReceived: (text, timestamp, seq) => {
        // Fix #6: use ref so we always get the *current* peerId, not the stale closure value
        setMessages((prev) => [
          ...prev,
          {
            id: 'msg-' + Date.now() + '-' + Math.random(),
            seq,
            senderId: connectedPeerIdRef.current || 'Peer',
            text,
            timestamp,
            isSelf: false,
            status: 'delivered',
            retransmits: 0,
          },
        ]);
      },
      onFileChunkReceived: (packet) => {
        if (fileManagerRef.current) {
          fileManagerRef.current.handleIncomingChunk(packet);
        }
      },
      onRemoteStream: (stream) => {
        setRemoteStream(stream);
        setIsCallOpen(true);
      },
      onMetricsChange: (_newMetrics: NetworkMetrics) => {
        // Metrics are not displayed (panel removed); no-op.
      },
    });

    peerManagerRef.current = manager;
    manager.startListening();

    return () => {
      manager.destroy();
    };
  }, [identity]);

  // Setup Media Call Manager
  useEffect(() => {
    const mcm = new MediaCallManager(
      {
        onLocalStream: (s) => setLocalStream(s),
        onRemoteStream: (s) => setRemoteStream(s),
        onCallEnded: () => {
          setIsCallOpen(false);
          setLocalStream(null);
          setRemoteStream(null);
          setIsScreenSharing(false);
        },
        onError: (err) => console.error('[MediaCallManager]', err),
        onScreenShareChanged: (active) => setIsScreenSharing(active),
      },
      (stream) => {
        if (peerManagerRef.current) {
          peerManagerRef.current.addMediaStream(stream);
        }
      },
      (stream) => {
        if (peerManagerRef.current) {
          peerManagerRef.current.removeMediaStream(stream);
        }
      }
    );
    mediaManagerRef.current = mcm;
  }, []);

  // Handle Outgoing Connection Request
  const handleConnect = async (targetId: string) => {
    if (!peerManagerRef.current) return;
    try {
      await peerManagerRef.current.connectToPeer(targetId);
    } catch (err: any) {
      alert(err.message);
    }
  };

  // Handle Incoming Request Accept
  const handleAcceptIncoming = async () => {
    if (incomingRequest) {
      await incomingRequest.accept();
      setIncomingRequest(null);
    }
  };

  // Handle Incoming Request Reject
  const handleRejectIncoming = () => {
    if (incomingRequest) {
      incomingRequest.reject('Declined by user');
      setIncomingRequest(null);
    }
  };

  // Handle Cancel/Close on the connection modal (Bug fix #7)
  // If user cancels while signaling/authenticating, cleanly abort so UI returns to "no session" state.
  const handleCloseConnectModal = () => {
    const status = peerManagerRef.current?.getStatus();
    if (status === 'signaling' || status === 'authenticating') {
      peerManagerRef.current?.disconnect('Cancelled by user');
    }
    setIsConnectModalOpen(false);
  };

  // Handle Disconnect (onDisconnected callback handles state cleanup via the manager)
  const handleDisconnect = () => {
    if (peerManagerRef.current) {
      peerManagerRef.current.disconnect();
    }
    setConnectionStatus('disconnected');
  };

  // Handle Send Chat Message
  const handleSendMessage = async (text: string) => {
    if (!peerManagerRef.current) return;

    // Direct P2P path (default)
    const seq = await peerManagerRef.current.sendChatMessage(text);
    if (seq !== null) {
      const newMsg: ChatMessage = {
        id: 'msg-' + Date.now() + '-' + Math.random(),
        seq,
        senderId: identity?.id || 'Me',
        text,
        timestamp: Date.now(),
        isSelf: true,
        status: 'sent',
        retransmits: 0,
      };
      setMessages((prev) => [...prev, newMsg]);
    }
  };

  // Handle Send File
  const handleSendFile = async (file: File) => {
    if (fileManagerRef.current) {
      await fileManagerRef.current.sendFile(file);
    }
  };

  // Handle Calls
  const handleStartAudioCall = async () => {
    if (mediaManagerRef.current) {
      setIsCallOpen(true);
      await mediaManagerRef.current.startMedia(false, true);
    }
  };

  const handleStartVideoCall = async () => {
    if (mediaManagerRef.current) {
      setIsCallOpen(true);
      await mediaManagerRef.current.startMedia(true, true);
    }
  };

  // Handle Reset Identity
  const handleResetIdentity = async () => {
    await resetIdentity();
    const newId = await getOrCreateIdentity();
    setIdentity(newId);
  };

  return (
    <div className="flex flex-col h-screen bg-[#090d16] text-slate-100 font-sans select-none overflow-hidden">
      {/* Top Navigation */}
      <Navbar
        localId={identity?.id || ''}
        status={connectionStatus}
        statusDetail={statusDetail}
        onOpenIdentity={() => setIsIdentityOpen(true)}
      />

      {/* Main content — Landing when idle, Chat when connected */}
      <main className="flex-1 flex overflow-hidden">
        {connectionStatus === 'connected' ? (
          <ChatView
            messages={messages}
            onSendMessage={handleSendMessage}
            onOpenFileTransfer={() => setIsFileModalOpen(true)}
            onStartAudioCall={handleStartAudioCall}
            onStartVideoCall={handleStartVideoCall}
            onDisconnect={handleDisconnect}
            onOpenConnectModal={() => setIsConnectModalOpen(true)}
            connectedPeerId={connectedPeerId}
            safetyNumber={safetyNumber}
            connectionStatus={connectionStatus}
          />
        ) : (
          <LandingPage
            localId={identity?.id || ''}
            connectionStatus={connectionStatus}
            statusDetail={statusDetail}
            onOpenConnectModal={() => setIsConnectModalOpen(true)}
          />
        )}
      </main>

      {/* Modals */}
      <IdentityCard
        identity={identity}
        isOpen={isIdentityOpen}
        onClose={() => setIsIdentityOpen(false)}
        onResetIdentity={handleResetIdentity}
        peerSafetyNumber={safetyNumber}
        connectedPeerId={connectedPeerId}
      />

      <ConnectionModal
        isOpen={isConnectModalOpen}
        onClose={handleCloseConnectModal}
        onConnect={handleConnect}
        incomingRequest={incomingRequest}
        onAcceptIncoming={handleAcceptIncoming}
        onRejectIncoming={handleRejectIncoming}
        isConnecting={connectionStatus === 'signaling' || connectionStatus === 'authenticating'}
        connectingStatusText={statusDetail}
      />

      <FileTransferModal
        isOpen={isFileModalOpen}
        onClose={() => setIsFileModalOpen(false)}
        onSendFile={handleSendFile}
        activeTransfer={activeTransfer}
      />

      <CallView
        isOpen={isCallOpen}
        onClose={() => setIsCallOpen(false)}
        localStream={localStream}
        remoteStream={remoteStream}
        peerId={connectedPeerId}
        mediaManager={mediaManagerRef.current}
        isScreenSharing={isScreenSharing}
      />
    </div>
  );
};

export default App;
