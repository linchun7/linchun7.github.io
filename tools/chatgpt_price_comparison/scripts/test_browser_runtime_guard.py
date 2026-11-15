"""Run the CDP exception guard's deterministic Node regression tests."""
import pathlib
import subprocess
import unittest

class RuntimeExceptionGuardTests(unittest.TestCase):
    def test_uncaught_exception_guard(self):
        test_path = pathlib.Path(__file__).with_name("test-runtime-exception-guard.mjs")
        subprocess.run(["node", "--test", str(test_path)], check=True, timeout=15)
