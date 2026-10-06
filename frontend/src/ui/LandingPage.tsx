import React, { useEffect, useRef } from 'react';
import {
  Lock,
  Fingerprint,
  Share2,
  EyeOff,
  Key,
  ArrowRight,
  ShieldCheck,
  Users,
  ChevronRight,
  Shield,
} from 'lucide-react';
import type { ConnectionStatus } from '../network/types';

interface LandingPageProps {
  localId: string;
  connectionStatus: ConnectionStatus;
  statusDetail?: string;
  onOpenConnectModal: () => void;
}

// ---------------------------------------------------------------------------
// Animated Network Background — canvas constellation
// ---------------------------------------------------------------------------

const NetworkCanvas: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;

    const resize = () => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    // Node definition
    type Node = { x: number; y: number; vx: number; vy: number; r: number };
    const NODE_COUNT = 38;
    const nodes: Node[] = Array.from({ length: NODE_COUNT }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      r: Math.random() * 1.8 + 0.8,
    }));

    const LINK_DIST = 160;
    const ACCENT = '45,232,176'; // #2DE8B0

    const draw = () => {
      if (!ctx || !canvas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Update positions
      nodes.forEach((n) => {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < 0 || n.x > canvas.width) n.vx *= -1;
        if (n.y < 0 || n.y > canvas.height) n.vy *= -1;
      });

      // Draw edges
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const dist = Math.hypot(dx, dy);
          if (dist < LINK_DIST) {
            const alpha = (1 - dist / LINK_DIST) * 0.18;
            ctx.beginPath();
            ctx.strokeStyle = `rgba(${ACCENT},${alpha})`;
            ctx.lineWidth = 0.8;
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.stroke();
          }
        }
      }

      // Draw nodes
      nodes.forEach((n) => {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${ACCENT},0.55)`;
        ctx.fill();
      });

      animId = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
      aria-hidden="true"
    />
  );
};

// ---------------------------------------------------------------------------
// Feature card data
// ---------------------------------------------------------------------------
const FEATURES = [
  {
    icon: Lock,
    title: 'End-to-end encrypted',
    desc: 'Messages and files are encrypted in your browser before sending.',
  },
  {
    icon: Fingerprint,
    title: 'Identity verified',
    desc: 'Authenticate peers with ECDSA identity keys before any message is exchanged.',
  },
  {
    icon: Share2,
    title: 'Direct P2P transport',
    desc: 'Uses WebRTC for direct browser-to-browser communication.',
  },
  {
    icon: EyeOff,
    title: 'No logs, no data',
    desc: 'Your messages never touch a server. Signaling only briefly relays connection setup.',
  },
];

// ---------------------------------------------------------------------------
// Status pill for the connect card
// ---------------------------------------------------------------------------

const statusMessages: Partial<Record<ConnectionStatus, { color: string; text: string }>> = {
  signaling: { color: 'text-blue-400 border-blue-500/30 bg-blue-500/10', text: '⟳ Waiting for peer to accept...' },
  authenticating: { color: 'text-amber-400 border-amber-500/30 bg-amber-500/10', text: '🔐 Performing cryptographic handshake...' },
  rejected: { color: 'text-rose-400 border-rose-500/30 bg-rose-500/10', text: '✗ Peer declined the connection request.' },
  failed: { color: 'text-rose-400 border-rose-500/30 bg-rose-500/10', text: '✗ Connection failed — verify the peer ID and try again.' },
};

// ---------------------------------------------------------------------------
// LandingPage
// ---------------------------------------------------------------------------

export const LandingPage: React.FC<LandingPageProps> = ({
  localId,
  connectionStatus,
  statusDetail,
  onOpenConnectModal,
}) => {
  const activeStatus = statusMessages[connectionStatus];

  return (
    <div className="relative flex-1 flex flex-col overflow-auto bg-[#050B14]">
      {/* Animated constellation background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <NetworkCanvas />
        {/* Radial glow centre */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_50%,rgba(45,232,176,0.04)_0%,transparent_70%)]" />
      </div>

      {/* Scrollable content */}
      <div className="relative z-10 flex flex-col items-center px-4 pb-16 pt-12 sm:pt-20 min-h-full">

        {/* ── Hero ── */}
        <section className="text-center max-w-2xl mx-auto mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[#2DE8B0]/20 bg-[#2DE8B0]/5 text-xs font-mono text-[#2DE8B0] mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-[#2DE8B0] animate-pulse" />
            Browser-native · Zero-knowledge · Direct P2P
          </div>

          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-white leading-[1.15] mb-4">
            Your conversations
            <br />
            <span className="bg-gradient-to-r from-[#2DE8B0] via-[#3EF2C5] to-[#58F5D3] bg-clip-text text-transparent">
              stay yours.
            </span>
          </h1>

          <p className="text-base sm:text-lg text-[#8A99AD] leading-relaxed max-w-xl mx-auto">
            CipherLink connects browsers directly using WebRTC, authenticated with ECDSA identity keys
            and encrypted with AES-256-GCM. No accounts. No servers storing your messages.
          </p>
        </section>

        {/* ── Connect card ── */}
        <section
          id="connect-card"
          aria-label="Connect to peer"
          className="w-full max-w-md mx-auto mb-14"
        >
          <div className="relative rounded-2xl border border-white/[0.07] bg-[#0A1420]/80 backdrop-blur-md shadow-2xl shadow-black/60 overflow-hidden">
            {/* Subtle top-edge accent */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2/3 h-px bg-gradient-to-r from-transparent via-[#2DE8B0]/40 to-transparent" />

            <div className="p-6 sm:p-8">
              {/* Card header */}
              <div className="flex items-center gap-2.5 mb-6">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-[#2DE8B0]/10 border border-[#2DE8B0]/20">
                  <Users className="w-4 h-4 text-[#2DE8B0]" />
                </div>
                <span className="text-sm font-semibold text-white/80 tracking-wide">
                  Connect to peer
                </span>
              </div>

              {/* Status banner (only when relevant) */}
              {activeStatus && (
                <div className={`mb-5 px-4 py-2.5 rounded-xl border text-xs font-mono leading-relaxed ${activeStatus.color}`}>
                  {statusDetail || activeStatus.text}
                </div>
              )}

              {/* Your ID display */}
              {localId && (
                <div className="mb-5 px-4 py-3 rounded-xl bg-[#050B14]/70 border border-white/[0.06]">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-[#8A99AD] mb-1">Your Peer ID</p>
                      <p className="text-sm font-mono font-medium text-[#2DE8B0] tracking-wide">{localId}</p>
                    </div>
                    <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-[#2DE8B0]/10 border border-[#2DE8B0]/20 flex items-center justify-center">
                      <Key className="w-3.5 h-3.5 text-[#2DE8B0]" />
                    </div>
                  </div>
                </div>
              )}

              {/* Info row */}
              <div className="flex items-center gap-2 mb-4">
                <p className="text-xs text-[#8A99AD]">
                  Share your Peer ID with the person you want to connect with, then enter theirs below.
                </p>
              </div>

              {/* CTA Button */}
              <button
                id="start-session-btn"
                onClick={onOpenConnectModal}
                disabled={connectionStatus === 'signaling' || connectionStatus === 'authenticating'}
                className="group relative w-full flex items-center justify-center gap-2.5 px-6 py-3.5 rounded-xl font-semibold text-sm text-[#050B14] transition-all duration-200
                  bg-gradient-to-r from-[#2DE8B0] to-[#3EF2C5]
                  hover:from-[#3EF2C5] hover:to-[#58F5D3]
                  hover:shadow-[0_0_24px_rgba(45,232,176,0.35)]
                  disabled:opacity-50 disabled:pointer-events-none
                  shadow-[0_0_16px_rgba(45,232,176,0.2)]"
              >
                <Lock className="w-4 h-4" />
                Start secure session
                <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" />
              </button>

              {/* Footer note */}
              <p className="text-center text-[10px] text-[#8A99AD]/60 mt-4 font-mono">
                WebRTC · ECDH key exchange · AES-256-GCM
              </p>
            </div>
          </div>
        </section>

        {/* ── Feature strip ── */}
        <section
          aria-label="Features"
          className="w-full max-w-4xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-12"
        >
          {FEATURES.map(({ icon: Icon, title, desc }) => (
            <div
              key={title}
              className="group flex flex-col gap-3 p-5 rounded-2xl border border-white/[0.06] bg-[#0A1420]/60 backdrop-blur-sm
                hover:border-[#2DE8B0]/20 hover:bg-[#0A1420]/90 transition-all duration-200"
            >
              <div className="flex items-center justify-center w-9 h-9 rounded-xl border border-[#2DE8B0]/25 bg-[#2DE8B0]/8 group-hover:border-[#2DE8B0]/40 transition-colors">
                <Icon className="w-4.5 h-4.5 text-[#2DE8B0]" strokeWidth={1.8} />
              </div>
              <div>
                <p className="text-sm font-semibold text-white mb-1">{title}</p>
                <p className="text-xs text-[#8A99AD] leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </section>

        {/* ── Footer line ── */}
        <footer className="flex items-center gap-2 text-xs text-[#8A99AD]/50">
          <Shield className="w-3.5 h-3.5 text-[#2DE8B0]/40" />
          <span>Encrypted by design · Built for private communication</span>
        </footer>
      </div>
    </div>
  );
};
