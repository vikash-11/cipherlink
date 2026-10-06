import React, { useState } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  Radio,
  Settings,
  ChevronDown,
  Copy,
  Check,
} from 'lucide-react';
import type { ConnectionStatus } from '../network/types';

interface NavbarProps {
  localId: string;
  status: ConnectionStatus;
  statusDetail?: string;
  onOpenIdentity: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  localId,
  status,
  statusDetail,
  onOpenIdentity,
}) => {
  const [idExpanded, setIdExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const isConnected = status === 'connected';

  const handleCopyId = async () => {
    if (!localId) return;
    await navigator.clipboard.writeText(localId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  // ── Status pill (center-right) ──────────────────────────────────────────

  const getStatusPill = () => {
    switch (status) {
      case 'connected':
        return (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-xs font-medium shadow-[0_0_12px_rgba(45,232,176,0.15)]">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            E2EE Connected
            <ChevronDown className="w-3 h-3 opacity-60" />
          </div>
        );
      case 'signaling':
        return (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/25 text-blue-400 text-xs font-medium">
            <Radio className="w-3 h-3 animate-spin" />
            Signaling...
          </div>
        );
      case 'authenticating':
        return (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-400 text-xs font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping" />
            Authenticating...
          </div>
        );
      case 'rejected':
      case 'failed':
        return (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-rose-500/10 border border-rose-500/25 text-rose-400 text-xs font-medium">
            <ShieldAlert className="w-3 h-3" />
            {status === 'rejected' ? 'Declined' : 'Failed'}
          </div>
        );
      default:
        return (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#2DE8B0]/8 border border-[#2DE8B0]/20 text-[#2DE8B0] text-xs font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-[#2DE8B0] animate-pulse" />
            Secure network ready
            <ChevronDown className="w-3 h-3 opacity-60" />
          </div>
        );
    }
  };

  return (
    <header className="sticky top-0 z-30 w-full border-b border-white/[0.06] bg-[#050B14]/90 backdrop-blur-md px-4 py-3 sm:px-6">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-3">

        {/* ── Left: Logo + wordmark + badge ── */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="relative flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-[#2DE8B0]/20 to-[#2DE8B0]/5 border border-[#2DE8B0]/30 shadow-[0_0_14px_rgba(45,232,176,0.2)]">
            <ShieldCheck className="w-5 h-5 text-[#2DE8B0]" />
            <div className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[#2DE8B0] ring-2 ring-[#050B14]" />
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-[17px] font-bold tracking-tight text-white">
              Cipher<span className="text-[#2DE8B0]">Link</span>
            </span>
            <span className="hidden sm:inline-flex items-center px-2 py-0.5 rounded-full bg-[#2DE8B0]/8 border border-[#2DE8B0]/20 text-[10px] font-mono text-[#2DE8B0] tracking-widest">
              P2P • E2EE
            </span>
          </div>
        </div>

        {/* ── Center: Status pill (hidden on very small screens) ── */}
        <div className="hidden sm:flex items-center gap-3">
          {getStatusPill()}
          {statusDetail && status !== 'connected' && status !== 'disconnected' && (
            <span className="hidden lg:block text-xs font-mono text-[#8A99AD] truncate max-w-[200px]">
              {statusDetail}
            </span>
          )}
        </div>

        {/* ── Right: Settings + ID ── */}
        <div className="flex items-center gap-2">

          {/* Settings (opens Identity card) */}
          <button
            id="settings-btn"
            onClick={onOpenIdentity}
            title="Settings & Identity"
            className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[#8A99AD] hover:text-white hover:border-white/20 transition-all"
          >
            <Settings className="w-4 h-4" />
          </button>

          {/* Peer ID pill / dropdown */}
          {localId && (
            <div className="relative">
              <button
                id="peer-id-btn"
                onClick={() => setIdExpanded((v) => !v)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-xs font-mono text-[#8A99AD] hover:text-[#2DE8B0] hover:border-[#2DE8B0]/25 transition-all"
                title="Your Peer ID"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-[#2DE8B0]" />
                <span className="hidden sm:inline">{localId.slice(0, 9)}…</span>
                <span className="sm:hidden">ID</span>
                <ChevronDown className={`w-3 h-3 transition-transform duration-150 ${idExpanded ? 'rotate-180' : ''}`} />
              </button>

              {/* Expanded ID dropdown */}
              {idExpanded && (
                <div className="absolute right-0 top-[calc(100%+6px)] w-64 rounded-xl border border-white/[0.08] bg-[#0A1420]/95 backdrop-blur-md shadow-2xl p-4 z-50">
                  <p className="text-[10px] uppercase tracking-widest text-[#8A99AD] mb-2">Your Peer ID</p>
                  <p className="font-mono text-sm text-[#2DE8B0] break-all leading-relaxed mb-3">
                    {localId}
                  </p>
                  <button
                    onClick={handleCopyId}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-[#2DE8B0]/10 border border-[#2DE8B0]/20 text-xs text-[#2DE8B0] hover:bg-[#2DE8B0]/15 transition-colors"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        Copied!
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Copy Peer ID
                      </>
                    )}
                  </button>
                  <p className="text-[10px] text-[#8A99AD]/50 mt-2 text-center">
                    Share this ID with the peer you want to connect to
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
