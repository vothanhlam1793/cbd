"""Database models for Devices, Cases, Telemetry, and Triggers."""

import datetime
from sqlalchemy import (
    Column,
    String,
    Integer,
    Float,
    Boolean,
    DateTime,
    Text,
    ForeignKey,
    JSON,
)
from sqlalchemy.orm import relationship
from backend.app.database import Base


class Device(Base):
    __tablename__ = "devices"

    id = Column(String(64), primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    rtsp_main_url = Column(String(1024), nullable=True)
    rtsp_sub_url = Column(String(1024), nullable=True)
    location = Column(String(255), nullable=True)
    site_group = Column(String(255), nullable=True)
    assigned_worker = Column(String(255), nullable=True)
    status = Column(String(32), default="offline")  # 'online', 'offline', 'streaming'
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

    cases = relationship("AnalysisCase", back_populates="device", cascade="all, delete-orphan")


class AnalysisCase(Base):
    __tablename__ = "cases"

    id = Column(String(64), primary_key=True, index=True)
    device_id = Column(String(64), ForeignKey("devices.id", ondelete="SET NULL"), nullable=True)
    title = Column(String(255), nullable=False)
    source_type = Column(String(32), nullable=False)  # 'upload', 'rtsp_session'
    video_minio_url = Column(Text, nullable=True)
    video_local_path = Column(Text, nullable=True)
    
    fps = Column(Float, default=30.0)
    total_frames = Column(Integer, default=0)
    duration_sec = Column(Float, default=0.0)
    resolution = Column(String(32), nullable=True)
    
    algorithm_version = Column(String(64), default="v1.0-shi-lk-ransac")
    config_params = Column(JSON, nullable=True)  # Tuning thresholds & window settings
    status = Column(String(32), default="pending")  # 'pending', 'processing', 'ready', 'failed'
    
    summary_stats = Column(JSON, nullable=True)  # Aggregated metrics (avg_speed, total_triggers, etc)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    
    device = relationship("Device", back_populates="cases")
    telemetry = relationship("CaseTelemetry", back_populates="case", cascade="all, delete-orphan")
    triggers = relationship("TriggerEvent", back_populates="case", cascade="all, delete-orphan")


class CaseTelemetry(Base):
    __tablename__ = "case_telemetry"

    id = Column(Integer, primary_key=True, autoincrement=True)
    case_id = Column(String(64), ForeignKey("cases.id", ondelete="CASCADE"), nullable=False, index=True)
    frame_idx = Column(Integer, nullable=False, index=True)
    timestamp_ms = Column(Float, nullable=False, index=True)
    
    # 2D Motion & Optical Flow Metrics
    flow_dx = Column(Float, default=0.0)
    flow_dy = Column(Float, default=0.0)
    motion_speed = Column(Float, default=0.0)  # Pixel distance per frame / time
    motion_direction_deg = Column(Float, default=0.0)  # Angle 0-360
    rotation_deg = Column(Float, default=0.0)  # Rotation component
    
    # Image Quality
    sharpness_score = Column(Float, default=0.0)  # Laplacian variance
    tracking_confidence = Column(Float, default=1.0)  # Inlier ratio / points count
    tracked_points_count = Column(Integer, default=0)
    
    # Cadence & Time-window metrics
    cadence_mean = Column(Float, default=0.0)
    cadence_std = Column(Float, default=0.0)
    is_periodic = Column(Boolean, default=False)
    dominant_freq_hz = Column(Float, default=0.0)
    periodicity_score = Column(Float, default=0.0)
    
    # Inferred State
    predicted_state = Column(String(32), default="unknown")  # 'stable', 'moving', 'periodic_motion', 'high_motion', 'unknown'
    
    case = relationship("AnalysisCase", back_populates="telemetry")


class TriggerEvent(Base):
    __tablename__ = "trigger_events"

    id = Column(String(64), primary_key=True, index=True)
    case_id = Column(String(64), ForeignKey("cases.id", ondelete="CASCADE"), nullable=False, index=True)
    frame_idx = Column(Integer, nullable=False)
    timestamp_ms = Column(Float, nullable=False)
    
    trigger_type = Column(String(64), nullable=False)  # 'STABLE_READY', 'PERIODICITY_DETECTED', 'MOTION_SPIKE', 'DIRECTION_CHANGED'
    reason = Column(Text, nullable=True)
    evidence_minio_url = Column(Text, nullable=True)
    sharpness_score = Column(Float, default=0.0)
    context_state = Column(String(32), nullable=True)
    details = Column(JSON, nullable=True)
    
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    
    case = relationship("AnalysisCase", back_populates="triggers")
    vlm_feedback = relationship("VLMTriggerFeedback", back_populates="trigger", uselist=False, cascade="all, delete-orphan")


class VLMEvaluationRun(Base):
    __tablename__ = "vlm_evaluation_runs"

    id = Column(String(64), primary_key=True, index=True)
    case_id = Column(String(64), ForeignKey("cases.id", ondelete="CASCADE"), nullable=False, index=True)
    model_name = Column(String(64), default="qwen2-vl-7b")  # 'qwen2-vl-7b', 'gemini-1.5-flash', 'local-slm'
    prompt_template = Column(String(128), default="general_safety_audit")
    
    status = Column(String(32), default="completed")  # 'running', 'completed', 'failed'
    total_triggers_evaluated = Column(Integer, default=0)
    true_positive_count = Column(Integer, default=0)  # Meaningful actionable keyframes
    redundant_count = Column(Integer, default=0)      # Repetitive frames while walking
    blurred_count = Column(Integer, default=0)        # Motion blur / unusable
    
    vlm_reduction_rate = Column(Float, default=0.0)   # % token / image reduction
    avg_sharpness = Column(Float, default=0.0)
    summary_insight = Column(Text, nullable=True)
    recommended_params = Column(JSON, nullable=True)  # Tuning recommendations for Classical CV
    
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    feedbacks = relationship("VLMTriggerFeedback", back_populates="evaluation_run", cascade="all, delete-orphan")


class VLMTriggerFeedback(Base):
    __tablename__ = "vlm_trigger_feedbacks"

    id = Column(String(64), primary_key=True, index=True)
    run_id = Column(String(64), ForeignKey("vlm_evaluation_runs.id", ondelete="CASCADE"), nullable=False, index=True)
    trigger_id = Column(String(64), ForeignKey("trigger_events.id", ondelete="CASCADE"), nullable=False, index=True)
    
    scene_description = Column(Text, nullable=True)
    worker_action = Column(String(64), nullable=True)    # 'inspecting_panel', 'walking_hallway', 'idle', 'abrupt_move'
    ppe_detected = Column(JSON, nullable=True)           # {"helmet": true, "vest": true}
    relevance_score = Column(Float, default=1.0)         # 0.0 - 1.0 (is it worth sending to VLM?)
    verdict = Column(String(32), default="useful")       # 'useful_keyframe', 'redundant_motion', 'blurry_unusable'
    suggested_tag = Column(String(64), nullable=True)
    
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    evaluation_run = relationship("VLMEvaluationRun", back_populates="feedbacks")
    trigger = relationship("TriggerEvent", back_populates="vlm_feedback")

