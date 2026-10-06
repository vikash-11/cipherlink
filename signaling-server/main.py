import asyncio
import json
import logging
import time
from collections import defaultdict
from typing import Dict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketState


# =============================================================================
# CipherLink Signaling Server
# =============================================================================
#
# Purpose:
#   - WebSocket rendezvous/signaling only
#   - No messages are stored
#   - No identity/private keys are stored
#   - No WebRTC media/data passes through this server
#
# Supported messages:
#
# Client -> Server
#   register
#   connect_request
#   connect_response
#   handshake_confirm
#   sdp_offer
#   sdp_answer
#   ice_candidate
#
# Server -> Client
#   registered
#   forwarded signaling messages
#   error
#
# =============================================================================


# =============================================================================
# Logging
# =============================================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

logger = logging.getLogger("cipherlink-signaling")


# =============================================================================
# FastAPI application
# =============================================================================

app = FastAPI(
    title="CipherLink Signaling Server",
    docs_url=None,
    redoc_url=None,
)


# =============================================================================
# CORS
# =============================================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =============================================================================
# In-memory peer registry
# =============================================================================
#
# {
#     "103THJTH0481": websocket,
#     "ABC123......": websocket
# }
#
# This is intentionally in-memory only.
# A server restart clears the registry.
# =============================================================================

online_users: Dict[str, WebSocket] = {}


# =============================================================================
# Peer ID normalization
# =============================================================================

def normalize_peer_id(peer_id: str) -> str:
    """
    Normalize CipherLink Crockford-style IDs.

    Examples:

        103T-HJTH-0481
        103th-jth-0481
        103THJTH0481

    All become:

        103THJTH0481
    """

    if not isinstance(peer_id, str):
        return ""

    return (
        peer_id
        .upper()
        .replace("-", "")
        .replace("I", "1")
        .replace("L", "1")
        .replace("O", "0")
        .strip()
    )


# =============================================================================
# Rate limiting
# =============================================================================

connect_request_log: Dict[str, list[float]] = defaultdict(list)

RATE_LIMIT_WINDOW_SEC = 60
RATE_LIMIT_MAX_REQUESTS = 10


def is_rate_limited(ip: str) -> bool:
    """
    Return True when an IP has exceeded the connection-request limit.
    """

    now = time.monotonic()
    window_start = now - RATE_LIMIT_WINDOW_SEC

    # Remove expired timestamps.
    connect_request_log[ip] = [
        timestamp
        for timestamp in connect_request_log[ip]
        if timestamp > window_start
    ]

    if len(connect_request_log[ip]) >= RATE_LIMIT_MAX_REQUESTS:
        return True

    connect_request_log[ip].append(now)

    return False


# =============================================================================
# Safe WebSocket send
# =============================================================================

async def safe_send(
    websocket: WebSocket,
    payload: dict,
) -> bool:
    """
    Safely send JSON to a connected WebSocket.

    Returns:
        True  -> message sent
        False -> socket unavailable/send failed
    """

    try:
        if websocket.client_state == WebSocketState.CONNECTED:
            await websocket.send_text(
                json.dumps(payload)
            )
            return True

    except Exception as exc:
        logger.debug(
            "[send-failed] %s",
            exc,
        )

    return False


# =============================================================================
# Generic relay helper
# =============================================================================

