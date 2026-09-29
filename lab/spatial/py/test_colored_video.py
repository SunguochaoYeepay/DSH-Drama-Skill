"""Offline regression checks for identity hue masks."""
import importlib.util
from pathlib import Path
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location('colored_video', Path(__file__).with_name('measure-colored-video.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ColorMaskTests(unittest.TestCase):
    def test_red_wraps_at_zero_without_accepting_blue(self):
        hsv = np.array([[[0, 255, 255], [179, 255, 255], [110, 255, 255]]], dtype=np.uint8)
        self.assertEqual(module.color_mask(hsv, [1, 0, 0]).tolist(), [[255, 255, 0]])

    def test_neutral_background_is_rejected(self):
        hsv = np.array([[[110, 0, 255], [110, 255, 10]]], dtype=np.uint8)
        self.assertEqual(module.color_mask(hsv, [0, 0, 1]).tolist(), [[0, 0]])

    def test_normalized_and_byte_rgb_match(self):
        np.testing.assert_array_equal(module.rgb_to_hsv([1, 0, 0]), module.rgb_to_hsv([255, 0, 0]))


if __name__ == '__main__':
    unittest.main()
