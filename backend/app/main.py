"""FastAPI Application Main Entry."""

import base64
import os
import secrets
from fastapi import FastAPI, Request, Response, WebSocket as FastAPIWebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from backend.app.api.routes import router as api_router
from backend.app.database import Base, engine
from backend.app.services.minio_service import ensure_bucket_exists

Base.metadata.create_all(bind=engine)
ensure_bucket_exists("cbd-motion-lab")

app = FastAPI(
    title="CBD Motion Lab API",
    description="Spatial motion estimation, cadence analysis, and trigger engine for 200 Body Cameras",
    version="1.0.0",
)


class BasicAuthMiddleware(BaseHTTPMiddleware):
    """Protects all web routes and APIs with admin:admin@123.
    Once authenticated via Basic Auth, sets a persistent 30-day Cookie (cbd_auth_token)
    so users only ever have to log in once."""
    AUTH_COOKIE_NAME = "cbd_auth_token"
    AUTH_COOKIE_VALUE = "cbd_session_v1_admin_2026"
    MAX_AGE_SECONDS = 60 * 60 * 24 * 30  # 30 days

    async def dispatch(self, request: Request, call_next):
        # Allow CORS preflight requests
        if request.method == "OPTIONS":
            return await call_next(request)

        # 1. Check persistent cookie first
        cookie_val = request.cookies.get(self.AUTH_COOKIE_NAME)
        if cookie_val and secrets.compare_digest(cookie_val, self.AUTH_COOKIE_VALUE):
            return await call_next(request)

        # 2. Check HTTP Basic Auth Header
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Basic "):
            try:
                auth_bytes = base64.b64decode(auth_header.split(" ", 1)[1])
                username, _, password = auth_bytes.decode("utf-8").partition(":")
                is_valid_user = secrets.compare_digest(username, "admin")
                is_valid_pass = secrets.compare_digest(password, "admin@123")
                if is_valid_user and is_valid_pass:
                    response = await call_next(request)
                    # Set persistent cookie for 30 days so user never has to re-enter
                    response.set_cookie(
                        key=self.AUTH_COOKIE_NAME,
                        value=self.AUTH_COOKIE_VALUE,
                        max_age=self.MAX_AGE_SECONDS,
                        path="/",
                        httponly=False,
                        samesite="lax",
                    )
                    return response
            except Exception:
                pass

        # 3. Request authentication prompt
        return Response(
            status_code=401,
            headers={"WWW-Authenticate": 'Basic realm="CBD Motion Lab - Login Required"'},
            content="Authentication required: CBD Motion Lab (admin:admin@123)",
        )


app.add_middleware(BasicAuthMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Dedicated WebSocket route in main app to bypass prefix router middleware if any
@app.websocket("/api/ws/debug")
async def ws_debug_handler(websocket: FastAPIWebSocket):
    from backend.app.services.ws_manager import ws_manager
    import time
    import json
    await ws_manager.connect(websocket)
    try:
        await websocket.send_text(json.dumps({
            "type": "SYSTEM_INFO",
            "timestamp": time.time() * 1000.0,
            "data": {
                "server": "CBD Motion Lab Engine",
                "version": "v1.0.2",
                "status": "online"
            }
        }))
        while True:
            data = await websocket.receive_text()
            if not data:
                continue
            try:
                msg = json.loads(data)
                if msg.get("type") == "PING":
                    await websocket.send_text(json.dumps({
                        "type": "PONG",
                        "client_time": msg.get("timestamp"),
                        "server_time": time.time() * 1000.0
                    }))
            except Exception:
                pass
    except Exception:
        ws_manager.disconnect(websocket)

app.include_router(api_router, prefix="/api")

# Static frontend mount
FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../frontend"))
os.makedirs(FRONTEND_DIR, exist_ok=True)
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.app.main:app", host="0.0.0.0", port=8095, reload=True)