async def relay_to_peer(
    *,
    sender_ws: WebSocket,
    sender_id: str | None,
    target_id: str,
    message: dict,
    message_type: str,
    require_target: bool = True,
) -> bool:
    """
    Normalize target ID, find target WebSocket and forward the message.

    This is used by:

        connect_response
        handshake_confirm
        sdp_offer
        sdp_answer
        ice_candidate
    """

    normalized_target = normalize_peer_id(target_id)

    if not normalized_target:
        await safe_send(
            sender_ws,
            {
                "type": "error",
                "message": "Invalid target peer ID",
            },
        )
        return False

    target_ws = online_users.get(normalized_target)

    if target_ws is None:
        if require_target:
            await safe_send(
                sender_ws,
                {
                    "type": "error",
                    "message": "peer not available",
                },
            )

        logger.info(
            "[%s] target unavailable: %s",
            message_type,
            normalized_target,
        )

        return False

    # Never mutate the original object.
    forwarded = dict(message)

    # Always send normalized target ID.
    forwarded["to"] = normalized_target

    # For messages where a sender ID is meaningful, normalize it too.
    if sender_id:
        forwarded["from"] = normalize_peer_id(sender_id)

    ok = await safe_send(
        target_ws,
        forwarded,
    )

    if not ok:
        # Remove stale connection only if it is still the same socket.
        if online_users.get(normalized_target) is target_ws:
            online_users.pop(
                normalized_target,
                None,
            )

        await safe_send(
            sender_ws,
            {
                "type": "error",
                "message": "peer not available",
            },
        )

        logger.info(
            "[%s] target socket unavailable: %s",
            message_type,
            normalized_target,
        )

        return False

    logger.info(
        "[%s] from=%s to=%s",
        message_type,
        sender_id or "unknown",
        normalized_target,
    )

    return True


# =============================================================================
# Health check
# =============================================================================

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "cipherlink-signaling",
        "online_count": len(online_users),
    }


# =============================================================================
# WebSocket endpoint
# =============================================================================

