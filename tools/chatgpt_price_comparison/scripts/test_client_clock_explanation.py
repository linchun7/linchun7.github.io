"""Run the shipped JavaScript clock explanation contract in GitHub Actions."""
import subprocess
import unittest
from pathlib import Path


class ClientClockExplanationTests(unittest.TestCase):
    def test_shipped_clock_explanations(self):
        script = Path(__file__).with_name('clock-explanation.test.mjs')
        subprocess.run(['node', '--test', str(script)], check=True, timeout=30)


if __name__ == '__main__':
    unittest.main()
