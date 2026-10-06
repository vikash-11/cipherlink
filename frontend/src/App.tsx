import React, { useState, useEffect, useRef } from 'react';

import { Navbar } from './ui/Navbar';
import { IdentityCard } from './ui/IdentityCard';
import { ConnectionModal } from './ui/ConnectionModal';
import { ChatView } from './ui/ChatView';
import { LandingPage } from './ui/LandingPage';
import { FileTransferModal } from './ui/FileTransferModal';

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

import type {
  ChatMessage,
  ConnectionStatus,
  FileTransferState,
  NetworkMetrics,
} from './network/types';


export const App: React.FC = () => {

  // -------------------------------------------------------------------------
  // Identity State
  // -------------------------------------------------------------------------

  const [identity, setIdentity] =
    useState<UserIdentity | null>(null);


  // -------------------------------------------------------------------------
  // Connection & Session State
  // -------------------------------------------------------------------------

  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('disconnected');

  const [statusDetail, setStatusDetail] =
    useState<string>('');

  const [connectedPeerId, setConnectedPeerId] =
    useState<string>('');

  const [safetyNumber, setSafetyNumber] =
    useState<string>('');

  const [incomingRequest, setIncomingRequest] =
    useState<IncomingRequest | null>(null);


  // -------------------------------------------------------------------------
  // Messaging & File State
  // -------------------------------------------------------------------------

  const [messages, setMessages] =
    useState<ChatMessage[]>([]);

  const [activeTransfer, setActiveTransfer] =
    useState<FileTransferState | null>(null);


  // -------------------------------------------------------------------------
  // Modal Visibility
  // -------------------------------------------------------------------------

  const [isIdentityOpen, setIsIdentityOpen] =
    useState<boolean>(false);

  const [isConnectModalOpen, setIsConnectModalOpen] =
    useState<boolean>(false);

  const [isFileModalOpen, setIsFileModalOpen] =
    useState<boolean>(false);


  // -------------------------------------------------------------------------
  // References to managers
  // -------------------------------------------------------------------------

  const peerManagerRef =
    useRef<PeerSessionManager | null>(null);

  const fileManagerRef =
    useRef<FileTransferManager | null>(null);

  // Keeps the active session key available to callbacks.
  const sessionKeyRef =
    useRef<CryptoKey | null>(null);

  // Keeps the current peer ID available to stable callbacks.
  const connectedPeerIdRef =
    useRef<string>('');


  // -------------------------------------------------------------------------
  // Initialize Cryptographic Identity
  // -------------------------------------------------------------------------

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


  // -------------------------------------------------------------------------
  // Initialize Peer Session Manager
  // -------------------------------------------------------------------------

  useEffect(() => {

    if (!identity) {
      return;
    }


    const manager =
      new PeerSessionManager(identity, {

        // ---------------------------------------------------------------
        // Status
        // ---------------------------------------------------------------

        onStatusChange: (
          status,
          detail
        ) => {

          setConnectionStatus(status);

          setStatusDetail(
            detail || ''
          );
        },


        // ---------------------------------------------------------------
        // Incoming Connection
        // ---------------------------------------------------------------

        onIncomingRequest: (
          req
        ) => {

          setIncomingRequest(req);
        },


        // ---------------------------------------------------------------
        // Connected
        // ---------------------------------------------------------------

        onConnected: ({
          peerId,
          safetyNumber: sn,
          sessionKey,
          reliableTransport,
        }) => {

          setConnectedPeerId(peerId);

          connectedPeerIdRef.current =
            peerId;

          setSafetyNumber(sn);

          setIsConnectModalOpen(false);

          setIncomingRequest(null);

          sessionKeyRef.current =
            sessionKey;


          // -----------------------------------------------------------
          // File Transfer Manager
          // -----------------------------------------------------------

          const ftm =
            new FileTransferManager(
              reliableTransport,
              sessionKey
            );


          ftm.setOnProgress(
            (state) => {

              setActiveTransfer({
                ...state,
              });

            }
          );


          fileManagerRef.current =
            ftm;


          // -----------------------------------------------------------
          // System Message
          // -----------------------------------------------------------

          setMessages([
            {
              id:
                'handshake-' +
                Date.now(),

              seq: 0,

              senderId:
                'SYSTEM',

              text:
                `🔒 Peer connection verified! Bilateral ECDH session key established. Signal Safety Number: ${sn}`,

              timestamp:
                Date.now(),

              isSelf:
                false,

              status:
                'delivered',

              retransmits:
                0,
            },
          ]);
        },


        // ---------------------------------------------------------------
        // Disconnected
        // ---------------------------------------------------------------

        onDisconnected: () => {

          setConnectedPeerId('');

          connectedPeerIdRef.current =
            '';

          setSafetyNumber('');

          setMessages([]);

          setActiveTransfer(null);

          fileManagerRef.current =
            null;

          sessionKeyRef.current =
            null;
        },


        // ---------------------------------------------------------------
        // Incoming Message
        // ---------------------------------------------------------------

        onMessageReceived: (
          text,
          timestamp,
          seq
        ) => {

          setMessages((prev) => [

            ...prev,

            {
              id:
                'msg-' +
                Date.now() +
                '-' +
                Math.random(),

              seq,

              senderId:
                connectedPeerIdRef.current ||
                'Peer',

              text,

              timestamp,

              isSelf:
                false,

              status:
                'delivered',

              retransmits:
                0,
            },

          ]);
        },


        // ---------------------------------------------------------------
        // Incoming File Chunk
        // ---------------------------------------------------------------

        onFileChunkReceived: (
          packet
        ) => {

          if (
            fileManagerRef.current
          ) {

            fileManagerRef.current
              .handleIncomingChunk(packet);

          }
        },


        // ---------------------------------------------------------------
        // Metrics
        // ---------------------------------------------------------------

        onMetricsChange: (
          _newMetrics: NetworkMetrics
        ) => {

          // Metrics UI is not displayed.
        },

      });


    peerManagerRef.current =
      manager;


    manager.startListening();


    return () => {

      manager.destroy();

    };

  }, [identity]);


  // -------------------------------------------------------------------------
  // Connect to Peer
  // -------------------------------------------------------------------------

  const handleConnect = async (
    targetId: string
  ) => {

    if (
      !peerManagerRef.current
    ) {
      return;
    }


    try {

      await peerManagerRef.current
        .connectToPeer(targetId);

    } catch (err: any) {

      alert(
        err.message
      );

    }
  };


  // -------------------------------------------------------------------------
  // Accept Incoming Request
  // -------------------------------------------------------------------------

  const handleAcceptIncoming =
    async () => {

      if (incomingRequest) {

        await incomingRequest.accept();

        setIncomingRequest(null);
      }
    };


  // -------------------------------------------------------------------------
  // Reject Incoming Request
  // -------------------------------------------------------------------------

  const handleRejectIncoming =
    () => {

      if (incomingRequest) {

        incomingRequest.reject(
          'Declined by user'
        );

        setIncomingRequest(null);
      }
    };


  // -------------------------------------------------------------------------
  // Close Connection Modal
  // -------------------------------------------------------------------------

  const handleCloseConnectModal =
    () => {

      const status =
        peerManagerRef.current?.getStatus();


      if (
        status === 'signaling' ||
        status === 'authenticating'
      ) {

        peerManagerRef.current?.disconnect(
          'Cancelled by user'
        );
      }


      setIsConnectModalOpen(
        false
      );
    };


  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------

  const handleDisconnect =
    () => {

      if (
        peerManagerRef.current
      ) {

        peerManagerRef.current
          .disconnect();
      }


      setConnectionStatus(
        'disconnected'
      );
    };


  // -------------------------------------------------------------------------
  // Send Chat Message
  // -------------------------------------------------------------------------

  const handleSendMessage =
    async (
      text: string
    ) => {

      if (
        !peerManagerRef.current
      ) {
        return;
      }


      const seq =
        await peerManagerRef.current
          .sendChatMessage(text);


      if (seq !== null) {

        const newMsg: ChatMessage = {

          id:
            'msg-' +
            Date.now() +
            '-' +
            Math.random(),

          seq,

          senderId:
            identity?.id ||
            'Me',

          text,

          timestamp:
            Date.now(),

          isSelf:
            true,

          status:
            'sent',

          retransmits:
            0,
        };


        setMessages((prev) => [
          ...prev,
          newMsg,
        ]);
      }
    };


  // -------------------------------------------------------------------------
  // Send File
  // -------------------------------------------------------------------------

  const handleSendFile =
    async (
      file: File
    ) => {

      if (
        fileManagerRef.current
      ) {

        await fileManagerRef.current
          .sendFile(file);
      }
    };


  // -------------------------------------------------------------------------
  // Reset Identity
  // -------------------------------------------------------------------------

  const handleResetIdentity =
    async () => {

      await resetIdentity();

      const newId =
        await getOrCreateIdentity();

      setIdentity(newId);
    };


  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (

    <div
      className="
        flex
        flex-col
        h-screen
        bg-[#090d16]
        text-slate-100
        font-sans
        select-none
        overflow-hidden
      "
    >

      {/* ------------------------------------------------------------------ */}
      {/* Top Navigation                                                     */}
      {/* ------------------------------------------------------------------ */}

      <Navbar
        localId={
          identity?.id || ''
        }

        status={
          connectionStatus
        }

        statusDetail={
          statusDetail
        }

        onOpenIdentity={() =>
          setIsIdentityOpen(true)
        }
      />


      {/* ------------------------------------------------------------------ */}
      {/* Main Content                                                       */}
      {/* ------------------------------------------------------------------ */}

      <main
        className="
          flex-1
          flex
          overflow-hidden
        "
      >

        {connectionStatus === 'connected' ? (

          <ChatView

            messages={
              messages
            }

            onSendMessage={
              handleSendMessage
            }

            onOpenFileTransfer={() =>
              setIsFileModalOpen(true)
            }

            onDisconnect={
              handleDisconnect
            }

            onOpenConnectModal={() =>
              setIsConnectModalOpen(true)
            }

            connectedPeerId={
              connectedPeerId
            }

            safetyNumber={
              safetyNumber
            }

            connectionStatus={
              connectionStatus
            }

          />

        ) : (

          <LandingPage

            localId={
              identity?.id || ''
            }

            connectionStatus={
              connectionStatus
            }

            statusDetail={
              statusDetail
            }

            onOpenConnectModal={() =>
              setIsConnectModalOpen(true)
            }

          />

        )}

      </main>


      {/* ------------------------------------------------------------------ */}
      {/* Identity Modal                                                     */}
      {/* ------------------------------------------------------------------ */}

      <IdentityCard

        identity={
          identity
        }

        isOpen={
          isIdentityOpen
        }

        onClose={() =>
          setIsIdentityOpen(false)
        }

        onResetIdentity={
          handleResetIdentity
        }

        peerSafetyNumber={
          safetyNumber
        }

        connectedPeerId={
          connectedPeerId
        }

      />


      {/* ------------------------------------------------------------------ */}
      {/* Connection Modal                                                   */}
      {/* ------------------------------------------------------------------ */}

      <ConnectionModal

        isOpen={
          isConnectModalOpen
        }

        onClose={
          handleCloseConnectModal
        }

        onConnect={
          handleConnect
        }

        incomingRequest={
          incomingRequest
        }

        onAcceptIncoming={
          handleAcceptIncoming
        }

        onRejectIncoming={
          handleRejectIncoming
        }

        isConnecting={
          connectionStatus === 'signaling' ||
          connectionStatus === 'authenticating'
        }

        connectingStatusText={
          statusDetail
        }

      />


      {/* ------------------------------------------------------------------ */}
      {/* File Transfer Modal                                                */}
      {/* ------------------------------------------------------------------ */}

      <FileTransferModal

        isOpen={
          isFileModalOpen
        }

        onClose={() =>
          setIsFileModalOpen(false)
        }

        onSendFile={
          handleSendFile
        }

        activeTransfer={
          activeTransfer
        }

      />

    </div>
  );
};


export default App;