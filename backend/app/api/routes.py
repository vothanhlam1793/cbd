"""REST and WebSocket APIs for CBD Motion Lab."""

import datetime
import json
import os
import shutil
import time
import uuid
from typing import Dict, List, Optional
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from backend.app.core.motion_engine import MotionEngine
from backend.app.core.cadence_analyzer import CadenceAnalyzer
from backend.app.core.trigger_rules import TriggerEngine
from backend.app.database import SessionLocal, get_db
from backend.app.models.schema import AnalysisCase, CaseTelemetry, Device, TriggerEvent
from backend.app.services.minio_service import upload_local_file
from backend.app.services.stream_recorder import StreamRecorderService
from backend.app.services.video_processor import process_video_case
from backend.app.services.ws_manager import ws_manager

router = APIRouter()
recorder_service = StreamRecorderService()


# ---------------------------------------------------------
# WEBSOCKET REALTIME & DEBUG ENDPOINT
# ---------------------------------------------------------
@router.websocket("/ws/debug")
async def websocket_debug_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        # Send initial welcome & system info
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
            except Exception as e:
                print(f"[WS Error] JSON parse/handling: {e}")
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception as e:
        print(f"[WS Disconnect] {e}")
        ws_manager.disconnect(websocket)


# ---------------------------------------------------------
# DEVICES APIS
# ---------------------------------------------------------
@router.get("/devices")
def list_devices(db: Session = Depends(get_db)):
    return db.query(Device).order_by(Device.created_at.desc()).all()


