# 🎯 CBD Motion Lab (Body Camera Vision Sensor Engine)

> **Động cơ Thị Giác Đo Đạc Toán Học Siêu Nhẹ (< 2ms trên CPU) & Phòng Lab Giám Định Chất Lượng Cho 200 Camera Body Dahua**

[![Python 3.12](https://img.shields.io/badge/Python-3.12-blue.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.110+-009688.svg)](https://fastapi.tiangolo.com/)
[![OpenCV](https://img.shields.io/badge/OpenCV-4.9+-5C3EE8.svg)](https://opencv.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791.svg)](https://www.postgresql.org/)
[![MinIO](https://img.shields.io/badge/MinIO-S3_Storage-C72C48.svg)](https://min.io/)
[![Hardware Acceleration](https://img.shields.io/badge/NVIDIA-NVENC_H264-76B900.svg)](https://developer.nvidia.com/nvidia-video-codec-sdk)

---

## 📌 1. Giới Thiệu & Mục Tiêu Cốt Lõi

**CBD Motion Lab** là hệ thống cảm biến chuyển động thông minh (Motion Vision Sensor Engine) hoạt động độc lập trên luồng video gốc (H.265 / HEVC). Thay vì phải triển khai các mô hình AI nhận diện cồng kềnh ngốn tài nguyên, CBD Motion Lab áp dụng **mô hình thị giác toán học cổ điển (Classical CV Math)** để:

1. **Thay thế cảm biến chuyển động vật lý:** Phân tích trực tiếp từ góc nhìn camera của kỹ sư/công nhân đeo trước ngực.
2. **Bắt trọn khoảnh khắc vàng (`STABLE_INSPECTION_MOMENT`):** Tự động phát hiện chính xác thời điểm người đeo dừng chân quan sát hiện trường ($\ge 0.8s - 1.5s$), ức chế hoàn toàn khi đang sải bước chân hoặc văng giật quang học.
3. **Đóng gói Gói Siêu Dữ Liệu Định Lượng (Rich Metadata Contract):** Cung cấp 4 nhóm thông số vật lý (chuyển động không gian, nhịp bước chân, chất lượng quang học & che khuất, ngữ cảnh thời gian) cho các hệ thống phía sau (`station-body`, Rule Engine, VLM/LLM).
4. **VLM Ground-Truth Validation:** Sử dụng Gemini 3.7 Vision như một **Giám định viên độc lập trong Lab** để đánh giá độ chính xác của mô hình toán và đề xuất ngưỡng tinh chỉnh tối ưu.

---

## 🏗️ 2. Kiến Trúc Hệ Thống (Architecture)

```
       [200 Camera Body Dahua (H.265 / HEVC)]
                         │
        ┌────────────────┴────────────────┐
        ▼                                 ▼
   [Live RTSP Stream]             [Upload Video File]
  (Substream 640x480)           (Master File 1080p H265)
        │                                 │
        ▼                                 ▼
┌─────────────────────────────────────────────────────────────┐
│             CBD MATH VISION SENSOR ENGINE (< 2ms)            │
│  • Shi-Tomasi + Pyramidal Lucas-Kanade Optical Flow         │
│  • RANSAC Inlier Filtering (dx, dy, rotation, angular yaw)  │
│  • FFT Cadence Spectrum (Nhịp bước 0.8Hz - 3.5Hz)           │
│  • 4x4 Grid Occlusion & Laplacian Sharpness Metric          │
└──────────────────────────────┬──────────────────────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
 [Rich Metadata Payload]               [Web Preview Proxy]
 • spatial_motion (yaw, dx, dy)       • NVENC H.264 Fast Transcode
 • cadence_gait (freq, state)         • Browser <video> Playback
 • visual_quality (sharpness, occl)
 • temporal_context (dwell, pre_stab)
            │
            ├─────────────────────────────────────┐
            ▼                                     ▼
 [PostgreSQL 16 & MinIO S3]             [Downstream Integration]
 • 30 FPS Telemetry Waveforms          • Station-Body Edge Engine
 • Trigger Evidence Frames             • Rule Engine / Telegram Alerts
                                       • VLM (Gemini 3.7) Quality Audit
```

---

## 📐 3. Hợp Đồng Siêu Dữ Liệu Trigger (Rich Metadata Contract)

Mỗi trigger được phát hiện sẽ đính kèm gói siêu dữ liệu JSON chuẩn hóa:

```json
{
  "trigger_type": "STABLE_INSPECTION_MOMENT",
  "timestamp_ms": 1400.28,
  "frame_idx": 42,
  "sharpness_score": 675.8,
  "evidence_minio_url": "https://minio.nvlit.asia/cbd-motion-lab/evidence/case_xxx/ev_42.jpg",
  "rich_metadata": {
    "spatial_motion": {
      "speed_px_frame": 0.42,
      "dx": -0.15,
      "dy": 0.22,
      "rotation_deg": 0.05,
      "angular_yaw_vel_px_s": 12.4,
      "confidence": 0.96
    },
    "cadence_gait": {
      "is_periodic": false,
      "cadence_freq_hz": 0.0,
      "predicted_state": "stable"
    },
    "visual_quality": {
      "sharpness_laplacian": 675.8,
      "occlusion_ratio": 0.0,
      "is_occluded": false,
      "mean_brightness": 134.2,
      "contrast_score": 62.1
    },
    "temporal_context": {
      "dwell_duration_sec": 1.4,
      "pre_stability_score": 0.98
    },
    "sensor_profile": "inspection_sensor"
  }
}
```

---

## ⚙️ 4. Chế Độ Cảm Biến & Tham Số Toán Học (Sensor Profiles)

* **🎯 `inspection_sensor` (Production Standard):**
  - Thời gian đứng yên tối thiểu (`window_sec`): $0.8s - 1.5s$
  - Ngưỡng vận tốc tĩnh (`stable_speed_threshold`): $\le 1.2\text{ px/frame}$
  - Ngưỡng độ nét Laplacian (`min_sharpness`): $\ge 150.0$
  - Ngưỡng che ống kính tối đa (`max_occlusion_ratio`): $\le 30\%$ (lọc cánh tay áo/vật cản)
  - Ngưỡng vận tốc góc quay đầu (`max_angular_yaw_vel`): $\le 180.0\text{ px/s}$
  - Thời gian nghỉ chống chụp lặp (`cooldown_sec`): $15.0s$
* **🔬 `research_lab` (Raw Exploration):**
  - Mở toàn bộ dải sóng đo lường để nghiên cứu các xung đột biến (`MOTION_SPIKE`, `PERIODICITY_DETECTED`).

---

## 🚀 5. Hướng Dẫn Cài Đặt & Vận Hành (Quickstart)

### Yêu cầu môi trường
* Ubuntu 22.04+ / Linux x86_64
* Python 3.12+ (với OpenCV, FastAPI, SQLAlchemy, Uvicorn)
* Docker & Docker Compose (PostgreSQL 16, MinIO)
* NVIDIA GPU với hỗ trợ NVENC (tùy chọn để tăng tốc H.264 preview)

### Khởi chạy dịch vụ
```bash
# 1. Khởi động CSDL PostgreSQL & MinIO
docker compose up -d

# 2. Cài đặt thư viện Python
pip install fastapi uvicorn opencv-python-headless numpy sqlalchemy psycopg2-binary minio websockets python-multipart requests starlette

# 3. Chạy backend qua Systemd Service
sudo systemctl daemon-reload
sudo systemctl enable --now cbd-motion
```

---

## 🔒 6. Bảo Mật & Xác Thực

* **Tài khoản mặc định:** `admin` / `admin@123`
* **Cơ chế Cookie:** Sau khi đăng nhập HTTP Basic Auth lần đầu, hệ thống tự động gán Cookie phiên làm việc 30 ngày (`cbd_auth_token`), giúp người dùng không phải nhập lại mật khẩu trong các lần truy cập tiếp theo.

---

## 🌐 7. Truy Cập Trực Tuyến

* **Địa chỉ dịch vụ:** [https://cbd.nvlit.asia](https://cbd.nvlit.asia)
* **Replay Studio & Soi Sóng:** `https://cbd.nvlit.asia/#/cases/{case_id}/studio`
* **Cài Đặt Bộ Lọc Toán Học:** `https://cbd.nvlit.asia/#/cases/{case_id}/tuning`
* **VLM Giám Định Chất Lượng:** `https://cbd.nvlit.asia/#/vlm-eval`
* **Xuất Đặc Tả Sensor JSON:** API `GET /api/cases/{case_id}/export-spec`
