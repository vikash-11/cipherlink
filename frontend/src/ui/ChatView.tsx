import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  Paperclip,
  Phone,
  Video,
  ShieldCheck,
  Check,
  CheckCheck,
  Clock,
  RefreshCw,
  LogOut,
  UserPlus,
  Lock,
} from 'lucide-react';
import type { ChatMessage, ConnectionStatus } from '../network/types';

interface ChatViewProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  onOpenFileTransfer: () => void;
  onStartAudioCall: () => void;
  onStartVideoCall: () => void;
  onDisconnect: () => void;
  onOpenConnectModal: () => void;
  connectedPeerId?: string;
  safetyNumber?: string;
  connectionStatus: ConnectionStatus;
}

export const ChatView: React.FC<ChatViewProps> = ({
  messages,
  onSendMessage,
  onOpenFileTransfer,
  onStartAudioCall,
  onStartVideoCall,
  onDisconnect,
  onOpenConnectModal,
  connectedPeerId,
  safetyNumber,
  connectionStatus,
}) => {
  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    onSendMessage(inputText.trim());
    setInputText('');
  };

  // Only show chat UI when fully connected (Bug fix #3)
  if (connectionStatus !== 'connected') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center max-w-lg mx-auto">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-emerald-500/20 to-teal-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mb-6 shadow-xl shadow-emerald-950/20">
          <Lock className="w-8 h-8" />
        </div>
        <h2 className="text-2xl font-bold text-white mb-2">No Active Peer Session</h2>
        <p className="text-sm text-slate-400 mb-8 leading-relaxed">
          CipherLink is a zero-knowledge, serverless messenger. All messages and files are
          transmitted directly between browsers using WebRTC and authenticated with ECDSA identity
          keys. No account, no server, no logs.
        </p>

        {(connectionStatus === 'signaling' || connectionStatus === 'authenticating') && (
          <div className="mb-6 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-sm text-amber-300 font-mono w-full">
            {connectionStatus === 'signaling'
              ? '🔄 Waiting for peer to join the rendezvous room...'
              : '🔐 Peer joined — performing cryptographic handshake...'}
          </div>
        )}

        {(connectionStatus === 'rejected' || connectionStatus === 'failed') && (
          <div className="mb-6 px-4 py-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-sm text-rose-300 font-mono w-full">
            {connectionStatus === 'rejected'
              ? '✗ Peer declined the connection request.'
              : '✗ Handshake failed — peer identity could not be verified.'}
          </div>
        )}

        <button
          onClick={onOpenConnectModal}
          className="flex items-center justify-center gap-2 w-full px-5 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm transition-all shadow-lg shadow-emerald-950/40"
        >
          <UserPlus className="w-4 h-4" />
          Connect to Peer ID
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-[#0a0e18] overflow-hidden">
      {/* Top Session Bar */}
      <div className="px-4 py-3 border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-sm flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-white font-mono">
                {connectedPeerId}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-mono border border-emerald-500/20">
                AES-256-GCM
              </span>
            </div>
            {safetyNumber && (
              <p className="text-[11px] text-slate-400 font-mono truncate">
                Safety SAS: <span className="text-emerald-400">{safetyNumber.slice(0, 17)}...</span>
              </p>
            )}
          </div>
        </div>

        {/* Session Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={onStartAudioCall}
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-emerald-400 transition-colors"
            title="Start Encrypted Voice Call"
          >
            <Phone className="w-4 h-4" />
          </button>
          <button
            onClick={onStartVideoCall}
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-emerald-400 transition-colors"
            title="Start Encrypted Video Call"
          >
            <Video className="w-4 h-4" />
          </button>
          <button
            onClick={onDisconnect}
            className="p-2 rounded-xl bg-slate-800 hover:bg-rose-900/40 text-slate-300 hover:text-rose-400 transition-colors"
            title="Disconnect Session"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Message Timeline */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
        {/* Security Banner */}
        <div className="mx-auto max-w-md p-3 rounded-xl bg-slate-900/50 border border-slate-800/80 text-center">
          <div className="flex items-center justify-center gap-1.5 text-xs text-emerald-400 font-medium mb-1">
            <Lock className="w-3.5 h-3.5" />
            <span>End-to-End Encrypted Session</span>
          </div>
          <p className="text-[11px] text-slate-400 leading-normal">
            Messages flow directly over WebRTC with custom sequence numbering,
            acknowledgements, and AES-256-GCM AEAD encryption.
          </p>
        </div>

        {messages.map((msg) => {
          const isMe = msg.isSelf;
          return (
            <div
              key={msg.id}
              className={`flex flex-col ${isMe ? 'items-end' : 'items-start'} space-y-1 animate-fadeIn`}
            >
              <div
                className={`max-w-[85%] sm:max-w-md px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                  isMe
                    ? 'bg-emerald-600 text-white rounded-br-xs shadow-md shadow-emerald-950/30'
                    : 'bg-slate-800/90 text-slate-100 rounded-bl-xs border border-slate-700/60'
                }`}
              >
                <p className="break-words select-text">{msg.text}</p>
              </div>

              {/* Message Metadata */}
              <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-500 px-1">
                <span>Seq #{msg.seq}</span>
                <span>•</span>
                <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>

                {isMe && (
                  <>
                    <span>•</span>
                    {msg.status === 'delivered' ? (
                      <span className="flex items-center gap-1 text-emerald-400">
                        <CheckCheck className="w-3 h-3" />
                        {msg.rtt ? `${msg.rtt}ms RTT` : 'ACKed'}
                      </span>
                    ) : msg.status === 'sent' ? (
                      <span className="flex items-center gap-1 text-slate-400">
                        <Check className="w-3 h-3" />
                        Sent
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-amber-400">
                        <Clock className="w-3 h-3 animate-spin" />
                        Transmitting
                      </span>
                    )}

                    {msg.retransmits > 0 && (
                      <span className="flex items-center gap-0.5 text-amber-400">
                        <RefreshCw className="w-2.5 h-2.5" />
                        {msg.retransmits}×
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Bar */}
      <form
        onSubmit={handleSend}
        className="p-3 sm:p-4 border-t border-slate-800/80 bg-slate-900/60 backdrop-blur-md flex items-center gap-2"
      >
        <button
          type="button"
          onClick={onOpenFileTransfer}
          className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-emerald-400 transition-colors"
          title="Share Encrypted File (16KB Chunking + SHA-256)"
        >
          <Paperclip className="w-5 h-5" />
        </button>

        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Send an encrypted message..."
          className="flex-1 px-4 py-2.5 rounded-xl bg-slate-950 border border-slate-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none transition-all"
        />

        <button
          type="submit"
          disabled={!inputText.trim()}
          className="p-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:pointer-events-none text-white transition-all shadow-md shadow-emerald-950/40"
        >
          <Send className="w-5 h-5" />
        </button>
      </form>
    </div>
  );
};
