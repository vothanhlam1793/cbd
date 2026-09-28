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

from backend.app.core.motion_engine import MotionEngine
from backend.app.core.cadence_analyzer import CadenceAnalyzer
from backend.app.core.trigger_rules import TriggerEngine
from backend.app.models.schema import AnalysisCase, CaseTelemetry, TriggerEvent
from backend.app.services.minio_service import upload_file_bytes
from backend.app.services.ws_manager import ws_manager


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
    # Create a fresh session for the background worker
    worker_db = SessionLocal()
    try:
        _run_process(worker_db, case_id, video_path, config_params)
    finally:
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

    cfg = config_params or {}
    profile = cfg.get("profile", "inspection_sensor")
    max_corners = cfg.get("max_corners", 150)
    window_sec = cfg.get("window_sec", 0.8)
    stable_thresh = cfg.get("stable_speed_threshold", 1.2)
    min_sharpness = cfg.get("min_sharpness", 150.0)
    max_occlusion = cfg.get("max_occlusion_ratio", 0.30)
    max_angular_yaw = cfg.get("max_angular_yaw_vel", 180.0)
    cooldown_sec = cfg.get("cooldown_sec", 15.0)
    spike_speed = cfg.get("spike_speed_threshold", 12.0)

    motion_engine = MotionEngine(max_corners=max_corners)
    cadence_analyzer = CadenceAnalyzer(window_sec=window_sec, stable_speed_threshold=stable_thresh)
    trigger_engine = TriggerEngine(
        profile=profile,
        min_stable_duration_sec=window_sec,
        min_sharpness=min_sharpness,
        max_occlusion_ratio=max_occlusion,
        max_angular_yaw_vel=max_angular_yaw,
        spike_speed_threshold=spike_speed,
        cooldown_sec=cooldown_sec,
    )

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
    cadence_analyzer.fps = fps

    start_perf = time.time()
    frame_idx = 0
    telemetry_records = []
    trigger_records = []
    total_triggers_created = 0

    speeds = []
    sharpnesses = []

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        timestamp_sec = frame_idx / fps
        timestamp_ms = timestamp_sec * 1000.0

        # Motion analysis
        m = motion_engine.process_frame(frame, return_points=False)
        c = cadence_analyzer.update(timestamp_sec, m.speed, m.dy, m.dx, m.confidence)
        trigs = trigger_engine.evaluate(
            frame_idx=frame_idx,
            timestamp_sec=timestamp_sec,
            speed=m.speed,
            sharpness=m.sharpness,
            confidence=m.confidence,
            stable_duration_sec=c.stable_duration_sec,
            is_periodic=c.is_periodic,
            dominant_freq_hz=c.dominant_freq_hz,
            predicted_state=c.predicted_state,
            occlusion_ratio=m.occlusion_ratio,
            mean_brightness=m.mean_brightness,
            contrast_score=m.contrast_score,
            angular_yaw_vel=c.angular_yaw_velocity,
            pre_stability=c.pre_stability_score,
            dx=m.dx,
            dy=m.dy,
            rotation_deg=m.rotation_deg,
        )

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