@app.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
):
    await websocket.accept()

    # Client IP
    client_ip = (
        websocket.client.host
        if websocket.client
        else "unknown"
    )

    peer_id: str | None = None

    logger.info(
        "[connect] ip=%s",
        client_ip,
    )

    try:

        while True:

            # =================================================================
            # Receive
            # =================================================================

            raw = await websocket.receive_text()

            try:
                msg = json.loads(raw)

            except json.JSONDecodeError:

                await safe_send(
                    websocket,
                    {
                        "type": "error",
                        "message": "Invalid JSON",
                    },
                )

                continue

            if not isinstance(msg, dict):
                await safe_send(
                    websocket,
                    {
                        "type": "error",
                        "message": "Invalid message",
                    },
                )
                continue

            msg_type = msg.get("type")

            if not isinstance(msg_type, str):
                await safe_send(
                    websocket,
                    {
                        "type": "error",
                        "message": "Missing message type",
                    },
                )
                continue

            # =================================================================
            # 1. REGISTER
            # =================================================================

            if msg_type == "register":

                new_id = normalize_peer_id(
                    msg.get("id", "")
                )

                # CipherLink IDs are 12 characters.
                if not new_id or len(new_id) != 12:

                    await safe_send(
                        websocket,
                        {
                            "type": "error",
                            "message": "Invalid ID",
                        },
                    )

                    continue

                # If this socket had previously registered another ID,
                # remove that old registration.
                if (
                    peer_id
                    and online_users.get(peer_id) is websocket
                ):
                    online_users.pop(
                        peer_id,
                        None,
                    )

                # If another socket already owns this ID, replace it.
                old_socket = online_users.get(new_id)

                if (
                    old_socket is not None
                    and old_socket is not websocket
                ):
                    logger.info(
                        "[register] replacing existing socket id=%s",
                        new_id,
                    )

                    try:
                        await old_socket.close()
                    except Exception:
                        pass

                peer_id = new_id

                online_users[peer_id] = websocket

                logger.info(
                    "[register] id=%s ip=%s online=%d",
                    peer_id,
                    client_ip,
                    len(online_users),
                )

                # Tell the frontend registration succeeded.
                await safe_send(
                    websocket,
                    {
                        "type": "registered",
                        "id": peer_id,
                    },
                )

                continue

            # =================================================================
            # Everything below requires registration.
            # =================================================================

            if not peer_id:

                await safe_send(
                    websocket,
                    {
                        "type": "error",
                        "message": "Not registered",
                    },
                )

                continue

            # =================================================================
            # 2. CONNECT REQUEST
            # =================================================================

            if msg_type == "connect_request":

                # Rate limit requests.
                if is_rate_limited(client_ip):

                    await safe_send(
                        websocket,
                        {
                            "type": "error",
                            "message": (
                                "Rate limit exceeded - "
                                "too many connection requests"
                            ),
                        },
                    )

                    continue

                from_id = normalize_peer_id(
                    msg.get("from", "")
                )

                to_id = normalize_peer_id(
                    msg.get("to", "")
                )

                # Security: sender must be the registered peer.
                if from_id != peer_id:

                    await safe_send(
                        websocket,
                        {
                            "type": "error",
                            "message": "Sender ID does not match registration",
                        },
                    )

                    continue

                if not to_id:

                    await safe_send(
                        websocket,
                        {
                            "type": "error",
                            "message": "Invalid target peer ID",
                        },
                    )

                    continue

                if to_id == peer_id:

                    await safe_send(
                        websocket,
                        {
                            "type": "error",
                            "message": "Cannot connect to yourself",
                        },
                    )

                    continue

                # Check target.
                if to_id not in online_users:

                    logger.info(
                        "[connect_request] target unavailable "
                        "from=%s to=%s",
                        from_id,
                        to_id,
                    )

                    await safe_send(
                        websocket,
                        {
                            "type": "error",
                            "message": "peer not available",
                        },
                    )

                    continue

                forwarded = dict(msg)

                # Always normalize both IDs.
                forwarded["from"] = from_id
                forwarded["to"] = to_id

                target_ws = online_users[to_id]

                ok = await safe_send(
                    target_ws,
                    forwarded,
                )

                if not ok:

                    if online_users.get(to_id) is target_ws:
                        online_users.pop(
                            to_id,
                            None,
                        )

                    await safe_send(
                        websocket,
                        {
                            "type": "error",
                            "message": "peer not available",
                        },
                    )

                    continue

                logger.info(
                    "[connect_request] from=%s to=%s",
                    from_id,
                    to_id,
                )

                continue

            # =================================================================
            # 3. CONNECT RESPONSE
            # =================================================================

            if msg_type == "connect_response":

                to_id = normalize_peer_id(
                    msg.get("to", "")
                )

                await relay_to_peer(
                    sender_ws=websocket,
                    sender_id=peer_id,
                    target_id=to_id,
                    message=msg,
                    message_type="connect_response",
                )

                continue

            # =================================================================
            # 4. HANDSHAKE CONFIRM
            # =================================================================

            if msg_type == "handshake_confirm":

                to_id = normalize_peer_id(
                    msg.get("to", "")
                )

                # This message MUST reach the peer that originally
                # accepted the connection.
                await relay_to_peer(
                    sender_ws=websocket,
                    sender_id=peer_id,
                    target_id=to_id,
                    message=msg,
                    message_type="handshake_confirm",
                )

                continue

            # =================================================================
            # 5. SDP / ICE
            # =================================================================

            if msg_type in (
                "sdp_offer",
                "sdp_answer",
                "ice_candidate",
            ):

                to_id = normalize_peer_id(
                    msg.get("to", "")
                )

                # SDP/ICE can legitimately arrive while the peer is
                # disconnecting, so don't create a noisy error response.
                await relay_to_peer(
                    sender_ws=websocket,
                    sender_id=peer_id,
                    target_id=to_id,
                    message=msg,
                    message_type=msg_type,
                    require_target=False,
                )

                continue

            # =================================================================
            # UNKNOWN MESSAGE
            # =================================================================

            await safe_send(
                websocket,
                {
                    "type": "error",
                    "message": (
                        f"Unknown message type: {msg_type}"
                    ),
                },
            )

    # =========================================================================
    # WebSocket disconnected normally
    # =========================================================================

    except WebSocketDisconnect:

        logger.info(
            "[disconnect] websocket closed id=%s",
            peer_id,
        )

    # =========================================================================
    # Unexpected error
    # =========================================================================

    except Exception as exc:

        logger.warning(
            "[error] peer=%s ip=%s err=%s",
            peer_id,
            client_ip,
            exc,
        )

    # =========================================================================
    # Cleanup
    # =========================================================================

    finally:

        # Only remove this registration if the dictionary still points
        # to THIS WebSocket. This prevents an old connection from deleting
        # a newer connection that reused the same peer ID.
        if (
            peer_id
            and online_users.get(peer_id) is websocket
        ):

            online_users.pop(
                peer_id,
                None,
            )

            logger.info(
                "[disconnect] id=%s online=%d",
                peer_id,
                len(online_users),
            )


# =============================================================================
# Local development entry point
# =============================================================================

if __name__ == "__main__":

    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=False,
    )