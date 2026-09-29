"""Video Pre-computation & Case Processing Pipeline.

Runs batch analysis on uploaded videos or recorded sessions:
1. Streams video frame-by-frame via OpenCV.
2. Extracts optical flow, cadence FFT, triggers.
3. Saves frame-by-frame telemetry & trigger evidence to Database & MinIO.
4. Updates case status to 'ready'.
"""

import os
import subprocess
import time
import uuid
from typing import Optional
import cv2
import numpy as np
from sqlalchemy.orm import Session

from backend.app.framework import Pipeline
from backend.app.models.schema import AnalysisCase, CaseTelemetry, TriggerEvent
from backend.app.services.minio_service import upload_file_bytes
from backend.app.services.ws_manager import ws_manager

# In-memory registry of actively running and canceled video analysis jobs
RUNNING_CASES = set()
CANCELED_CASES = set()


def is_case_running(case_id: str) -> bool:
    return case_id in RUNNING_CASES


def cancel_case_processing(case_id: str):
    if case_id in RUNNING_CASES:
        CANCELED_CASES.add(case_id)



def ensure_web_preview_generated(case_id: str, master_video_path: str) -> Optional[str]:
    """Generates a browser-compatible H264 preview in background if master video is HEVC/H.265.
    Master video remains 100% authoritative and unchanged as the computation source."""
    if not master_video_path or not os.path.exists(master_video_path):
        return None

    web_path = os.path.join(os.path.dirname(master_video_path), f"{case_id}_web.mp4")
    if os.path.exists(web_path):
        return web_path

    try:
        probe_cmd = [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=codec_name", "-of", "default=noprint_wrappers=1:nokey=1",
            master_video_path
        ]
        res = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=5)
        codec = res.stdout.strip().lower()
        if codec in ["hevc", "h265"]:
            cmd = [
                "ffmpeg", "-y", "-hwaccel", "cuda", "-hwaccel_output_format", "cuda",
                "-i", master_video_path,
                "-c:v", "h264_nvenc", "-preset", "p1", "-cq", "26",
                "-c:a", "aac",
                web_path
            ]
            trans_res = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
            if trans_res.returncode == 0:
                print(f"[WebPreview] Auto-generated browser preview for {case_id}: {web_path}")
                return web_path
    except Exception as e:
        print(f"[WebPreview] Generation error for {case_id}: {e}")
    return master_video_path


def process_video_case(
    db: Session,
    case_id: str,
    video_path: str,
    config_params: dict = None,
):
    from backend.app.database import SessionLocal
    # Register in running set
    RUNNING_CASES.add(case_id)
    CANCELED_CASES.discard(case_id)
    # Create a fresh session for the background worker
    worker_db = SessionLocal()
    try:
        _run_process(worker_db, case_id, video_path, config_params)
    except Exception as exc:
        worker_db.rollback()
        case = worker_db.query(AnalysisCase).filter(AnalysisCase.id == case_id).first()
        if case:
            case.status = 'failed'
            case.summary_stats = {'error': str(exc)}
            worker_db.commit()
        raise
    finally:
        RUNNING_CASES.discard(case_id)
        CANCELED_CASES.discard(case_id)
        worker_db.close()


