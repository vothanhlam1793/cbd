"""Spatial & Motion Estimation Core using Classical Computer Vision.

Techniques:
1. Shi-Tomasi Corner Detection (Good Features to Track)
2. Pyramidal Lucas-Kanade Sparse Optical Flow
3. Forward-Backward Error Validation
4. RANSAC Partial Affine / Euclidean Filtering for Background Motion
5. Variance of Laplacian for Sharpness Assessment
"""

import math
from typing import Dict, List, Optional, Tuple
import cv2
import numpy as np


class MotionMetrics:
    def __init__(
        self,
        dx: float = 0.0,
        dy: float = 0.0,
        speed: float = 0.0,
        direction_deg: float = 0.0,
        rotation_deg: float = 0.0,
        sharpness: float = 0.0,
        confidence: float = 1.0,
        tracked_points_count: int = 0,
        inliers_count: int = 0,
        occlusion_ratio: float = 0.0,
        mean_brightness: float = 128.0,
        contrast_score: float = 50.0,
        inlier_points_prev: Optional[List[Tuple[float, float]]] = None,
        inlier_points_curr: Optional[List[Tuple[float, float]]] = None,
        outlier_points_curr: Optional[List[Tuple[float, float]]] = None,
    ):
        self.dx = float(dx)
        self.dy = float(dy)
        self.speed = float(speed)
        self.direction_deg = float(direction_deg)
        self.rotation_deg = float(rotation_deg)
        self.sharpness = float(sharpness)
        self.confidence = float(confidence)
        self.tracked_points_count = int(tracked_points_count)
        self.inliers_count = int(inliers_count)
        self.occlusion_ratio = float(occlusion_ratio)
        self.mean_brightness = float(mean_brightness)
        self.contrast_score = float(contrast_score)
        self.inlier_points_prev = inlier_points_prev or []
        self.inlier_points_curr = inlier_points_curr or []
        self.outlier_points_curr = outlier_points_curr or []

    def to_dict(self) -> Dict:
        return {
            "dx": round(self.dx, 3),
            "dy": round(self.dy, 3),
            "speed": round(self.speed, 3),
            "direction_deg": round(self.direction_deg, 1),
            "rotation_deg": round(self.rotation_deg, 2),
            "sharpness": round(self.sharpness, 2),
            "confidence": round(self.confidence, 2),
            "tracked_points_count": self.tracked_points_count,
            "inliers_count": self.inliers_count,
            "occlusion_ratio": round(self.occlusion_ratio, 3),
            "mean_brightness": round(self.mean_brightness, 1),
            "contrast_score": round(self.contrast_score, 1),
        }


