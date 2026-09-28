"""Database configuration for CBD Motion Lab."""

import os
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://cbd_user:cbd_password_2026@127.0.0.1:5440/cbd_motion"
)

# Fallback to local SQLite if Postgres is unreachable
try:
    engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_size=10, max_overflow=20)
    with engine.connect() as conn:
        pass
    print("[DB] Connected to PostgreSQL successfully at 127.0.0.1:5440")
except Exception as e:
    print(f"[DB] PostgreSQL connection failed ({e}), falling back to SQLite local database.")
    SQLITE_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../data/cbd.sqlite"))
    os.makedirs(os.path.dirname(SQLITE_PATH), exist_ok=True)
    DATABASE_URL = f"sqlite:///{SQLITE_PATH}"
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
