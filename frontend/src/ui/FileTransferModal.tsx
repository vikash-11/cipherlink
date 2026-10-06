import React, { useState } from 'react';
import {
  UploadCloud,
  FileCheck,
  FileX,
  Download,
  X,
  Lock,
  Layers,
  CheckCircle2,
} from 'lucide-react';
import type { FileTransferState } from '../network/types';

interface FileTransferModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSendFile: (file: File) => void;
  activeTransfer: FileTransferState | null;
}

export const FileTransferModal: React.FC<FileTransferModalProps> = ({
  isOpen,
  onClose,
  onSendFile,
  activeTransfer,
}) => {
  const [dragOver, setDragOver] = useState(false);

  if (!isOpen) return null;

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onSendFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onSendFile(e.target.files[0]);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn">
      <div className="relative w-full max-w-md rounded-2xl bg-gradient-to-b from-[#131b2c] to-[#0c101d] border border-slate-700/80 p-6 shadow-2xl text-slate-100">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            <UploadCloud className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              Encrypted File Transfer
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                Phase 5
              </span>
            </h2>
            <p className="text-xs text-slate-400 font-mono">16KB Chunks • AES-256-GCM • SHA-256 Integrity</p>
          </div>
        </div>

        {/* Transfer Progress View */}
        {activeTransfer ? (
          <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 space-y-4 mb-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white truncate max-w-[200px]">
                {activeTransfer.fileName}
              </span>
              <span className="text-xs font-mono text-emerald-400">
                {activeTransfer.progressPercent}%
              </span>
            </div>

            {/* Progress Bar */}
            <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-200"
                style={{ width: `${activeTransfer.progressPercent}%` }}
              />
            </div>

            {/* Details */}
            <div className="grid grid-cols-2 gap-2 text-[11px] font-mono text-slate-400">
              <div>
                <span>Chunks: </span>
                <span className="text-slate-200">
                  {activeTransfer.receivedChunks} / {activeTransfer.totalChunks}
                </span>
              </div>
              <div>
                <span>Size: </span>
                <span className="text-slate-200">
                  {(activeTransfer.fileSize / 1024).toFixed(1)} KB
                </span>
              </div>
            </div>

            {/* Checksum & Status */}
            <div className="pt-2 border-t border-slate-800 text-[11px] font-mono">
              <div className="text-slate-500 truncate mb-1">
                SHA-256 Checksum: {activeTransfer.sha256Checksum.slice(0, 16)}...
              </div>

              {activeTransfer.status === 'completed' ? (
                <div className="flex items-center justify-between text-emerald-400 mt-2">
                  <span className="flex items-center gap-1.5 font-medium">
                    <CheckCircle2 className="w-4 h-4" />
                    Verified & Decrypted
                  </span>
                  {activeTransfer.blobUrl && (
                    <a
                      href={activeTransfer.blobUrl}
                      download={activeTransfer.fileName}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-sans font-semibold transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Save File
                    </a>
                  )}
                </div>
              ) : activeTransfer.status === 'verifying' ? (
                <span className="text-amber-400 font-medium">Verifying SHA-256 Checksum...</span>
              ) : activeTransfer.status === 'failed' ? (
                <span className="text-rose-400 font-medium flex items-center gap-1">
                  <FileX className="w-4 h-4" />
                  Transfer Failed / Checksum Mismatch
                </span>
              ) : (
                <span className="text-cyan-400 font-medium">
                  {activeTransfer.isIncoming ? 'Receiving & Decrypting...' : 'Encrypting & Sending...'}
                </span>
              )}
            </div>
          </div>
        ) : (
          /* File Dropzone */
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={`p-8 rounded-xl border-2 border-dashed text-center transition-all mb-4 ${
              dragOver
                ? 'border-emerald-500 bg-emerald-500/10'
                : 'border-slate-700 bg-slate-900/60 hover:border-slate-600'
            }`}
          >
            <UploadCloud className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
            <h3 className="text-sm font-semibold text-white mb-1">
              Drag and drop any file here
            </h3>
            <p className="text-xs text-slate-400 mb-4">
              Files are split into 16KB blocks and encrypted with AES-256-GCM.
            </p>

            <label className="inline-block px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 cursor-pointer transition-colors">
              <span>Browse Files</span>
              <input type="file" onChange={handleFileChange} className="hidden" />
            </label>
          </div>
        )}

        <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800/80 text-[11px] text-slate-400 flex items-start gap-2">
          <Lock className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <p>
            Zero-Knowledge: The signaling server and intermediaries never see file names, sizes, or contents. Integrity is mathematically guaranteed via SHA-256 verification after reassembly.
          </p>
        </div>
      </div>
    </div>
  );
};