class MotionEngine:
    def __init__(
        self,
        max_corners: int = 200,
        quality_level: float = 0.02,
        min_distance: int = 15,
        ransac_thresh: float = 3.0,
        min_inlier_ratio: float = 0.35,
        target_process_width: int = 640,
    ):
        self.max_corners = max_corners
        self.quality_level = quality_level
        self.min_distance = min_distance
        self.ransac_thresh = ransac_thresh
        self.min_inlier_ratio = min_inlier_ratio
        self.target_process_width = target_process_width

        # LK Optical Flow params
        self.lk_params = dict(
            winSize=(21, 21),
            maxLevel=3,
            criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01),
            flags=0,
            minEigThreshold=1e-4,
        )

        self.prev_gray: Optional[np.ndarray] = None
        self.prev_pts: Optional[np.ndarray] = None

    def reset(self):
        self.prev_gray = None
        self.prev_pts = None

    def calculate_sharpness(self, gray_frame: np.ndarray) -> float:
        """Measure focus and blur using Variance of Laplacian."""
        laplacian = cv2.Laplacian(gray_frame, cv2.CV_64F)
        variance = laplacian.var()
        return float(variance)

    def calculate_occlusion_and_lighting(self, gray_frame: np.ndarray) -> Tuple[float, float, float]:
        """Measure occlusion (e.g. cloth/arm covering lens) and scene lighting.
        
        Divides the frame into 4x4 grid cells (16 cells) and checks how many cells
        have near-zero texture/variance (flat uniform color like dark fabric or blurry cloth).
        """
        h, w = gray_frame.shape
        mean_brightness = float(np.mean(gray_frame))
        contrast_score = float(np.std(gray_frame))

        # Check grid cells
        rows, cols = 4, 4
        cell_h, cell_w = h // rows, w // cols
        flat_cells = 0
        total_cells = rows * cols

        for r in range(rows):
            for c in range(cols):
                patch = gray_frame[r * cell_h:(r + 1) * cell_h, c * cell_w:(c + 1) * cell_w]
                patch_std = np.std(patch)
                # If a cell is extremely flat (clothing / blocked lens), patch_std is very low
                if patch_std < 8.0:
                    flat_cells += 1

        occlusion_ratio = float(flat_cells / total_cells)
        return occlusion_ratio, mean_brightness, contrast_score

    def extract_features(self, gray_frame: np.ndarray) -> np.ndarray:
        """Find Shi-Tomasi corners."""
        pts = cv2.goodFeaturesToTrack(
            gray_frame,
            maxCorners=self.max_corners,
            qualityLevel=self.quality_level,
            minDistance=self.min_distance,
            blockSize=7,
        )
        return pts

    def process_frame(
        self,
        frame: np.ndarray,
        return_points: bool = True,
    ) -> MotionMetrics:
        """Process a single frame against previous frame to extract motion."""
        h, w = frame.shape[:2]
        
        # Scale for processing if needed to keep CPU load low
        scale = 1.0
        if w > self.target_process_width:
            scale = self.target_process_width / float(w)
            target_h = int(h * scale)
            proc_frame = cv2.resize(frame, (self.target_process_width, target_h), interpolation=cv2.INTER_AREA)
        else:
            proc_frame = frame

        if len(proc_frame.shape) == 3:
            gray = cv2.cvtColor(proc_frame, cv2.COLOR_BGR2GRAY)
        else:
            gray = proc_frame

        sharpness = self.calculate_sharpness(gray)
        occlusion_ratio, mean_brightness, contrast_score = self.calculate_occlusion_and_lighting(gray)

        # First frame initialization
        if self.prev_gray is None or self.prev_pts is None or len(self.prev_pts) < 15:
            self.prev_pts = self.extract_features(gray)
            self.prev_gray = gray
            return MotionMetrics(
                sharpness=sharpness,
                confidence=1.0 if self.prev_pts is not None and len(self.prev_pts) >= 15 else 0.2,
                tracked_points_count=len(self.prev_pts) if self.prev_pts is not None else 0,
                occlusion_ratio=occlusion_ratio,
                mean_brightness=mean_brightness,
                contrast_score=contrast_score,
            )

        # Forward Optical Flow (t-1 -> t)
        curr_pts, status, err = cv2.calcOpticalFlowPyrLK(
            self.prev_gray, gray, self.prev_pts, None, **self.lk_params
        )

        # Backward Optical Flow (t -> t-1) for Forward-Backward consistency check
        prev_pts_rev, status_rev, _ = cv2.calcOpticalFlowPyrLK(
            gray, self.prev_gray, curr_pts, None, **self.lk_params
        )

        good_prev = []
        good_curr = []

        if curr_pts is not None and prev_pts_rev is not None and status is not None:
            for p_orig, p_curr, p_rev, st, st_rev in zip(
                self.prev_pts, curr_pts, prev_pts_rev, status, status_rev
            ):
                if st == 1 and st_rev == 1:
                    # Check distance between original point and roundtrip point
                    fb_dist = np.linalg.norm(p_orig - p_rev)
                    if fb_dist < 1.5:  # Consistent tracking
                        good_prev.append(p_orig[0])
                        good_curr.append(p_curr[0])

        tracked_count = len(good_prev)
        if tracked_count < 8:
            # Re-seed features if tracking is weak
            self.prev_pts = self.extract_features(gray)
            self.prev_gray = gray
            return MotionMetrics(
                sharpness=sharpness,
                confidence=0.1,
                tracked_points_count=tracked_count,
            )

        good_prev_arr = np.array(good_prev, dtype=np.float32)
        good_curr_arr = np.array(good_curr, dtype=np.float32)

        # Estimate background motion using RANSAC (Partial Affine: translation + rotation + uniform scale)
        try:
            transform_mat, inliers = cv2.estimateAffinePartial2D(
                good_prev_arr,
                good_curr_arr,
                method=cv2.RANSAC,
                ransacReprojThreshold=self.ransac_thresh,
                maxIters=500,
                confidence=0.99,
            )
        except Exception:
            transform_mat, inliers = None, None

        inliers_count = 0
        inlier_prev_list = []
        inlier_curr_list = []
        outlier_curr_list = []

        dx, dy, speed, direction_deg, rotation_deg = 0.0, 0.0, 0.0, 0.0, 0.0
        confidence = 0.0

        if transform_mat is not None and inliers is not None:
            inlier_mask = inliers.ravel() == 1
            inliers_count = int(np.sum(inlier_mask))
            inlier_ratio = inliers_count / float(tracked_count)

            # Decompose partial affine matrix [[a, -b, tx], [b, a, ty]]
            a = transform_mat[0, 0]
            b = transform_mat[1, 0]
            tx = transform_mat[0, 2]
            ty = transform_mat[1, 2]

            # Adjust translation scale back to original video dimensions
            dx = float(tx / scale)
            dy = float(ty / scale)
            speed = math.sqrt(dx * dx + dy * dy)
            direction_deg = (math.degrees(math.atan2(dy, dx)) + 360.0) % 360.0
            rotation_deg = math.degrees(math.atan2(b, a))

            confidence = float(np.clip(inlier_ratio * (min(inliers_count, 80) / 40.0), 0.0, 1.0))

            if return_points:
                for idx, (p0, p1) in enumerate(zip(good_prev, good_curr)):
                    # Scale points back to original frame coordinate
                    orig_p0 = (float(p0[0] / scale), float(p0[1] / scale))
                    orig_p1 = (float(p1[0] / scale), float(p1[1] / scale))
                    if inlier_mask[idx]:
                        inlier_prev_list.append(orig_p0)
                        inlier_curr_list.append(orig_p1)
                    else:
                        outlier_curr_list.append(orig_p1)
        else:
            # Fallback simple median shift if affine fitting fails
            shifts = good_curr_arr - good_prev_arr
            median_shift = np.median(shifts, axis=0)
            dx = float(median_shift[0] / scale)
            dy = float(median_shift[1] / scale)
            speed = math.sqrt(dx * dx + dy * dy)
            direction_deg = (math.degrees(math.atan2(dy, dx)) + 360.0) % 360.0
            confidence = 0.35

        # Re-seed if points dropped below threshold
        if inliers_count < 30 or tracked_count < 40:
            new_pts = self.extract_features(gray)
            if new_pts is not None and len(new_pts) > 0:
                self.prev_pts = new_pts
            else:
                self.prev_pts = good_curr_arr.reshape(-1, 1, 2)
        else:
            # Propagate inlier points
            inlier_pts = good_curr_arr[inliers.ravel() == 1]
            self.prev_pts = inlier_pts.reshape(-1, 1, 2)

        self.prev_gray = gray

        return MotionMetrics(
            dx=dx,
            dy=dy,
            speed=speed,
            direction_deg=direction_deg,
            rotation_deg=rotation_deg,
            sharpness=sharpness,
            confidence=confidence,
            tracked_points_count=tracked_count,
            inliers_count=inliers_count,
            occlusion_ratio=occlusion_ratio,
            mean_brightness=mean_brightness,
            contrast_score=contrast_score,
            inlier_points_prev=inlier_prev_list,
            inlier_points_curr=inlier_curr_list,
            outlier_points_curr=outlier_curr_list,
        )
