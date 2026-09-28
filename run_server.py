import os
import uvicorn
from backend.app.main import app

if __name__ == "__main__":
    print("[CBD Motion Lab] Starting Server on http://127.0.0.1:8095 ...")
    uvicorn.run(app, host="0.0.0.0", port=8095, log_level="info")
