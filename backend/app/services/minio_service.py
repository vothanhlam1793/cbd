"""MinIO S3 Integration for CBD Motion Lab."""

import io
import mimetypes
import os
import uuid
from typing import BinaryIO, Optional
import boto3
from botocore.client import Config

MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "http://127.0.0.1:9020")
MINIO_PUBLIC_URL = os.getenv("MINIO_PUBLIC_URL", "https://minio.nvlit.asia").rstrip("/")
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY", "7c70570adb7108f7289d1380103ecb4d")
MINIO_DEFAULT_BUCKET = os.getenv("MINIO_DEFAULT_BUCKET", "cbd-motion-lab")


def get_s3_client():
    return boto3.client(
        "s3",
        endpoint_url=MINIO_ENDPOINT,
        aws_access_key_id=MINIO_ACCESS_KEY,
        aws_secret_access_key=MINIO_SECRET_KEY,
        config=Config(signature_version="s3v4"),
        region_name="us-east-1",
    )


def ensure_bucket_exists(bucket: str = MINIO_DEFAULT_BUCKET):
    try:
        s3 = get_s3_client()
        buckets = [b["Name"] for b in s3.list_buckets().get("Buckets", [])]
        if bucket not in buckets:
            s3.create_bucket(Bucket=bucket)
            print(f"[MinIO] Created bucket '{bucket}'")
    except Exception as e:
        print(f"[MinIO] Error ensuring bucket '{bucket}': {e}")


def upload_file_bytes(
    file_bytes: bytes | BinaryIO,
    filename: str,
    bucket: Optional[str] = None,
    prefix: str = "uploads",
    content_type: Optional[str] = None,
) -> str:
    target_bucket = bucket or MINIO_DEFAULT_BUCKET
    ensure_bucket_exists(target_bucket)
    s3 = get_s3_client()

    if not content_type:
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"

    unique_key = f"{prefix.strip('/')}/{uuid.uuid4().hex[:10]}_{filename.replace(' ', '_')}"
    if isinstance(file_bytes, bytes):
        body = io.BytesIO(file_bytes)
    else:
        body = file_bytes

    s3.upload_fileobj(
        body,
        target_bucket,
        unique_key,
        ExtraArgs={"ContentType": content_type},
    )

    return f"{MINIO_PUBLIC_URL}/{target_bucket}/{unique_key}"


def upload_local_file(
    local_path: str,
    target_key: str,
    bucket: Optional[str] = None,
    content_type: Optional[str] = None,
) -> str:
    target_bucket = bucket or MINIO_DEFAULT_BUCKET
    ensure_bucket_exists(target_bucket)
    s3 = get_s3_client()

    if not content_type:
        content_type = mimetypes.guess_type(local_path)[0] or "application/octet-stream"

    with open(local_path, "rb") as f:
        s3.upload_fileobj(
            f,
            target_bucket,
            target_key,
            ExtraArgs={"ContentType": content_type},
        )

    return f"{MINIO_PUBLIC_URL}/{target_bucket}/{target_key}"


def get_object_stream(target_key: str, bucket: Optional[str] = None):
    target_bucket = bucket or MINIO_DEFAULT_BUCKET
    s3 = get_s3_client()
    return s3.get_object(Bucket=target_bucket, Key=target_key)
