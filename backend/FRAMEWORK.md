# Two-block algorithm framework

`sensor-core/<id>/` measures images. `behavior-trigger/<id>/` reads measurements
and emits state and trigger events. Each installed folder contains `config.yaml`
and `algorithm.py` exporting `Plugin(params, fps)`. Python plugins are trusted
server code, not user uploads.

Implement `Sensor.measure` or `Behavior.analyze` from `app/framework.py`.
Contract v1 uses MotionMetrics (pixel/frame displacement, degrees of in-plane
rotation, sharpness, brightness, texture, tracking confidence) plus
`pan_speed_px_s`. Behavior returns CadenceMetrics and TriggerEventData objects.
Measurements are not calibrated IMU readings. Low texture is an occlusion
heuristic; periodic motion alone does not prove walking or falling.

YAML declares id (matching directory name), name, version, contract_version: 1,
description and parameters. Supported types: integer, float, enum, boolean.
Numeric parameters require min/max/default and can specify step and unit.
The API validates values independently of the generated form. Discovery scans
installed manifests at request time; refreshing the page discovers new plugins.
Each pipeline creates isolated stateful instances. Match units/semantics when
replacing algorithms; contract version 1 alone does not calibrate thresholds.

GET /api/framework/plugins returns manifests and discovery errors.
POST /api/cases/{id}/run-pipeline accepts:

```json
{"config_params": {
  "sensor-core": {"id": "lk-sparse-ransac", "params": {"max_corners": 150}},
  "behavior-trigger": {"id": "fft-inspection", "params": {"window_sec": 0.8}}
}}
```

Unspecified parameters use YAML defaults. The effective config and versions are
saved on the case and events; a rerun replaces prior results (not run history).
H265 master remains the computation source. Existing flat case configs are
adapted. RTSP preview and recording use the same pipeline with defaults; the
video workbench exposes selection. Framework dependency: PyYAML.

Per-block timings exclude decoding, storage and preview encoding and do not
establish concurrent-stream capacity. Load testing is required for that claim.
