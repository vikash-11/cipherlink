import React, { useState } from 'react';
import {
  Copy,
  Check,
  KeyRound,
  ShieldCheck,
  RefreshCw,
  QrCode,
  X,
  Lock,
} from 'lucide-react';
import type { UserIdentity } from '../crypto/identity';

interface IdentityCardProps {
  identity: UserIdentity | null;
  isOpen: boolean;
  onClose: () => void;
  onResetIdentity: () => void;
  peerSafetyNumber?: string;
  connectedPeerId?: string;
}

export const IdentityCard: React.FC<IdentityCardProps> = ({
  identity,
  isOpen,
  onClose,
  onResetIdentity,
  peerSafetyNumber,
  connectedPeerId,
}) => {
  const [copied, setCopied] = useState(false);
  const [showConfirmReset, setShowConfirmReset] = useState(false);

  if (!isOpen || !identity) return null;

  const copyId = () => {
    navigator.clipboard.writeText(identity.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Generate deterministic identicon grid colors based on public key fingerprint
  const getMatrixGrid = () => {
    const hex = identity.fingerprint;
    const cells: string[] = [];
    for (let i = 0; i < 25; i++) {
      const val = parseInt(hex.charAt(i % hex.length), 16);
      if (val % 2 === 0) {
        cells.push('bg-emerald-400/80 shadow-[0_0_6px_rgba(52,211,153,0.5)]');
      } else if (val % 3 === 0) {
        cells.push('bg-teal-500/60');
      } else {
        cells.push('bg-slate-800/40');
      }
    }
    return cells;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn">
      <div className="relative w-full max-w-md rounded-2xl bg-gradient-to-b from-[#131b2c] to-[#0c101d] border border-slate-700/80 p-6 shadow-2xl shadow-emerald-950/20 text-slate-100">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.2)]">
            <KeyRound className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              Cryptographic Identity
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                Phase 1
              </span>
            </h2>
            <p className="text-xs text-slate-400">
              Web Crypto ECDSA P-256 • Non-Extractable Key
            </p>
          </div>
        </div>

        {/* Visual Identicon + ID block */}
        <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 mb-5 flex items-center gap-4">
          {/* Identicon Grid */}
          <div className="w-16 h-16 p-1.5 rounded-lg bg-slate-950 border border-slate-800 grid grid-cols-5 gap-1 shrink-0">
            {getMatrixGrid().map((c, idx) => (
              <div key={idx} className={`rounded-xs ${c}`} />
            ))}
          </div>

          {/* ID String */}
          <div className="flex-1 min-w-0">
            <span className="text-[11px] font-semibold text-slate-400 tracking-wider uppercase">
              Your Shareable Peer ID
            </span>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-base sm:text-lg font-mono font-bold tracking-wider text-emerald-400 select-all">
                {identity.id}
              </span>
              <button
                onClick={copyId}
                className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 hover:text-emerald-300 transition-colors"
                title="Copy ID to Clipboard"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[11px] text-slate-500 truncate mt-0.5">
              Crockford Base32 of SHA-256(SPKI)
            </p>
          </div>
        </div>

        {/* Connected Peer Safety Number (Signal SAS) */}
        {peerSafetyNumber && connectedPeerId && (
          <div className="p-4 rounded-xl bg-emerald-950/20 border border-emerald-500/30 mb-5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold text-emerald-300 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                Verified Safety Number (SAS)
              </span>
              <span className="text-[10px] font-mono text-emerald-400/80">Signal-Grade</span>
            </div>
            <div className="p-2.5 rounded-lg bg-black/40 border border-emerald-500/20 font-mono text-center text-sm font-semibold tracking-widest text-emerald-300 select-all">
              {peerSafetyNumber}
            </div>
            <p className="text-[11px] text-slate-400 mt-2">
              Compare this number with peer <span className="font-mono text-slate-300">{connectedPeerId}</span> over another channel to verify zero MITM.
            </p>
          </div>
        )}

        {/* Non-Extractable Security Badge */}
        <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800/80 mb-5 flex items-start gap-3">
          <Lock className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <div className="text-xs text-slate-300 leading-relaxed">
            <span className="font-semibold text-white">Browser Key Isolation:</span> The private key is flagged as{' '}
            <code className="px-1 py-0.5 rounded bg-slate-800 font-mono text-[11px] text-emerald-400">
              extractable: false
            </code>
            . It cannot be exported or accessed by JavaScript, protecting against script injection and XSS theft.
          </div>
        </div>

        {/* SHA-256 Fingerprint */}
        <div className="mb-5">
          <label className="text-[11px] font-mono uppercase tracking-wider text-slate-400 block mb-1">
            Full SHA-256 Key Fingerprint
          </label>
          <div className="p-2 rounded-lg bg-slate-950 border border-slate-800 font-mono text-[11px] text-slate-400 break-all select-all">
            {identity.fingerprint}
          </div>
        </div>

        {/* Reset Identity Controls */}
        <div className="pt-2 border-t border-slate-800 flex items-center justify-between">
          {!showConfirmReset ? (
            <button
              onClick={() => setShowConfirmReset(true)}
              className="text-xs text-rose-400/80 hover:text-rose-300 hover:underline flex items-center gap-1 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Regenerate Fresh Key Pair
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-rose-400">Erase existing identity?</span>
              <button
                onClick={() => {
                  onResetIdentity();
                  setShowConfirmReset(false);
                  onClose();
                }}
                className="px-2 py-1 rounded bg-rose-600 hover:bg-rose-500 text-xs font-semibold text-white transition-colors"
              >
                Yes, Reset
              </button>
              <button
                onClick={() => setShowConfirmReset(false)}
                className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}

          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
