"""RTSP Session Streamer and Background MP4 Recorder."""

import os
import subprocess
import threading
import time
import uuid
from typing import Dict, Optional
import cv2

from backend.app.core.cadence_analyzer import CadenceAnalyzer
from backend.app.core.motion_engine import MotionEngine
from backend.app.core.trigger_rules import TriggerEngine
from backend.app.database import SessionLocal
from backend.app.models.schema import AnalysisCase, CaseTelemetry, Device, TriggerEvent
from backend.app.services.minio_service import upload_local_file
from backend.app.services.ws_manager import ws_manager


class ActiveStreamSession:
    def __init__(self, session_id: str, device_id: str, rtsp_url: str, output_mp4: str):
        self.session_id = session_id
        self.device_id = device_id
        self.rtsp_url = rtsp_url
        self.output_mp4 = output_mp4
        self.is_running = False
        self.ffmpeg_proc: Optional[subprocess.Popen] = None
        self.thread: Optional[threading.Thread] = None

        self.latest_telemetry: Dict = {}
        self.latest_frame_jpeg: Optional[bytes] = None
        self.lock = threading.Lock()


class StreamRecorderService:
    def __init__(self, record_dir: str = "/home/leco/cbd/backend/data/records"):
        self.record_dir = record_dir
        os.makedirs(self.record_dir, exist_ok=True)
        self.active_sessions: Dict[str, ActiveStreamSession] = {}

    def start_session(self, device_id: str, rtsp_url: str, case_title: str) -> str:
        case_id = f"case_{uuid.uuid4().hex[:8]}"
        output_mp4 = os.path.join(self.record_dir, f"{case_id}.mp4")

        session = ActiveStreamSession(
            session_id=case_id,
            device_id=device_id,
            rtsp_url=rtsp_url,
            output_mp4=output_mp4,
        )
        self.active_sessions[case_id] = session
        session.is_running = True

        # 1. Start background FFmpeg stream recording (c:v copy for ultra low CPU)
        cmd = [
            "ffmpeg",
            "-y",
            "-rtsp_transport", "tcp",
            "-i", rtsp_url,
            "-c:v", "copy",
            "-an",
            "-f", "mp4",
            output_mp4,
        ]
        try:
            session.ffmpeg_proc = subprocess.Popen(
                cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
        except Exception as e:
            print(f"[StreamRecorder] FFmpeg spawn failed: {e}")

        # 2. Start Python OpenCV worker for real-time analysis
        session.thread = threading.Thread(
            target=self._analysis_worker, args=(session, case_title), daemon=True
        )
        session.thread.start()

        return case_id

    def stop_session(self, case_id: str) -> Optional[str]:
        session = self.active_sessions.get(case_id)
        if not session:
            return None

        session.is_running = False
        if session.ffmpeg_proc:
            session.ffmpeg_proc.terminate()
            try:
                session.ffmpeg_proc.wait(timeout=3)
            except Exception:
                session.ffmpeg_proc.kill()

        if session.thread:
            session.thread.join(timeout=3)

        # Upload MP4 to MinIO
        minio_url = None
        if os.path.exists(session.output_mp4):
            try:
                minio_url = upload_local_file(
                    session.output_mp4,
                    target_key=f"records/{case_id}.mp4",
                    bucket="cbd-motion-lab",
                    content_type="video/mp4",
                )
            except Exception as e:
                print(f"[StreamRecorder] MinIO upload error: {e}")

        # Update case in DB
        db = SessionLocal()
        try:
            case = db.query(AnalysisCase).filter(AnalysisCase.id == case_id).first()
            if case:
                case.status = "ready"
                case.video_minio_url = minio_url
                case.video_local_path = session.output_mp4
                db.commit()
        finally:
            db.close()

        del self.active_sessions[case_id]
        return minio_url

    def get_latest_state(self, case_id: str) -> Dict:
        session = self.active_sessions.get(case_id)
        if not session:
            return {"active": False}
        with session.lock:
            return {
                "active": True,
                "session_id": session.session_id,
                "device_id": session.device_id,
                "telemetry": session.latest_telemetry,
            }

    def _analysis_worker(self, session: ActiveStreamSession, case_title: str):
        db = SessionLocal()
        try:
            # Create Case in DB
            case = AnalysisCase(
                id=session.session_id,
                device_id=session.device_id,
                title=case_title,
                source_type="rtsp_session",
                video_local_path=session.output_mp4,
                status="recording",
            )
            db.add(case)
            db.commit()

            os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = 'rtsp_transport;tcp'
            cap = cv2.VideoCapture(session.rtsp_url, cv2.CAP_FFMPEG)
            motion = MotionEngine(max_corners=120)
            cadence = CadenceAnalyzer(fps=15.0, window_sec=1.5)
            triggers = TriggerEngine()

            frame_idx = 0
            start_t = time.time()

            while session.is_running and cap.isOpened():
                ret, frame = cap.read()
                if not ret:
                    time.sleep(0.05)
                    continue

                curr_t = time.time() - start_t
                m = motion.process_frame(frame, return_points=True)
                c = cadence.update(curr_t, m.speed, m.dy, m.dx, m.confidence)
                trigs = triggers.evaluate(
                    frame_idx=frame_idx,
                    timestamp_sec=curr_t,
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

                # Update live state
                telemetry_payload = {
                    "frame_idx": frame_idx,
                    "timestamp_ms": curr_t * 1000.0,
                    "dx": m.dx,
                    "dy": m.dy,
                    "speed": m.speed,
                    "sharpness": m.sharpness,
                    "confidence": m.confidence,
                    "cadence_mean": c.mean_speed,
                    "is_periodic": c.is_periodic,
                    "dominant_freq_hz": c.dominant_freq_hz,
                    "predicted_state": c.predicted_state,
                    "inliers": m.inlier_points_curr[:30],
                }
                with session.lock:
                    session.latest_telemetry = telemetry_payload

                # Broadcast live telemetry over WebSocket
                try:
                    ws_manager.broadcast_sync({
                        "type": "LIVE_TELEMETRY",
                        "case_id": session.session_id,
                        "device_id": session.device_id,
                        "timestamp": curr_t * 1000.0,
                        "data": telemetry_payload,
                    })
                except Exception:
                    pass

                # Save telemetry record to DB
                rec = CaseTelemetry(
                    case_id=session.session_id,
                    frame_idx=frame_idx,
                    timestamp_ms=curr_t * 1000.0,
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
                db.add(rec)

                for tr in trigs:
                    db.add(
                        TriggerEvent(
                            id=str(uuid.uuid4()),
                            case_id=session.session_id,
                            frame_idx=frame_idx,
                            timestamp_ms=curr_t * 1000.0,
                            trigger_type=tr.trigger_type,
                            reason=tr.reason,
                            sharpness_score=tr.sharpness,
                            context_state=tr.context_state,
                            details=tr.details,
                        )
                    )

                if frame_idx % 30 == 0:
                    db.commit()

                frame_idx += 1
                time.sleep(0.01)

            cap.release()
            db.commit()
        except Exception as e:
            print(f"[StreamRecorder] Worker error: {e}")
        finally:
            db.close()
