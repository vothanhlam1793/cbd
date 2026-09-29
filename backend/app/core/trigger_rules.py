"""Trigger Rule Engine for Event Detection & Best Evidence Frame Selection."""

from typing import Dict, List, Optional
import numpy as np


class TriggerEventData:
    def __init__(
        self,
        trigger_type: str,
        reason: str,
        timestamp_ms: float,
        frame_idx: int,
        sharpness: float,
        context_state: str,
        details: Optional[Dict] = None,
    ):
        self.trigger_type = trigger_type
        self.reason = reason
        self.timestamp_ms = float(timestamp_ms)
        self.frame_idx = int(frame_idx)
        self.sharpness = float(sharpness)
        self.context_state = context_state
        self.details = details or {}

    def to_dict(self) -> Dict:
        return {
            "trigger_type": self.trigger_type,
            "reason": self.reason,
            "timestamp_ms": round(self.timestamp_ms, 1),
            "frame_idx": self.frame_idx,
            "sharpness": round(self.sharpness, 1),
            "context_state": self.context_state,
            "details": self.details,
        }


class TriggerEngine:
    def __init__(
        self,
        profile: str = "inspection_sensor",
        min_stable_duration_sec: float = 0.8,
        min_sharpness: float = 150.0,
        max_occlusion_ratio: float = 0.30,
        max_angular_yaw_vel: float = 180.0,
        spike_speed_threshold: float = 12.0,
        cooldown_sec: float = 15.0,
    ):
        self.profile = profile
        self.min_stable_duration_sec = min_stable_duration_sec
        self.min_sharpness = min_sharpness
        self.max_occlusion_ratio = max_occlusion_ratio
        self.max_angular_yaw_vel = max_angular_yaw_vel
        self.spike_speed_threshold = spike_speed_threshold
        self.cooldown_sec = cooldown_sec

        self.last_trigger_time: Dict[str, float] = {}
        self.prev_state: str = "unknown"
        self.was_moving: bool = False

    def reset(self):
        self.last_trigger_time.clear()
        self.prev_state = "unknown"
        self.was_moving = False

    def evaluate(
        self,
        frame_idx: int,
        timestamp_sec: float,
        speed: float,
        sharpness: float,
        confidence: float,
        stable_duration_sec: float,
        is_periodic: bool,
        dominant_freq_hz: float,
        predicted_state: str,
        occlusion_ratio: float = 0.0,
        center_occlusion: float = 0.0,
        dark_ratio: float = 0.0,
        glare_ratio: float = 0.0,
        mean_brightness: float = 128.0,
        contrast_score: float = 50.0,
        angular_yaw_vel: float = 0.0,
        pre_stability: float = 1.0,
        dx: float = 0.0,
        dy: float = 0.0,
        rotation_deg: float = 0.0,
    ) -> List[TriggerEventData]:
        triggers = []
        now_ms = timestamp_sec * 1000.0

        def is_cooldown_active(trig_type: str) -> bool:
            last = self.last_trigger_time.get(trig_type, -9999.0)
            return (timestamp_sec - last) < self.cooldown_sec

        # -------------------------------------------------------------
        # KHỐI 2 INFERRED STATE: Suy luận trạng thái ống kính từ số liệu Khối 1
        # -------------------------------------------------------------
        if dark_ratio > 0.65 or mean_brightness < 18.0:
            inferred_lens_status = "POCKET_DARK"
        elif glare_ratio > 0.35:
            inferred_lens_status = "GLARE"
        elif occlusion_ratio >= 0.35 or center_occlusion >= 0.75:
            inferred_lens_status = "CLOTH_OCCLUDED"
        elif sharpness < 65.0:
            inferred_lens_status = "MOTION_BLUR" if speed > 3.0 else "DEFOCUS_BLUR"
        else:
            inferred_lens_status = "CLEAR"

        # Standard Rich Metadata Payload for any trigger
        rich_metadata = {
            "spatial_motion": {
                "speed_px_frame": round(speed, 2),
                "dx": round(dx, 2),
                "dy": round(dy, 2),
                "rotation_deg": round(rotation_deg, 2),
                "angular_yaw_vel_px_s": round(angular_yaw_vel, 1),
                "confidence": round(confidence, 2),
            },
            "cadence_gait": {
                "is_periodic": is_periodic,
                "cadence_freq_hz": round(dominant_freq_hz, 2) if is_periodic else 0.0,
                "predicted_state": predicted_state,
            },
            "visual_quality": {
                "sharpness_laplacian": round(sharpness, 1),
                "occlusion_ratio": round(occlusion_ratio, 3),
                "center_occlusion": round(center_occlusion, 3),
                "dark_ratio": round(dark_ratio, 3),
                "glare_ratio": round(glare_ratio, 3),
                "mean_brightness": round(mean_brightness, 1),
                "contrast_score": round(contrast_score, 1),
                "inferred_lens_status": inferred_lens_status,
                "is_occluded": (occlusion_ratio > self.max_occlusion_ratio) or (inferred_lens_status in ["CLOTH_OCCLUDED", "POCKET_DARK", "GLARE"]),
            },
            "temporal_context": {
                "dwell_duration_sec": round(stable_duration_sec, 2),
                "pre_stability_score": round(pre_stability, 2),
            },
            "sensor_profile": self.profile,
        }

        # -------------------------------------------------------------
        # PROFILE 1: INSPECTION SENSOR MODE (Station-Body Production)
        # -------------------------------------------------------------
        if self.profile == "inspection_sensor":
            # Khi tốc độ di chuyển tăng hoặc trạng thái vận động -> Đánh dấu là đã di chuyển
            if speed >= 2.0 or predicted_state in ["moving", "periodic_motion", "high_motion"]:
                self.was_moving = True

            # Khi người đeo dừng lại liên tục đạt ngưỡng thời gian quan sát
            if self.was_moving and stable_duration_sec >= self.min_stable_duration_sec:
                # BỘ LỌC CHẤT LƯỢNG MÔ HÌNH TOÁN (Math Quality Gates):
                # 1. Không bị rung giật tức thời (speed < spike_speed)
                # 2. Không bị che khuất ống kính (occlusion_ratio <= max_occlusion và không bị che/tối/chói)
                # 3. Không bị xoay đầu giật nhanh (angular_yaw_vel <= max_angular_yaw)
                # 4. Đạt độ nét tối thiểu (sharpness >= min_sharpness)
                is_stable_pass = speed < self.spike_speed_threshold
                is_occlusion_pass = (occlusion_ratio <= self.max_occlusion_ratio) and (center_occlusion < 0.60) and (inferred_lens_status not in ["CLOTH_OCCLUDED", "POCKET_DARK", "GLARE"])
                is_yaw_pass = angular_yaw_vel <= self.max_angular_yaw_vel
                is_sharpness_pass = sharpness >= self.min_sharpness and confidence >= 0.35

                if is_stable_pass and is_occlusion_pass and is_yaw_pass and is_sharpness_pass:
                    if not is_cooldown_active("STABLE_INSPECTION_MOMENT"):
                        triggers.append(
                            TriggerEventData(
                                trigger_type="STABLE_INSPECTION_MOMENT",
                                reason=f"Công nhân/kỹ sư dừng lại quan sát hiện trường ({stable_duration_sec:.1f}s). Khung hình đạt độ nét cực đại ({sharpness:.1f}), không bị che ống kính ({occlusion_ratio*100:.0f}%).",
                                timestamp_ms=now_ms,
                                frame_idx=frame_idx,
                                sharpness=sharpness,
                                context_state=predicted_state,
                                details=rich_metadata,
                            )
                        )
                        self.last_trigger_time["STABLE_INSPECTION_MOMENT"] = timestamp_sec
                        self.was_moving = False

            self.prev_state = predicted_state
            return triggers

        # -------------------------------------------------------------
        # PROFILE 2: RESEARCH LAB MODE (Full Raw Telemetry Exploration)
        # -------------------------------------------------------------
        # 1. TRIGGER: STABLE_AFTER_MOTION
        if self.was_moving and stable_duration_sec >= self.min_stable_duration_sec:
            if sharpness >= self.min_sharpness and confidence >= 0.4:
                if not is_cooldown_active("STABLE_AFTER_MOTION"):
                    triggers.append(
                        TriggerEventData(
                            trigger_type="STABLE_AFTER_MOTION",
                            reason=f"Camera stabilized for {stable_duration_sec:.1f}s after moving. Frame is sharp ({sharpness:.1f}).",
                            timestamp_ms=now_ms,
                            frame_idx=frame_idx,
                            sharpness=sharpness,
                            context_state=predicted_state,
                            details=rich_metadata,
                        )
                    )
                    self.last_trigger_time["STABLE_AFTER_MOTION"] = timestamp_sec
                    self.was_moving = False

        if predicted_state in ["moving", "periodic_motion", "high_motion"]:
            self.was_moving = True

        # 2. TRIGGER: PERIODICITY_DETECTED (Walking gait rhythm detected)
        if is_periodic and dominant_freq_hz > 0.0:
            if not is_cooldown_active("PERIODICITY_DETECTED"):
                triggers.append(
                    TriggerEventData(
                        trigger_type="PERIODICITY_DETECTED",
                        reason=f"Walking/Vehicle cadence detected at {dominant_freq_hz:.2f} Hz rhythm.",
                        timestamp_ms=now_ms,
                        frame_idx=frame_idx,
                        sharpness=sharpness,
                        context_state=predicted_state,
                        details=rich_metadata,
                    )
                )
                self.last_trigger_time["PERIODICITY_DETECTED"] = timestamp_sec

        # 3. TRIGGER: MOTION_SPIKE (Sudden high acceleration / shock)
        if speed >= self.spike_speed_threshold:
            if not is_cooldown_active("MOTION_SPIKE"):
                triggers.append(
                    TriggerEventData(
                        trigger_type="MOTION_SPIKE",
                        reason=f"Sudden motion spike detected ({speed:.1f} px/frame).",
                        timestamp_ms=now_ms,
                        frame_idx=frame_idx,
                        sharpness=sharpness,
                        context_state=predicted_state,
                        details=rich_metadata,
                    )
                )
                self.last_trigger_time["MOTION_SPIKE"] = timestamp_sec

        self.prev_state = predicted_state
        return triggers
