"""Cadence Analyzer and Time-Window Statistics.

Performs:
1. Ring buffer management for time-window metrics.
2. Fast Fourier Transform (FFT) analysis to extract human gait / vehicle oscillation frequencies.
3. State inference: 'stable', 'moving', 'periodic_motion', 'high_motion', 'unknown'.
"""

from collections import deque
from typing import Dict, List, Optional
import numpy as np
from scipy.signal import find_peaks


class CadenceMetrics:
    def __init__(
        self,
        mean_speed: float = 0.0,
        std_speed: float = 0.0,
        peak_speed: float = 0.0,
        is_periodic: bool = False,
        dominant_freq_hz: float = 0.0,
        periodicity_score: float = 0.0,
        stable_duration_sec: float = 0.0,
        predicted_state: str = "unknown",
        angular_yaw_velocity: float = 0.0,
        pre_stability_score: float = 1.0,
    ):
        self.mean_speed = float(mean_speed)
        self.std_speed = float(std_speed)
        self.peak_speed = float(peak_speed)
        self.is_periodic = bool(is_periodic)
        self.dominant_freq_hz = float(dominant_freq_hz)
        self.periodicity_score = float(periodicity_score)
        self.stable_duration_sec = float(stable_duration_sec)
        self.predicted_state = str(predicted_state)
        self.angular_yaw_velocity = float(angular_yaw_velocity)
        self.pre_stability_score = float(pre_stability_score)

    def to_dict(self) -> Dict:
        return {
            "mean_speed": round(self.mean_speed, 3),
            "std_speed": round(self.std_speed, 3),
            "peak_speed": round(self.peak_speed, 3),
            "is_periodic": self.is_periodic,
            "dominant_freq_hz": round(self.dominant_freq_hz, 2),
            "periodicity_score": round(self.periodicity_score, 2),
            "stable_duration_sec": round(self.stable_duration_sec, 2),
            "predicted_state": self.predicted_state,
            "angular_yaw_velocity": round(self.angular_yaw_velocity, 2),
            "pre_stability_score": round(self.pre_stability_score, 2),
        }


class CadenceAnalyzer:
    def __init__(
        self,
        fps: float = 30.0,
        window_sec: float = 2.0,
        stable_speed_threshold: float = 1.2,
        high_motion_speed_threshold: float = 8.0,
        min_gait_freq_hz: float = 0.8,
        max_gait_freq_hz: float = 3.5,
    ):
        self.fps = fps
        self.window_sec = window_sec
        self.window_size = max(15, int(fps * window_sec))
        self.stable_speed_threshold = stable_speed_threshold
        self.high_motion_speed_threshold = high_motion_speed_threshold
        self.min_gait_freq_hz = min_gait_freq_hz
        self.max_gait_freq_hz = max_gait_freq_hz

        self.speed_buffer = deque(maxlen=self.window_size)
        self.dy_buffer = deque(maxlen=self.window_size)  # Vertical shift (bouncing)
        self.dx_buffer = deque(maxlen=self.window_size)  # Horizontal shift (pan/yaw)
        self.ts_buffer = deque(maxlen=self.window_size)
        self.stable_start_time: Optional[float] = None

    def reset(self):
        self.speed_buffer.clear()
        self.dy_buffer.clear()
        self.dx_buffer.clear()
        self.ts_buffer.clear()
        self.stable_start_time = None

    def update(
        self,
        timestamp_sec: float,
        speed: float,
        dy: float,
        dx: float,
        confidence: float,
    ) -> CadenceMetrics:
        self.speed_buffer.append(speed)
        self.dy_buffer.append(dy)
        self.dx_buffer.append(dx)
        self.ts_buffer.append(timestamp_sec)

        # Calculate angular yaw / sudden head pan velocity over recent frames
        angular_yaw_vel = float(abs(dx) * self.fps)  # px/second horizontal pan speed

        # Track continuous stable duration
        if speed <= self.stable_speed_threshold and confidence >= 0.3:
            if self.stable_start_time is None:
                self.stable_start_time = timestamp_sec
            stable_duration = timestamp_sec - self.stable_start_time
        else:
            self.stable_start_time = None
            stable_duration = 0.0

        n_samples = len(self.speed_buffer)
        if n_samples < 10:
            return CadenceMetrics(
                mean_speed=speed,
                stable_duration_sec=stable_duration,
                predicted_state="stable" if speed <= self.stable_speed_threshold else "moving",
                angular_yaw_velocity=angular_yaw_vel,
                pre_stability_score=1.0,
            )

        speeds = np.array(self.speed_buffer, dtype=np.float32)
        mean_speed = float(np.mean(speeds))
        std_speed = float(np.std(speeds))
        peak_speed = float(np.max(speeds))

        # FFT Analysis on vertical displacement dy (sensitive to human walking bounce)
        is_periodic = False
        dominant_freq = 0.0
        periodicity_score = 0.0

        if n_samples >= int(self.fps * 1.0):  # At least 1.0s of data
            dys = np.array(self.dy_buffer, dtype=np.float32)
            # Remove DC bias
            dys_centered = dys - np.mean(dys)

            # Apply Hanning window
            window = np.hanning(len(dys_centered))
            dys_win = dys_centered * window

            fft_vals = np.abs(np.fft.rfft(dys_win))
            freqs = np.fft.rfftfreq(len(dys_win), d=1.0 / self.fps)

            # Filter valid gait frequency range (0.8 Hz to 3.5 Hz)
            valid_mask = (freqs >= self.min_gait_freq_hz) & (freqs <= self.max_gait_freq_hz)
            if np.any(valid_mask):
                valid_fft = fft_vals[valid_mask]
                valid_freqs = freqs[valid_mask]

                if len(valid_fft) > 0:
                    max_idx = np.argmax(valid_fft)
                    peak_power = valid_fft[max_idx]
                    total_power = np.sum(valid_fft) + 1e-6
                    dominant_freq = float(valid_freqs[max_idx])

                    # Ratio of dominant peak to total energy in band
                    periodicity_score = float(peak_power / total_power)
                    if periodicity_score > 0.35 and mean_speed > self.stable_speed_threshold:
                        is_periodic = True

        # State classification
        if confidence < 0.2:
            state = "unknown"
        elif mean_speed <= self.stable_speed_threshold and peak_speed < (self.stable_speed_threshold * 1.8):
            state = "stable"
        elif is_periodic:
            state = "periodic_motion"
        elif mean_speed >= self.high_motion_speed_threshold or peak_speed > (self.high_motion_speed_threshold * 1.5):
            state = "high_motion"
        else:
            state = "moving"

        # Pre-stability score: How calm was the movement leading up to this point (std dev of speed in window)
        pre_stability = float(np.clip(1.0 - (std_speed / (self.stable_speed_threshold * 3.0 + 1e-4)), 0.0, 1.0))

        return CadenceMetrics(
            mean_speed=mean_speed,
            std_speed=std_speed,
            peak_speed=peak_speed,
            is_periodic=is_periodic,
            dominant_freq_hz=dominant_freq,
            periodicity_score=periodicity_score,
            stable_duration_sec=stable_duration,
            predicted_state=state,
            angular_yaw_velocity=angular_yaw_vel,
            pre_stability_score=pre_stability,
        )
