# CipherLink

**Browser-based, end-to-end encrypted peer-to-peer messenger with identity-bound handshake verification and self-hosted signaling.**

This is a monorepo containing two separate applications:

| Folder | Description |
|---|---|
| `frontend/` | React/Vite WebRTC app — the CipherLink browser client |
| `signaling-server/` | FastAPI WebSocket signaling server — self-hosted peer rendezvous |

---

## Setup: Frontend

```bash
cd frontend
npm install
npm run dev
```

The dev server starts at `http://localhost:5173`.

Set `VITE_SIGNALING_URL` in `frontend/.env` to point to your signaling server:

```
VITE_SIGNALING_URL=wss://your-signaling-server.onrender.com/ws
```

## Setup: Signaling Server

```bash
cd signaling-server
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

Health check: `http://localhost:8000/health`

---

## Architecture

- **Signaling**: WebSocket server relays SDP/ICE between peers for connection setup only. No message content or IDs are persisted.
- **Transport**: WebRTC DataChannel (direct browser-to-browser) — no server relay for messages, files, or calls.
- **Encryption**: AES-256-GCM per message, session key via ECDH+HKDF ephemeral key exchange.
- **Identity**: ECDSA P-256 long-term identity keys stored in IndexedDB, derived 12-char Crockford Base32 ID.

---

## Deployment

- **Frontend**: Deploy `frontend/` to Vercel, Netlify, or any static host. Set `VITE_SIGNALING_URL` env var.
- **Signaling Server**: Deploy `signaling-server/` to Render.com (free tier, native WebSocket + HTTPS/WSS).
  - Root Directory: `signaling-server`
  - Build: `pip install -r requirements.txt`
  - Start: `uvicorn main:app --host 0.0.0.0 --port $PORT`

> **Note:** Render free tier spins down after ~15 min of inactivity (30–60s cold start). Suitable for development and demos; use a paid tier for production.
