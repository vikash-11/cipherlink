"""
CipherLink Signaling Server
FastAPI + WebSocket peer-rendezvous server.

All state is in-memory only — nothing is written to disk or any database.
online_users is a plain dict; it is wiped on every server restart.

Message protocol (JSON over WebSocket):
  Client → Server:
    { "type": "register", "id": "<12-char Crockford ID>" }
    { "type": "connect_request", "from": "<id>", "to": "<id>" }
    { "type": "connect_response", "to": "<id>", "accepted": bool }
    { "type": "handshake_confirm", "to": "<id>", "confirmSignatureBase64": "<base64>" }
    { "type": "sdp_offer"|"sdp_answer"|"ice_candidate", "to": "<id>", "payload": {...} }

  Server → Client:
    Forwarded versions of the above (relay-only, server never modifies payloads)
    { "type": "error", "message": "..." }
"""

import asyncio
import json
import logging
import time
from collections import defaultdict
from typing import Dict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketState

# ---------------------------------------------------------------------------
# Logging — console only, never persisted
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("cipherlink-signaling")

# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------
app = FastAPI(title="CipherLink Signaling Server", docs_url=None, redoc_url=None)

# CORS — allow all origins for WebSocket upgrades.
# Restrict to your frontend's deployed origin in production by replacing ["*"]
# with e.g. ["https://your-frontend.vercel.app"].
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# In-memory state — plain dicts, never serialised to disk
# ---------------------------------------------------------------------------
# { peer_id: WebSocket }
online_users: Dict[str, WebSocket] = {}

# Rate-limiting state — { ip: [timestamp, ...] }
# Tracks connect_request events per source IP (not per ID — IP is the right surface).
connect_request_log: Dict[str, list] = defaultdict(list)

RATE_LIMIT_WINDOW_SEC = 60
RATE_LIMIT_MAX_REQUESTS = 10  # max connect_requests per IP per window

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def is_rate_limited(ip: str) -> bool:
    """Return True if this IP has exceeded the connect_request rate limit."""
    now = time.monotonic()
    window_start = now - RATE_LIMIT_WINDOW_SEC
    # Prune old timestamps
    connect_request_log[ip] = [t for t in connect_request_log[ip] if t > window_start]
    if len(connect_request_log[ip]) >= RATE_LIMIT_MAX_REQUESTS:
        return True
    connect_request_log[ip].append(now)
    return False


async def safe_send(ws: WebSocket, payload: dict) -> bool:
    """Send JSON to a WebSocket, returning False if the connection is closed."""
    try:
        if ws.client_state == WebSocketState.CONNECTED:
            await ws.send_text(json.dumps(payload))
            return True
    except Exception:
        pass
    return False


# ---------------------------------------------------------------------------
# Health check (HTTP GET)
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok", "online_count": len(online_users)}


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    # Extract connecting IP for rate limiting
    client_ip = websocket.client.host if websocket.client else "unknown"
    peer_id = None

    logger.info(f"[connect] ip={client_ip}")

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await safe_send(websocket, {"type": "error", "message": "Invalid JSON"})
                continue

            msg_type = msg.get("type")

            # ------------------------------------------------------------------
            # 1. Register
            # ------------------------------------------------------------------
            if msg_type == "register":
                new_id = msg.get("id", "").strip()
                if not new_id or len(new_id) > 32:
                    await safe_send(websocket, {"type": "error", "message": "Invalid ID"})
                    continue

                # If peer was already registered under a different ID, clean up old entry
                if peer_id and peer_id in online_users:
                    del online_users[peer_id]

                peer_id = new_id
                online_users[peer_id] = websocket
                logger.info(f"[register] id={peer_id} ip={client_ip} online={len(online_users)}")
                await safe_send(websocket, {"type": "registered", "id": peer_id})

            # ------------------------------------------------------------------
            # 2. Connect request (B -> server -> A)
            # ------------------------------------------------------------------
            elif msg_type == "connect_request":
                if is_rate_limited(client_ip):
                    await safe_send(
                        websocket,
                        {"type": "error", "message": "Rate limit exceeded - too many connection requests"},
                    )
                    continue

                from_id = msg.get("from", "")
                to_id = msg.get("to", "")

                if to_id not in online_users:
                    await safe_send(websocket, {"type": "error", "message": "peer not available"})
                    continue

                target_ws = online_users[to_id]
                forwarded = dict(msg)  # relay as-is
                ok = await safe_send(target_ws, forwarded)
                if not ok:
                    # Target disconnected between lookup and send
                    online_users.pop(to_id, None)
                    await safe_send(websocket, {"type": "error", "message": "peer not available"})
                logger.info(f"[connect_request] from={from_id} to={to_id}")

            # ------------------------------------------------------------------
            # 3. Connect response (A -> server -> B)
            # ------------------------------------------------------------------
            elif msg_type == "connect_response":
                to_id = msg.get("to", "")
                if to_id not in online_users:
                    await safe_send(websocket, {"type": "error", "message": "peer not available"})
                    continue

                target_ws = online_users[to_id]
                await safe_send(target_ws, dict(msg))

            # ------------------------------------------------------------------
            # 4. Handshake confirmation (caller -> server -> callee)
            #    Distinct from connect_response so the client can route it to
            #    its own verifier instead of mis-parsing it as accept/reject.
            # ------------------------------------------------------------------
            elif msg_type == "handshake_confirm":
                to_id = msg.get("to", "")
                if to_id not in online_users:
                    await safe_send(websocket, {"type": "error", "message": "peer not available"})
                    continue
                target_ws = online_users[to_id]
                await safe_send(target_ws, dict(msg))

            # ------------------------------------------------------------------
            # 5. SDP / ICE relay -- pure lookup-and-forward, payload untouched
            # ------------------------------------------------------------------
            elif msg_type in ("sdp_offer", "sdp_answer", "ice_candidate"):
                to_id = msg.get("to", "")
                if to_id not in online_users:
                    # Peer may have disconnected mid-negotiation; silently drop
                    continue

                target_ws = online_users[to_id]
                await safe_send(target_ws, dict(msg))

            else:
                await safe_send(websocket, {"type": "error", "message": f"Unknown message type: {msg_type}"})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"[error] peer={peer_id} ip={client_ip} err={e}")
    finally:
        # Always remove from online_users on any disconnect/error
        if peer_id and online_users.get(peer_id) is websocket:
            del online_users[peer_id]
            logger.info(f"[disconnect] id={peer_id} online={len(online_users)}")
