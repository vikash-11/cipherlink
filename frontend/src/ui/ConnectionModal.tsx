import React, { useState } from 'react';
import {
  Radio,
  UserCheck,
  UserX,
  PhoneCall,
  ShieldCheck,
  X,
  ArrowRight,
  AlertCircle,
} from 'lucide-react';
import { formatId, normalizeId, isValidId } from '../crypto/crockford';
import type { IncomingRequest } from '../network/peerSignaling';

interface ConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (targetId: string) => void;
  incomingRequest: IncomingRequest | null;
  onAcceptIncoming: () => void;
  onRejectIncoming: () => void;
  isConnecting: boolean;
  connectingStatusText?: string;
}

export const ConnectionModal: React.FC<ConnectionModalProps> = ({
  isOpen,
  onClose,
  onConnect,
  incomingRequest,
  onAcceptIncoming,
  onRejectIncoming,
  isConnecting,
  connectingStatusText,
}) => {
  const [peerInput, setPeerInput] = useState('');
  const [inputError, setInputError] = useState('');

  if (!isOpen && !incomingRequest) return null;

  // Handle Input Change with automatic grouping
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    const clean = normalizeId(raw);
    setInputError('');
    if (clean.length <= 12) {
      setPeerInput(formatId(clean));
    }
  };

  const handleStartConnect = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = normalizeId(peerInput);
    if (!isValidId(clean)) {
      setInputError('Please enter a valid 12-character Crockford ID (e.g. K7M2-9QXA-4TBD)');
      return;
    }
    onConnect(formatId(clean));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn">
      {/* CASE 1: Incoming Connection Prompt (User B dialed User A) */}
      {incomingRequest ? (
        <div className="relative w-full max-w-md rounded-2xl bg-gradient-to-b from-[#182033] to-[#0c101d] border border-emerald-500/40 p-6 shadow-2xl shadow-emerald-950/40 text-slate-100">
          <div className="flex items-center gap-3 mb-5">
            <div className="relative p-3 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
              <PhoneCall className="w-6 h-6 animate-bounce" />
              <span className="absolute -top-1 -right-1 flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
              </span>
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Incoming Connection Request</h2>
              <p className="text-xs text-emerald-400 font-mono">Explicit Authorization Required</p>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 mb-6">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">
              Requesting Peer ID
            </span>
            <div className="text-xl font-mono font-bold text-emerald-400 tracking-wider">
              {incomingRequest.callerId}
            </div>
            <div className="flex items-center gap-1.5 mt-2 text-xs text-slate-400">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Public key verified against derived ID</span>
            </div>
          </div>

          <p className="text-xs text-slate-300 leading-relaxed mb-6">
            Connecting will establish a direct, zero-knowledge WebRTC channel with bilateral ECDH session encryption. No data will be sent until you accept.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={onRejectIncoming}
              className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-rose-300 border border-rose-500/20 text-xs font-semibold transition-colors"
            >
              <UserX className="w-4 h-4" />
              Decline
            </button>
            <button
              onClick={onAcceptIncoming}
              className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-950/50 text-xs font-semibold transition-all transform active:scale-95"
            >
              <UserCheck className="w-4 h-4" />
              Accept & Connect
            </button>
          </div>
        </div>
      ) : (
        /* CASE 2: Outgoing Dial Dialog */
        <div className="relative w-full max-w-md rounded-2xl bg-gradient-to-b from-[#131b2c] to-[#0c101d] border border-slate-700/80 p-6 shadow-2xl text-slate-100">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-3 mb-6">
            <div className="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
              <Radio className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Connect to Peer</h2>
              <p className="text-xs text-slate-400">Enter a 12-character CipherLink Peer ID</p>
            </div>
          </div>

          {isConnecting ? (
            <div className="p-6 rounded-xl bg-slate-900/80 border border-slate-800 text-center space-y-4 my-2">
              <div className="inline-block p-4 rounded-full bg-cyan-500/10 text-cyan-400">
                <Radio className="w-8 h-8 animate-spin" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">Establishing P2P Handshake</h3>
                <p className="text-xs text-slate-400 mt-1 font-mono">
                  {connectingStatusText || 'Waiting for peer response...'}
                </p>
              </div>
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-300"
              >
                Cancel
              </button>
            </div>
          ) : (
            <form onSubmit={handleStartConnect} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                  Peer ID (Grouped 12 Characters)
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={peerInput}
                    onChange={handleInputChange}
                    placeholder="e.g. K7M2-9QXA-4TBD"
                    className="w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-700 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 font-mono text-base tracking-wider text-emerald-400 placeholder:text-slate-600 focus:outline-none transition-all uppercase"
                    autoFocus
                  />
                </div>
                {inputError && (
                  <p className="text-xs text-rose-400 mt-1.5 flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    {inputError}
                  </p>
                )}
              </div>

              <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800/80 text-xs text-slate-400 space-y-1">
                <div className="flex items-center gap-1.5 text-slate-300 font-medium">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span>Self-Hosted Signaling</span>
                </div>
                <p>
                  Peers find each other via a signaling server that relays only the connection handshake in memory — it never sees message content, and your session persists nothing after you disconnect.
                </p>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white shadow-lg shadow-emerald-950/50 transition-all transform active:scale-95"
                >
                  <span>Request Connection</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
};
