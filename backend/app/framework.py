"""Filesystem plugins. Only trusted, administrator-installed Python is loaded."""
from abc import ABC, abstractmethod
from pathlib import Path
import importlib.util
import math
import time
import yaml

ROOT = Path(__file__).resolve().parents[1]
GROUPS = ('sensor-core', 'behavior-trigger')


class Sensor(ABC):
    @abstractmethod
    def measure(self, frame, timestamp_sec, return_points=False):
        """Return MotionMetrics: image-space measurements, not behavior labels."""


class Behavior(ABC):
    @abstractmethod
    def analyze(self, measurement, timestamp_sec, frame_idx):
        """Return (CadenceMetrics, list[TriggerEventData])."""


def discover():
    catalog = {group: [] for group in GROUPS}
    errors = []
    for group in GROUPS:
        for path in sorted((ROOT / group).glob('*/config.yaml')):
            try:
                data = yaml.safe_load(path.read_text())
                if data['id'] != path.parent.name or data['contract_version'] != 1:
                    raise ValueError('Invalid id or contract version')
                if not (path.parent / 'algorithm.py').is_file():
                    raise ValueError('Missing algorithm.py')
                validate(data, {})
                catalog[group].append(data)
            except Exception as exc:
                errors.append({'plugin': f'{group}/{path.parent.name}', 'error': str(exc)})
    return {**catalog, 'errors': errors}


def validate(manifest, supplied):
    schema = manifest['parameters']
    if not isinstance(supplied, dict) or set(supplied) - set(schema):
        raise ValueError('Unknown parameters')
    values = {}
    for key, spec in schema.items():
        value = supplied.get(key, spec['default'])
        kind = spec['type']
        if kind in ('integer', 'float'):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f'{key}: expected finite number')
            if kind == 'integer' and int(value) != value:
                raise ValueError(f'{key}: expected integer')
            if not spec['min'] <= value <= spec['max']:
                raise ValueError(f'{key}: outside allowed range')
        elif kind == 'enum':
            if value not in spec['options']:
                raise ValueError(f'{key}: invalid option')
        elif kind == 'boolean':
            if not isinstance(value, bool):
                raise ValueError(f'{key}: expected boolean')
        else:
            raise ValueError(f'Unsupported parameter type: {kind}')
        values[key] = value
    return values


def normalize(config=None):
    config = config or {}
    catalog = discover()
    result = {}
    for group, default in [('sensor-core', 'lk-sparse-ransac'), ('behavior-trigger', 'fft-inspection')]:
        selection = config.get(group, {})
        plugin_id = selection.get('id', default)
        manifest = next((x for x in catalog[group] if x['id'] == plugin_id), None)
        if manifest is None:
            raise ValueError(f'Unknown {group}: {plugin_id}')
        # Existing cases used a flat configuration; preserve their saved thresholds.
        params = selection.get('params', {k: v for k, v in config.items() if k in manifest['parameters']})
        if group == 'behavior-trigger' and not selection and 'window_sec' in config:
            params.setdefault('min_stable_duration_sec', config['window_sec'])
        result[group] = {'id': plugin_id, 'version': manifest['version'], 'params': validate(manifest, params)}
    return result


def load(group, selection, fps):
    path = ROOT / group / selection['id'] / 'algorithm.py'
    spec = importlib.util.spec_from_file_location(f"cbd_{group}_{selection['id']}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    instance = module.Plugin(selection['params'], fps)
    expected = Sensor if group == 'sensor-core' else Behavior
    if not isinstance(instance, expected):
        raise ValueError(f'{group}: incompatible plugin interface')
    return instance


class Pipeline:
    def __init__(self, config=None, fps=30):
        self.config = normalize(config)
        self.sensor = load('sensor-core', self.config['sensor-core'], fps)
        self.behavior = load('behavior-trigger', self.config['behavior-trigger'], fps)
        self.sensor_ms = self.behavior_ms = 0.0
        self.count = 0

    def process(self, frame, timestamp_sec, frame_idx, return_points=False):
        start = time.perf_counter()
        m = self.sensor.measure(frame, timestamp_sec, return_points)
        middle = time.perf_counter()
        c, events = self.behavior.analyze(m, timestamp_sec, frame_idx)
        self.sensor_ms += (middle - start) * 1000
        self.behavior_ms += (time.perf_counter() - middle) * 1000
        self.count += 1
        for event in events:
            event.details['pipeline'] = self.config
        return m, c, events

    def stats(self):
        return {'sensor_ms_per_frame': round(self.sensor_ms / max(1, self.count), 3),
                'behavior_ms_per_frame': round(self.behavior_ms / max(1, self.count), 3)}