def _run_process(
    db: Session,
    case_id: str,
    video_path: str,
    config_params: dict = None,
):
    case = db.query(AnalysisCase).filter(AnalysisCase.id == case_id).first()
    if not case:
        print(f"[Processor] Case {case_id} not found.")
        return

    case.status = "processing"
    db.commit()

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        case.status = "failed"
        case.summary_stats = {"error": "Cannot open video file"}
        db.commit()
        return

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    duration_sec = total_frames / fps if fps > 0 else 0.0

    case.fps = fps
    case.total_frames = total_frames
    case.duration_sec = duration_sec
    case.resolution = f"{width}x{height}"
    pipeline = Pipeline(config_params, fps=fps)
    case.config_params = pipeline.config
    db.commit()

    # Ensure browser-compatible web preview exists early if master file is H265/HEVC
    ensure_web_preview_generated(case_id, video_path)

    start_perf = time.time()
    frame_idx = 0
    telemetry_records = []
    trigger_records = []
    total_triggers_created = 0

    speeds = []
    sharpnesses = []

    while True:
        if case_id in CANCELED_CASES:
            print(f"[Processor] Case {case_id} was requested to cancel. Stopping gracefully.")
            cap.release()
            db.query(CaseTelemetry).filter(CaseTelemetry.case_id == case_id).delete()
            db.query(TriggerEvent).filter(TriggerEvent.case_id == case_id).delete()
            case.status = "ready"
            case.summary_stats = {"status": "canceled_by_user", "message": "Tác vụ đã bị người dùng hủy/reset"}
            db.commit()
            try:
                ws_manager.broadcast_sync({
                    "type": "PROCESSING_FINISHED",
                    "case_id": case_id,
                    "status": "ready",
                    "canceled": True,
                    "summary": case.summary_stats,
                })
            except Exception:
                pass
            return

        ret, frame = cap.read()
        if not ret:
            break

        timestamp_sec = frame_idx / fps
        timestamp_ms = timestamp_sec * 1000.0

        # Motion analysis
        m, c, trigs = pipeline.process(frame, timestamp_sec, frame_idx)

        speeds.append(m.speed)
        sharpnesses.append(m.sharpness)

        # Batch telemetry record
        telemetry_records.append(
            CaseTelemetry(
                case_id=case_id,
                frame_idx=frame_idx,
                timestamp_ms=timestamp_ms,
                flow_dx=m.dx,
                flow_dy=m.dy,
                motion_speed=m.speed,
                motion_direction_deg=m.direction_deg,
                rotation_deg=m.rotation_deg,
                sharpness_score=m.sharpness,
                tracking_confidence=m.confidence,
                tracked_points_count=m.tracked_points_count,
                cadence_mean=c.mean_speed,
                cadence_std=c.std_speed,
                is_periodic=c.is_periodic,
                dominant_freq_hz=c.dominant_freq_hz,
                periodicity_score=c.periodicity_score,
                predicted_state=c.predicted_state,
            )
        )

        # Handle Triggers: save evidence frame to MinIO
        for tr in trigs:
            # Encode frame to JPEG
            encode_ok, jpg_buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            evidence_url = None
            if encode_ok:
                ev_filename = f"ev_{case_id}_{frame_idx}_{tr.trigger_type}.jpg"
                try:
                    evidence_url = upload_file_bytes(
                        jpg_buf.tobytes(),
                        ev_filename,
                        bucket="cbd-motion-lab",
                        prefix=f"evidence/{case_id}",
                        content_type="image/jpeg",
                    )
                except Exception as e:
                    print(f"[Processor] Evidence upload error: {e}")

            trigger_records.append(
                TriggerEvent(
                    id=str(uuid.uuid4()),
                    case_id=case_id,
                    frame_idx=frame_idx,
                    timestamp_ms=timestamp_ms,
                    trigger_type=tr.trigger_type,
                    reason=tr.reason,
                    evidence_minio_url=evidence_url,
                    sharpness_score=tr.sharpness,
                    context_state=tr.context_state,
                    details=tr.details,
                )
            )

            total_triggers_created += 1

        frame_idx += 1

        # Broadcast progress every 10 frames or at the end
        if frame_idx % 10 == 0 or frame_idx == total_frames:
            now_elapsed = time.time() - start_perf
            cur_fps = frame_idx / now_elapsed if now_elapsed > 0 else 0.0
            percent = round((frame_idx / total_frames) * 100.0, 1) if total_frames > 0 else 0.0
            try:
                ws_manager.broadcast_sync({
                    "type": "PROCESSING_PROGRESS",
                    "case_id": case_id,
                    "current_frame": frame_idx,
                    "total_frames": total_frames,
                    "percent": percent,
                    "elapsed_sec": round(now_elapsed, 1),
                    "current_fps": round(cur_fps, 1),
                    "triggers_count": total_triggers_created,
                })
            except Exception:
                pass

        # Commit in chunks of 500 to keep memory optimal
        if len(telemetry_records) >= 500:
            db.bulk_save_objects(telemetry_records)
            db.commit()
            telemetry_records.clear()

    cap.release()

    if telemetry_records:
        db.bulk_save_objects(telemetry_records)
        telemetry_records.clear()

    if trigger_records:
        db.bulk_save_objects(trigger_records)
        trigger_records.clear()

    # Ensure browser-compatible web preview exists if master file is H265/HEVC
    ensure_web_preview_generated(case_id, video_path)

    elapsed = time.time() - start_perf
    processed_fps = frame_idx / elapsed if elapsed > 0 else 0.0

    case.status = "ready"
    case.total_frames = frame_idx
    case.summary_stats = {
        **pipeline.stats(),
        "avg_speed": round(float(np.mean(speeds)), 2) if speeds else 0.0,
        "max_speed": round(float(np.max(speeds)), 2) if speeds else 0.0,
        "avg_sharpness": round(float(np.mean(sharpnesses)), 2) if sharpnesses else 0.0,
        "processing_time_sec": round(elapsed, 2),
        "processing_fps": round(processed_fps, 1),
        "total_triggers": total_triggers_created,
    }
    db.commit()

    # Broadcast finished event over WebSocket
    try:
        ws_manager.broadcast_sync({
            "type": "PROCESSING_FINISHED",
            "case_id": case_id,
            "summary": case.summary_stats,
            "total_frames": frame_idx,
            "triggers_count": total_triggers_created,
        })
    except Exception:
        pass

    print(f"[Processor] Case {case_id} processed in {elapsed:.2f}s ({processed_fps:.1f} FPS)")
