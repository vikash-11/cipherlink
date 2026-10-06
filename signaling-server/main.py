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

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s"
)

logger = logging.getLogger("cipherlink-signaling")


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="CipherLink Signaling Server",
    docs_url=None,
    redoc_url=None
)


# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# In-memory state
# ---------------------------------------------------------------------------

# { peer_id: WebSocket }
online_users: Dict[str, WebSocket] = {}


# ---------------------------------------------------------------------------
# Peer ID normalization
# ---------------------------------------------------------------------------

def normalize_peer_id(peer_id: str) -> str:
    """
    Normalize CipherLink Crockford-style peer IDs.

    Examples:
        103T-HJTH-0481 -> 103THJTH0481
        103th-jth-0481 -> 103THJTH0481
    """

    return (
        peer_id.upper()
        .replace("-", "")
        .replace("I", "1")
        .replace("L", "1")
        .replace("O", "0")
        .strip()
    )


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------

# { ip: [timestamp, ...] }
connect_request_log: Dict[str, list] = defaultdict(list)

RATE_LIMIT_WINDOW_SEC = 60
RATE_LIMIT_MAX_REQUESTS = 10


def is_rate_limited(ip: str) -> bool:
    """Return True if this IP exceeded the connect_request rate limit."""

    now = time.monotonic()
    window_start = now - RATE_LIMIT_WINDOW_SEC

    # Remove old timestamps
    connect_request_log[ip] = [
        t for t in connect_request_log[ip]
        if t > window_start
    ]

    if len(connect_request_log[ip]) >= RATE_LIMIT_MAX_REQUESTS:
        return True

    connect_request_log[ip].append(now)

    return False


# ---------------------------------------------------------------------------
# Safe WebSocket send
# ---------------------------------------------------------------------------