@router.post("/devices")
def create_device(
    payload: Dict,
    db: Session = Depends(get_db),
):
    dev_id = payload.get("id") or f"dev_{uuid.uuid4().hex[:8]}"
    device = Device(
        id=dev_id,
        name=payload.get("name", "Camera Body"),
        rtsp_main_url=payload.get("rtsp_main_url"),
        rtsp_sub_url=payload.get("rtsp_sub_url"),
        location=payload.get("location", "Công trường"),
        site_group=payload.get("site_group"),
        assigned_worker=payload.get("assigned_worker"),
        status="offline",
        notes=payload.get("notes"),
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


@router.delete("/devices/{device_id}")
def delete_device(device_id: str, db: Session = Depends(get_db)):
    dev = db.query(Device).filter(Device.id == device_id).first()
    if not dev:
        raise HTTPException(status_code=404, detail="Device not found")
    db.delete(dev)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------
# CASES APIS
# ---------------------------------------------------------
@router.get("/cases")
def list_cases(db: Session = Depends(get_db)):
    cases = db.query(AnalysisCase).order_by(AnalysisCase.created_at.desc()).all()
    out = []
    for c in cases:
        out.append({
            "id": c.id,
            "title": c.title,
            "device_id": c.device_id,
            "source_type": c.source_type,
            "video_minio_url": c.video_minio_url,
            "video_local_path": c.video_local_path,
            "fps": c.fps,
            "total_frames": c.total_frames,
            "duration_sec": c.duration_sec,
            "resolution": c.resolution,
            "algorithm_version": c.algorithm_version,
            "config_params": c.config_params,
            "status": c.status,
            "summary_stats": c.summary_stats,
            "trigger_count": len(c.triggers) if c.triggers else 0,
            "created_at": (c.created_at.isoformat() + "Z") if c.created_at else None,
        })
    return out


@router.get("/cases/{case_id}")
def get_case_detail(case_id: str, db: Session = Depends(get_db)):
    c = db.query(AnalysisCase).filter(AnalysisCase.id == case_id).first()
    if not c:
        raise HTTPException(status_code=404, detail="Case not found")

    triggers = db.query(TriggerEvent).filter(TriggerEvent.case_id == case_id).order_by(TriggerEvent.timestamp_ms.asc()).all()

    return {
        "id": c.id,
        "title": c.title,
        "device_id": c.device_id,
        "source_type": c.source_type,
        "video_minio_url": c.video_minio_url,
        "video_local_path": c.video_local_path,
        "fps": c.fps,
        "total_frames": c.total_frames,
        "duration_sec": c.duration_sec,
        "resolution": c.resolution,
        "algorithm_version": c.algorithm_version,
        "config_params": c.config_params,
        "status": c.status,
        "summary_stats": c.summary_stats,
        "triggers": [
            {
                "id": t.id,
                "frame_idx": t.frame_idx,
                "timestamp_ms": t.timestamp_ms,
                "trigger_type": t.trigger_type,
                "reason": t.reason,
                "evidence_minio_url": t.evidence_minio_url,
                "sharpness_score": t.sharpness_score,
                "context_state": t.context_state,
                "details": t.details,
            }
            for t in triggers
        ],
        "created_at": (c.created_at.isoformat() + "Z") if c.created_at else None,
    }


@router.get("/cases/{case_id}/telemetry")
def get_case_telemetry(case_id: str, db: Session = Depends(get_db)):
    records = db.query(CaseTelemetry).filter(CaseTelemetry.case_id == case_id).order_by(CaseTelemetry.frame_idx.asc()).all()
    return [
        {
            "frame_idx": r.frame_idx,
            "timestamp_ms": round(r.timestamp_ms, 1),
            "flow_dx": round(r.flow_dx, 2),
            "flow_dy": round(r.flow_dy, 2),
            "speed": round(r.motion_speed, 2),
            "direction_deg": round(r.motion_direction_deg, 1),
            "rotation_deg": round(r.rotation_deg, 2),
            "sharpness": round(r.sharpness_score, 1),
            "confidence": round(r.tracking_confidence, 2),
            "cadence_mean": round(r.cadence_mean, 2),
            "is_periodic": r.is_periodic,
            "dominant_freq_hz": round(r.dominant_freq_hz, 2),
            "predicted_state": r.predicted_state,
        }
        for r in records
    ]


@router.api_route("/cases/{case_id}/video", methods=["GET", "HEAD"])
def stream_case_video(case_id: str, db: Session = Depends(get_db)):
    from fastapi.responses import FileResponse
    c = db.query(AnalysisCase).filter(AnalysisCase.id == case_id).first()
    if not c or not c.video_local_path or not os.path.exists(c.video_local_path):
        raise HTTPException(status_code=404, detail="Local video file not found")

    # Priority: Serve browser-compatible web preview if available
    candidate_web = os.path.join(os.path.dirname(c.video_local_path), f"{case_id}_web.mp4")
    if os.path.exists(candidate_web):
        return FileResponse(candidate_web, media_type="video/mp4")

    return FileResponse(c.video_local_path, media_type="video/mp4")


@router.post("/cases/upload")
async def upload_video_case(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    device_id: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    case_id = f"case_{uuid.uuid4().hex[:8]}"
    upload_dir = "/home/leco/cbd/backend/data/uploads"
    os.makedirs(upload_dir, exist_ok=True)
    
    local_path = os.path.join(upload_dir, f"{case_id}_{file.filename}")
    with open(local_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    # 1. Upload original video to MinIO
    minio_url = None
    try:
        minio_url = upload_local_file(
            local_path,
            target_key=f"videos/{case_id}/{file.filename}",
            bucket="cbd-motion-lab",
            content_type=file.content_type,
        )
    except Exception as e:
        print(f"[Upload] MinIO upload error: {e}")

    # 2. Create Case record
    case_title = title or file.filename
    case = AnalysisCase(
        id=case_id,
        device_id=device_id if device_id else None,
        title=case_title,
        source_type="upload",
        video_minio_url=minio_url,
        video_local_path=local_path,
        status="processing",
    )
    db.add(case)
    db.commit()

    # 3. Schedule async video precomputation
    background_tasks.add_task(process_video_case, db, case_id, local_path)

    return {"case_id": case_id, "status": "processing", "minio_url": minio_url}


@router.post("/cases/{case_id}/rerun")
def rerun_case_analysis(
    case_id: str,
    payload: Dict,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    case = db.query(AnalysisCase).filter(AnalysisCase.id == case_id).first()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")

    # Clear previous telemetry and triggers
    db.query(CaseTelemetry).filter(CaseTelemetry.case_id == case_id).delete()
    db.query(TriggerEvent).filter(TriggerEvent.case_id == case_id).delete()
    
    case.config_params = payload.get("config_params", {})
    case.algorithm_version = payload.get("algorithm_version", case.algorithm_version)
    case.status = "processing"
    db.commit()

    background_tasks.add_task(
        process_video_case, db, case_id, case.video_local_path, case.config_params
    )
    return {"case_id": case_id, "status": "processing"}


@router.delete("/cases/{case_id}")
def delete_case(case_id: str, db: Session = Depends(get_db)):
    case = db.query(AnalysisCase).filter(AnalysisCase.id == case_id).first()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    
    # Delete local file if exists
    if case.video_local_path and os.path.exists(case.video_local_path):
        try:
            os.remove(case.video_local_path)
        except Exception:
            pass

    db.delete(case)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------
# RTSP LIVE SESSION & FEED APIS
# ---------------------------------------------------------
@router.get("/live/{device_id}/feed")
def stream_live_mjpeg_feed(device_id: str, db: Session = Depends(get_db)):
    from fastapi.responses import StreamingResponse
    import cv2
    import time
    
    dev = db.query(Device).filter(Device.id == device_id).first()
    if not dev or not dev.rtsp_sub_url:
        raise HTTPException(status_code=404, detail="Device or RTSP substream URL not found")
    
    rtsp_url = dev.rtsp_sub_url
    
    def mjpeg_generator():
        import os
        os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = 'rtsp_transport;tcp'
        cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
        motion = MotionEngine(max_corners=80)
        cadence = CadenceAnalyzer(fps=15.0, window_sec=1.5)
        
        frame_idx = 0
        start_t = time.time()
        
        try:
            while True:
                ret, frame = cap.read()
                if not ret:
                    time.sleep(0.05)
                    continue
                
                frame_idx += 1
                curr_t = time.time() - start_t
                
                # Perform fast motion & cadence analysis
                m = motion.process_frame(frame, return_points=True)
                c = cadence.update(curr_t, m.speed, m.dy, m.dx, m.confidence)
                
                # Broadcast real-time live telemetry over WebSocket
                if frame_idx % 2 == 0:
                    try:
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
                        ws_manager.broadcast_sync({
                            "type": "LIVE_TELEMETRY",
                            "case_id": "live_preview",
                            "device_id": device_id,
                            "timestamp": curr_t * 1000.0,
                            "data": telemetry_payload,
                        })
                    except Exception:
                        pass
                
                # Compress to JPEG with medium quality for fast HTTP/2 chunking
                encode_ok, jpg_buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 60])
                if encode_ok:
                    yield (b'--frame\r\n'
                           b'Content-Type: image/jpeg\r\n'
                           b'Content-Length: ' + str(len(jpg_buf)).encode() + b'\r\n\r\n' +
                           jpg_buf.tobytes() + b'\r\n')
                time.sleep(0.04) # ~25 FPS stable rate
        except (GeneratorExit, StopIteration, BrokenPipeError, ConnectionResetError):
            pass
        finally:
            cap.release()
            
    headers = {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return StreamingResponse(
        mjpeg_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers=headers,
    )


@router.post("/live/start")
def start_live_session(payload: Dict):
    device_id = payload.get("device_id", "dev_unknown")
    rtsp_url = payload.get("rtsp_url")
    title = payload.get("title", f"RTSP Session {device_id}")

    if not rtsp_url:
        raise HTTPException(status_code=400, detail="Missing rtsp_url")

    case_id = recorder_service.start_session(device_id, rtsp_url, title)
    return {"case_id": case_id, "status": "recording"}


@router.post("/live/stop")
def stop_live_session(payload: Dict):
    case_id = payload.get("case_id")
    if not case_id:
        raise HTTPException(status_code=400, detail="Missing case_id")

    minio_url = recorder_service.stop_session(case_id)
    return {"case_id": case_id, "status": "ready", "video_minio_url": minio_url}


@router.get("/live/{case_id}/state")
def get_live_state(case_id: str):
    return recorder_service.get_latest_state(case_id)


# ---------------------------------------------------------
# VLM BENCHMARK & EVALUATION APIS
# ---------------------------------------------------------
@router.post("/vlm/evaluate")
def trigger_vlm_evaluation(payload: Dict, db: Session = Depends(get_db)):
    from backend.app.services.vlm_eval_service import run_vlm_evaluation
    
    case_id = payload.get("case_id")
    if not case_id:
        raise HTTPException(status_code=400, detail="Missing case_id")
    
    model_name = payload.get("model_name", "qwen2-vl-7b")
    prompt_template = payload.get("prompt_template", "general_safety_audit")
    
    try:
        result = run_vlm_evaluation(
            db,
            case_id=case_id,
            model_name=model_name,
            prompt_template=prompt_template,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/vlm/evaluations/{case_id}")
def get_vlm_evaluations_for_case(case_id: str, db: Session = Depends(get_db)):
    from backend.app.models.schema import VLMEvaluationRun, VLMTriggerFeedback
    
    runs = (
        db.query(VLMEvaluationRun)
        .filter(VLMEvaluationRun.case_id == case_id)
        .order_by(VLMEvaluationRun.created_at.desc())
        .all()
    )
    
    out = []
    for r in runs:
        feedbacks = (
            db.query(VLMTriggerFeedback)
            .filter(VLMTriggerFeedback.run_id == r.id)
            .all()
        )
        out.append({
            "run_id": r.id,
            "case_id": r.case_id,
            "model_name": r.model_name,
            "prompt_template": r.prompt_template,
            "status": r.status,
            "total_triggers": r.total_triggers_evaluated,
            "true_positive": r.true_positive_count,
            "redundant": r.redundant_count,
            "blurred": r.blurred_count,
            "reduction_rate": r.vlm_reduction_rate,
            "avg_sharpness": r.avg_sharpness,
            "summary_insight": r.summary_insight,
            "recommended_params": r.recommended_params,
            "created_at": (r.created_at.isoformat() + "Z") if r.created_at else None,
            "feedbacks": [
                {
                    "trigger_id": fb.trigger_id,
                    "scene_description": fb.scene_description,
                    "worker_action": fb.worker_action,
                    "ppe_detected": fb.ppe_detected,
                    "relevance_score": fb.relevance_score,
                    "verdict": fb.verdict,
                    "suggested_tag": fb.suggested_tag,
                }
                for fb in feedbacks
            ],
        })
    return out


# ---------------------------------------------------------
# SENSOR SPEC EXPORT API (FOR DOWNSTREAM STATIONS / SYSTEMS)
# ---------------------------------------------------------
@router.get("/cases/{case_id}/export-spec")
def export_sensor_spec(case_id: str, db: Session = Depends(get_db)):
    case = db.query(AnalysisCase).filter(AnalysisCase.id == case_id).first()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")

    triggers = (
        db.query(TriggerEvent)
        .filter(TriggerEvent.case_id == case_id)
        .order_by(TriggerEvent.timestamp_ms.asc())
        .all()
    )

    return {
        "spec_version": "1.0.0",
        "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
        "case_id": case.id,
        "case_title": case.title,
        "source_resolution": case.resolution,
        "source_fps": case.fps,
        "total_triggers": len(triggers),
        "golden_sensor_parameters": case.config_params or {
            "profile": "inspection_sensor",
            "max_corners": 150,
            "window_sec": 0.8,
            "stable_speed_threshold": 1.2,
            "min_sharpness": 150.0,
            "max_occlusion_ratio": 0.30,
            "max_angular_yaw_vel": 180.0,
            "cooldown_sec": 15.0,
        },
        "trigger_contract_schema": {
            "trigger_type": "string (e.g. STABLE_INSPECTION_MOMENT)",
            "timestamp_ms": "float",
            "frame_idx": "integer",
            "sharpness_score": "float",
            "evidence_minio_url": "string (S3 URI)",
            "rich_metadata": {
                "spatial_motion": "speed, dx, dy, rotation_deg, angular_yaw_vel_px_s",
                "cadence_gait": "is_periodic, cadence_freq_hz, predicted_state",
                "visual_quality": "sharpness_laplacian, occlusion_ratio, is_occluded, mean_brightness, contrast_score",
                "temporal_context": "dwell_duration_sec, pre_stability_score"
            }
        },
        "triggers_sample": [
            {
                "id": tr.id,
                "timestamp_sec": round(tr.timestamp_ms / 1000.0, 2),
                "trigger_type": tr.trigger_type,
                "reason": tr.reason,
                "sharpness": tr.sharpness_score,
                "evidence_url": tr.evidence_minio_url,
                "rich_metadata": tr.details or {}
            }
            for tr in triggers
        ]
    }

