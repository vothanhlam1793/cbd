import unittest
import numpy as np
from backend.app.framework import Pipeline, normalize, discover


class FrameworkTest(unittest.TestCase):
    def test_discovery(self):
        catalog = discover()
        self.assertFalse(catalog['errors'])
        self.assertEqual(catalog['sensor-core'][0]['id'], 'lk-sparse-ransac')

    def test_validation(self):
        for config in [ {'sensor-core': {'id': '../bad'}},
                        {'sensor-core': {'params': {'max_corners': -1}}},
                        {'sensor-core': {'params': {'unknown': 10}}} ]:
            with self.assertRaises(ValueError):
                normalize(config)

    def test_independent_instances(self):
        a, b = Pipeline(), Pipeline()
        self.assertIsNot(a.sensor, b.sensor)
        self.assertIsNot(a.behavior, b.behavior)
        for i in range(30):
            m, c, events = a.process(np.zeros((120,160,3), dtype=np.uint8), i / 30, i)
        self.assertEqual(b.count, 0)
        self.assertEqual(m.occlusion_ratio, 1)
        self.assertFalse(events)  # Flat/occluded frames must not yield inspection keyframes.
        self.assertGreater(a.stats()['sensor_ms_per_frame'], 0)

    def test_legacy_config(self):
        cfg = normalize({'max_corners': 80, 'profile': 'research_lab'})
        self.assertEqual(cfg['sensor-core']['params']['max_corners'], 80)
        self.assertEqual(cfg['behavior-trigger']['params']['profile'], 'research_lab')


if __name__ == '__main__':
    unittest.main()