async def safe_send(ws: WebSocket, payload: dict) -> bool:
    """
    Send JSON to a WebSocket.

    Returns:
        True  -> message sent successfully
        False -> connection is closed or sending failed
    """

    try:
        if ws.client_state == WebSocketState.CONNECTED:
            await ws.send_text(json.dumps(payload))
            return True

    except Exception:
        pass

    return False


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "online_count": len(online_users)
    }


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):

    await websocket.accept()

    # Extract client IP
    client_ip = (
        websocket.client.host
        if websocket.client
        else "unknown"
    )

    peer_id = None

    logger.info(f"[connect] ip={client_ip}")

    try:

        while True:

            # ---------------------------------------------------------------
            # Receive message
            # ---------------------------------------------------------------

            raw = await websocket.receive_text()

            try:
                msg = json.loads(raw)

            except json.JSONDecodeError:

                await safe_send(
                    websocket,
                    {
                        "type": "error",
                        "message": "Invalid JSON"
                    }
                )

                continue

            msg_type = msg.get("type")


            # ---------------------------------------------------------------
            # 1. REGISTER
            # ---------------------------------------------------------------

            if msg_type == "register":

                new_id = normalize_peer_id(
                    msg.get("id", "")
                )

                if not new_id or len(new_id) > 32:

                    await safe_send(
                        websocket,
                        {
                            "type": "error",
                            "message": "Invalid ID"
                        }
                    )

                    continue


                # If this WebSocket was already registered
                # under another ID, remove the old entry.

                if peer_id and peer_id in online_users:
                    del online_users[peer_id]


                peer_id = new_id

                online_users[peer_id] = websocket

                logger.info(
                    f"[register] "
                    f"id={peer_id} "
                    f"ip={client_ip} "
                    f"online={len(online_users)}"
                )


                # Tell client registration succeeded

                await safe_send(
                    websocket,
                    {
                        "type": "registered",
                        "id": peer_id
                    }
                )


            # ---------------------------------------------------------------
            # 2. CONNECT REQUEST
            #
            # B -> Server -> A
            # ---------------------------------------------------------------

            elif msg_type == "connect_request":

                # Rate limit

                if is_rate_limited(client_ip):

                    await safe_send(
                        websocket,
                        {
                            "type": "error",
                            "message": (
                                "Rate limit exceeded - "
                                "too many connection requests"
                            )
                        }
                    )

                    continue


                # Normalize both IDs

                from_id = normalize_peer_id(
                    msg.get("from", "")
                )

                to_id = normalize_peer_id(
                    msg.get("to", "")
                )


                # Check target peer

                if to_id not in online_users:

                    await safe_send(
                        websocket,
                        {
                            "type": "error",
                            "message": "peer not available"
                        }
                    )

                    continue


                target_ws = online_users[to_id]


                # -----------------------------------------------------------
                # Forward request
                # -----------------------------------------------------------

                forwarded = dict(msg)

                # IMPORTANT:
                # Forward normalized IDs instead of the original IDs.

                forwarded["from"] = from_id
                forwarded["to"] = to_id


                ok = await safe_send(
                    target_ws,
                    forwarded
                )


                # Target disconnected between lookup and send

                if not ok:

                    online_users.pop(
                        to_id,
                        None
                    )

                    await safe_send(
                        websocket,
                        {
                            "type": "error",
                            "message": "peer not available"
                        }
                    )


                logger.info(
                    f"[connect_request] "
                    f"from={from_id} "
                    f"to={to_id}"
                )


            # ---------------------------------------------------------------
            # 3. CONNECT RESPONSE
            #
            # A -> Server -> B
            # ---------------------------------------------------------------

            elif msg_type == "connect_response":

                to_id = normalize_peer_id(
                    msg.get("to", "")
                )


                if to_id not in online_users:

                    await safe_send(
                        websocket,
                        {
                            "type": "error",
                            "message": "peer not available"
                        }
                    )

                    continue


                target_ws = online_users[to_id]


                forwarded = dict(msg)

                forwarded["to"] = to_id


                await safe_send(
                    target_ws,
                    forwarded
                )


                logger.info(
                    f"[connect_response] "
                    f"from={peer_id} "
                    f"to={to_id}"
                )


            # ---------------------------------------------------------------
            # 4. HANDSHAKE CONFIRMATION
            #
            # Caller -> Server -> Callee
            # ---------------------------------------------------------------

            elif msg_type == "handshake_confirm":

                to_id = normalize_peer_id(
                    msg.get("to", "")
                )


                if to_id not in online_users:

                    await safe_send(
                        websocket,
                        {
                            "type": "error",
                            "message": "peer not available"
                        }
                    )

                    continue


                target_ws = online_users[to_id]


                forwarded = dict(msg)

                forwarded["to"] = to_id


                await safe_send(
                    target_ws,
                    forwarded
                )


                logger.info(
                    f"[handshake_confirm] "
                    f"from={peer_id} "
                    f"to={to_id}"
                )


            # ---------------------------------------------------------------
            # 5. SDP / ICE RELAY
            #
            # Pure lookup-and-forward.
            # Payload itself is not modified.
            # ---------------------------------------------------------------

            elif msg_type in (
                "sdp_offer",
                "sdp_answer",
                "ice_candidate"
            ):

                to_id = normalize_peer_id(
                    msg.get("to", "")
                )


                if to_id not in online_users:

                    # Peer may have disconnected
                    # during negotiation.

                    continue


                target_ws = online_users[to_id]


                forwarded = dict(msg)

                forwarded["to"] = to_id


                await safe_send(
                    target_ws,
                    forwarded
                )


                logger.info(
                    f"[{msg_type}] "
                    f"from={peer_id} "
                    f"to={to_id}"
                )


            # ---------------------------------------------------------------
            # UNKNOWN MESSAGE TYPE
            # ---------------------------------------------------------------

            else:

                await safe_send(
                    websocket,
                    {
                        "type": "error",
                        "message": (
                            f"Unknown message type: {msg_type}"
                        )
                    }
                )


    # -----------------------------------------------------------------------
    # WebSocket disconnected
    # -----------------------------------------------------------------------

    except WebSocketDisconnect:

        pass


    except Exception as e:

        logger.warning(
            f"[error] "
            f"peer={peer_id} "
            f"ip={client_ip} "
            f"err={e}"
        )


    # -----------------------------------------------------------------------
    # Cleanup
    # -----------------------------------------------------------------------

    finally:

        if (
            peer_id
            and online_users.get(peer_id) is websocket
        ):

            del online_users[peer_id]

            logger.info(
                f"[disconnect] "
                f"id={peer_id} "
                f"online={len(online_users)}"
            )