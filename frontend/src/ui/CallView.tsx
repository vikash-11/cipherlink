import React, { useEffect, useRef, useState } from 'react';
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  Monitor,
  PhoneOff,
  ShieldCheck,
  Maximize2,
} from 'lucide-react';
import type { MediaCallManager } from '../network/mediaCalls';

interface CallViewProps {
  isOpen: boolean;
  onClose: () => void;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  peerId: string;
  mediaManager: MediaCallManager | null;
  // Owned by App.tsx (via MediaCallManager's onScreenShareChanged callback),
  // not local state here — this is what fixes the indicator getting stuck
  // "active" when sharing is stopped via the browser's own native control
  // rather than our own toggle button.
  isScreenSharing: boolean;
}

export const CallView: React.FC<CallViewProps> = ({
  isOpen,
  onClose,
  localStream,
  remoteStream,
  peerId,
  mediaManager,
  isScreenSharing,
}) => {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const [callDuration, setCallDuration] = useState(0);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setCallDuration(0);
      return;
    }

    const timer = setInterval(() => {
      setCallDuration((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [isOpen]);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream, isOpen]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream, isOpen]);

  if (!isOpen) return null;

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleToggleAudio = () => {
    if (mediaManager) {
      setIsAudioMuted(mediaManager.toggleAudio());
    }
  };

  const handleToggleVideo = () => {
    if (mediaManager) {
      setIsVideoMuted(mediaManager.toggleVideo());
    }
  };

  const handleToggleScreenShare = async () => {
    if (mediaManager) {
      // isScreenSharing prop updates on its own via the manager's
      // onScreenShareChanged callback (wired in App.tsx) — including when
      // sharing stops externally via the browser's native control.
      await mediaManager.toggleScreenShare();
    }
  };

  const handleEndCall = () => {
    if (mediaManager) {
      mediaManager.endCall();
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-fadeIn">
      <div className="relative w-full max-w-4xl h-[80vh] rounded-3xl bg-slate-950 border border-slate-800 flex flex-col overflow-hidden shadow-2xl">
        {/* Header Bar */}
        <div className="px-6 py-4 bg-slate-900/60 backdrop-blur-md border-b border-slate-800/80 flex items-center justify-between z-10">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-white font-mono">Peer {peerId}</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  DTLS-SRTP Encrypted
                </span>
              </div>
              <p className="text-xs text-slate-400 font-mono">{formatTimer(callDuration)}</p>
            </div>
          </div>
        </div>

        {/* Video Stage */}
        <div className="flex-1 relative bg-black flex items-center justify-center overflow-hidden">
          {/* Remote Video (Full Stage) */}
          {remoteStream ? (
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="flex flex-col items-center justify-center text-slate-500 space-y-3">
              <div className="w-20 h-20 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 animate-pulse">
                <Video className="w-10 h-10" />
              </div>
              <span className="text-sm font-mono text-slate-400">Connecting media streams...</span>
            </div>
          )}

          {/* Local Video Preview (Picture in Picture) */}
          <div className="absolute bottom-6 right-6 w-48 sm:w-60 aspect-video rounded-2xl overflow-hidden bg-slate-900 border-2 border-slate-800 shadow-2xl">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />
            {isVideoMuted && (
              <div className="absolute inset-0 bg-slate-900/90 flex items-center justify-center text-xs text-slate-400">
                Camera Off
              </div>
            )}
            <span className="absolute bottom-2 left-2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-black/60 text-white backdrop-blur-xs">
              You
            </span>
          </div>
        </div>

        {/* Call Controls Bar */}
        <div className="p-4 bg-slate-900/80 backdrop-blur-md border-t border-slate-800 flex items-center justify-center gap-4 z-10">
          {/* Mute Audio */}
          <button
            onClick={handleToggleAudio}
            className={`p-3.5 rounded-full transition-all ${
              isAudioMuted
                ? 'bg-rose-600 text-white shadow-lg shadow-rose-950/50'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
            }`}
            title={isAudioMuted ? 'Unmute Microphone' : 'Mute Microphone'}
          >
            {isAudioMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </button>

          {/* Mute Video */}
          <button
            onClick={handleToggleVideo}
            className={`p-3.5 rounded-full transition-all ${
              isVideoMuted
                ? 'bg-rose-600 text-white shadow-lg shadow-rose-950/50'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
            }`}
            title={isVideoMuted ? 'Turn Camera On' : 'Turn Camera Off'}
          >
            {isVideoMuted ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
          </button>

          {/* Screen Share */}
          <button
            onClick={handleToggleScreenShare}
            className={`p-3.5 rounded-full transition-all ${
              isScreenSharing
                ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-950/50'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
            }`}
            title={isScreenSharing ? 'Stop Screen Sharing' : 'Share Screen'}
          >
            <Monitor className="w-5 h-5" />
          </button>

          {/* End Call */}
          <button
            onClick={handleEndCall}
            className="p-3.5 rounded-full bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-950/50 transition-all transform active:scale-95"
            title="End Call"
          >
            <PhoneOff className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
};
