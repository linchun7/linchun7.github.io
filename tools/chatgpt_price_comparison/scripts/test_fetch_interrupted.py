"""Interrupted HTTP bodies must retry whole responses, never accept partial bytes."""
import copy
from http.client import IncompleteRead
import unittest
from unittest.mock import MagicMock, Mock, call, patch
from urllib.error import URLError

import pipeline as p
from test_pipeline import NOW, data_fixture, good_market


def response(payload=b'complete', error=None):
    value = MagicMock()
    value.headers = {}
    value.__enter__.return_value = value
    value.read.return_value = payload
    value.read.side_effect = error
    return value


class InterruptedFetchTests(unittest.TestCase):
    def test_interrupted_body_retries_from_scratch_then_succeeds(self):
        broken = response(error=IncompleteRead(b'partial bytes', 100))
        complete = response(b'complete response')
        opener = Mock()
        opener.open.side_effect = [broken, complete]
        with patch.object(p.urllib.request, 'build_opener', return_value=opener), patch.object(p.time, 'sleep') as sleep:
            self.assertEqual(p.fetch(p.FX_URL), 'complete response')
        self.assertEqual(opener.open.call_count, 2)
        sleep.assert_called_once_with(1)
        for item in (broken, complete):
            item.read.assert_called_once_with(p.LIMIT + 1)
            item.__exit__.assert_called_once()

    def test_three_interrupted_bodies_exhaust_retry_without_returning_partial(self):
        failures = [IncompleteRead(b'valid-looking partial JSON', 50) for _ in range(3)]
        replies = [response(error=error) for error in failures]
        opener = Mock()
        opener.open.side_effect = replies
        with patch.object(p.urllib.request, 'build_opener', return_value=opener), patch.object(p.time, 'sleep') as sleep:
            with self.assertRaises(URLError) as raised:
                p.fetch(p.FX_URL)
        self.assertIs(raised.exception.__cause__, failures[-1])
        self.assertEqual(opener.open.call_count, 3)
        self.assertEqual(sleep.call_args_list, [call(1), call(3)])
        for item in replies:
            item.__exit__.assert_called_once()

    def test_deadline_stops_interrupted_retry_before_another_request(self):
        opener = Mock()
        opener.open.return_value = response(error=IncompleteRead(b'prefix', 10))
        with patch.object(p.urllib.request, 'build_opener', return_value=opener), patch.object(p.time, 'sleep'), patch.object(p.time, 'monotonic', side_effect=[0, 0, 10]):
            with self.assertRaisesRegex(TimeoutError, 'network run budget exhausted'):
                p.fetch(p.FX_URL, deadline=10)
        self.assertEqual(opener.open.call_count, 1)

    def test_exhausted_market_read_retains_price_evidence(self):
        old = good_market()
        before = copy.deepcopy(old)
        opener = Mock()
        opener.open.side_effect = [response(error=IncompleteRead(b'partial', 10)) for _ in range(3)]
        with patch.object(p.urllib.request, 'build_opener', return_value=opener), patch.object(p.time, 'sleep'):
            result = p.observe({'code': 'us', 'name': '美国'}, old, NOW + 60, getter=p.fetch)
        self.assertEqual(result['status'], 'retained')
        self.assertEqual(result['error'], 'source_unverified')
        for key in ('offers', 'fingerprint', 'source_sha256', 'last_verified_at'):
            self.assertEqual(result[key], before[key])
        self.assertEqual(result['last_checked_at'], p.stamp(NOW + 60))
        self.assertEqual(old, before)
        self.assertEqual(opener.open.call_count, 3)

    def test_exhausted_fx_read_preserves_old_rates_and_timestamp(self):
        old = data_fixture()['fx']
        before = copy.deepcopy(old)
        opener = Mock()
        opener.open.side_effect = [response(error=IncompleteRead(b'{"result":"success"', 10)) for _ in range(3)]
        with patch.object(p.urllib.request, 'build_opener', return_value=opener), patch.object(p.time, 'sleep'):
            result = p.collect_fx(NOW + 60, old, getter=p.fetch, required_currencies=('JPY',))
        self.assertEqual(result, dict(before, fallback=True))
        self.assertEqual(old, before)
        self.assertEqual(opener.open.call_count, 3)

    def test_size_age_and_utf8_validation_still_fail_without_retry(self):
        cases = [response(b'12345'), response(b'\xff'), response(b'ok')]
        cases[-1].headers = {'Age': str(p.FRESH + 1)}
        for item in cases:
            with self.subTest(headers=item.headers, payload=item.read.return_value):
                opener = Mock()
                opener.open.return_value = item
                with patch.object(p.urllib.request, 'build_opener', return_value=opener), patch.object(p.time, 'sleep') as sleep, patch.object(p, 'LIMIT', 4):
                    with self.assertRaises(ValueError):
                        p.fetch(p.FX_URL)
                self.assertEqual(opener.open.call_count, 1)
                sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
