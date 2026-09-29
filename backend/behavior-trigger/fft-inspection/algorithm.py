from backend.app.framework import Behavior
from backend.app.core.cadence_analyzer import CadenceAnalyzer
from backend.app.core.trigger_rules import TriggerEngine


class Plugin(Behavior):
    def __init__(self, params, fps):
        params = dict(params)
        self.cadence = CadenceAnalyzer(fps=fps, window_sec=params.pop('window_sec'),
                                       stable_speed_threshold=params.pop('stable_speed_threshold'))
        self.triggers = TriggerEngine(**params)

    def analyze(self, m, timestamp_sec, frame_idx):
        c = self.cadence.update(timestamp_sec, m.speed, m.dy, m.dx, m.confidence)
        c.angular_yaw_velocity = m.pan_speed_px_s
        events = self.triggers.evaluate(
            frame_idx=frame_idx, timestamp_sec=timestamp_sec, speed=m.speed,
            sharpness=m.sharpness, confidence=m.confidence,
            stable_duration_sec=c.stable_duration_sec, is_periodic=c.is_periodic,
            dominant_freq_hz=c.dominant_freq_hz, predicted_state=c.predicted_state,
            occlusion_ratio=m.occlusion_ratio,
            center_occlusion=m.center_occlusion,
            lens_status=m.lens_status,
            dark_ratio=m.dark_ratio,
            glare_ratio=m.glare_ratio,
            mean_brightness=m.mean_brightness,
            contrast_score=m.contrast_score, angular_yaw_vel=m.pan_speed_px_s,
            pre_stability=c.pre_stability_score, dx=m.dx, dy=m.dy, rotation_deg=m.rotation_deg)
        return c, events
