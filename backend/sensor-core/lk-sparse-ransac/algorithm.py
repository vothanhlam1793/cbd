from backend.app.framework import Sensor
from backend.app.core.motion_engine import MotionEngine


class Plugin(Sensor):
    def __init__(self, params, fps):
        self.engine = MotionEngine(**params)
        self.previous_time = None

    def measure(self, frame, timestamp_sec, return_points=False):
        m = self.engine.process_frame(frame, return_points=return_points)
        dt = timestamp_sec - self.previous_time if self.previous_time is not None else 0
        m.pan_speed_px_s = abs(m.dx) / dt if dt > 0 else 0.0
        self.previous_time = timestamp_sec
        return m
