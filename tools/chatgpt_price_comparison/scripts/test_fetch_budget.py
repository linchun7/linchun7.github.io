"""Cooperative body deadlines, using real HTTPResponse buffering without a network."""
import copy
from http.client import HTTPResponse, IncompleteRead
import io
import json
import unittest
from unittest.mock import Mock, call, patch
from urllib.error import URLError

import pipeline as p
from test_pipeline import NOW, data_fixture, fixture, good_market


class Clock:
    def __init__(self):
        self.value = 0

    def monotonic(self):
        return self.value

    def sleep(self, seconds):
        self.value += seconds


class SlowBody(io.RawIOBase):
    """Each body receive advances a fake clock; headers arrive immediately."""
    def __init__(self, wire, clock, block_size, delay, eof_delay):
        self.wire = wire
        self.clock = clock
        self.block_size = block_size
        self.delay = delay
        self.eof_delay = eof_delay
        self.position = 0
        self.header_end = wire.index(b'\r\n\r\n') + 4

    def readable(self):
        return True

    def readinto(self, buffer):
        if self.position == len(self.wire):
            self.clock.value += self.eof_delay
            return 0
        in_headers = self.position < self.header_end
        available = self.header_end - self.position if in_headers else self.block_size
        count = min(len(buffer), available, len(self.wire) - self.position)
        if not in_headers:
            self.clock.value += self.delay
        buffer[:count] = self.wire[self.position:self.position + count]
        self.position += count
        return count


def response(payload, clock, *, framing='length', block_size=16, delay=0,
             eof_delay=0, declared_length=None, incomplete_chunked=False):
    headers = b'HTTP/1.1 200 OK\r\n'
    body = payload
    if framing == 'chunked':
        headers += b'Transfer-Encoding: chunked\r\n'
        body = b''.join(f'{len(part):x}\r\n'.encode() + part + b'\r\n'
                        for part in (payload[i:i + 16] for i in range(0, len(payload), 16))) + b'0\r\n\r\n'
        if incomplete_chunked:
            body = body[:-5]
    if framing == 'length' or declared_length is not None:
        size = len(payload) if declared_length is None else declared_length
        headers += f'Content-Length: {size}\r\n'.encode()
    raw = SlowBody(headers + b'\r\n' + body, clock, block_size, delay, eof_delay)
    sock = Mock()
    sock.makefile.return_value = io.BufferedReader(raw)
    value = HTTPResponse(sock)
    value.begin()
    return value, raw


class FetchBudgetTests(unittest.TestCase):
    def test_continuous_body_exhausts_budget_before_acceptance(self):
        # Each receive is quick, but the total response exceeds the deadline.
        # HTTPResponse.read(LIMIT + 1) performs many receives in one call.
        for framing in ('length', 'close', 'chunked'):
            with self.subTest(framing=framing):
                clock = Clock()
                reply, raw = response(b'x' * 200, clock, framing=framing, delay=1)
                opener = Mock()
                opener.open.return_value = reply
                with patch.object(p.urllib.request, 'build_opener', return_value=opener), \
                     patch.object(p.time, 'monotonic', side_effect=clock.monotonic), \
                     patch.object(p.time, 'sleep', side_effect=clock.sleep) as sleep:
                    with self.assertRaisesRegex(TimeoutError, 'network run budget exhausted'):
                        p.fetch(p.FX_URL, deadline=5)
                self.assertEqual(opener.open.call_count, 1)
                sleep.assert_called_once_with(1)
                self.assertGreaterEqual(clock.value, 5)
                self.assertLess(clock.value, 7)
                self.assertTrue(raw.closed)

    def test_last_block_and_eof_cannot_accept_a_late_complete_body(self):
        for framing, delay, eof_delay in (('length', 5, 0), ('close', 1, 5)):
            with self.subTest(framing=framing):
                clock = Clock()
                reply, raw = response(b'{}', clock, framing=framing, block_size=2,
                                      delay=delay, eof_delay=eof_delay)
                opener = Mock()
                opener.open.return_value = reply
                with patch.object(p.urllib.request, 'build_opener', return_value=opener), \
                     patch.object(p.time, 'monotonic', side_effect=clock.monotonic), \
                     patch.object(p.time, 'sleep', side_effect=clock.sleep):
                    with self.assertRaises(TimeoutError):
                        p.fetch(p.FX_URL, deadline=5)
                self.assertEqual(opener.open.call_count, 1)
                self.assertTrue(raw.closed)

    def test_complete_fast_body_supports_each_http_framing(self):
        for framing in ('length', 'close', 'chunked'):
            with self.subTest(framing=framing):
                clock = Clock()
                reply, raw = response('完整响应'.encode(), clock, framing=framing,
                                      declared_length=999 if framing == 'chunked' else None)
                opener = Mock()
                opener.open.return_value = reply
                with patch.object(p.urllib.request, 'build_opener', return_value=opener), \
                     patch.object(p.time, 'monotonic', side_effect=clock.monotonic), \
                     patch.object(p.time, 'sleep') as sleep:
                    self.assertEqual(p.fetch(p.FX_URL, deadline=5), '完整响应')
                self.assertEqual(opener.open.call_count, 1)
                sleep.assert_not_called()
                self.assertTrue(raw.closed)

    def test_short_content_length_retries_whole_response(self):
        clock = Clock()
        replies = [response(b'{"looks":"valid"}', clock, declared_length=100) for _ in range(3)]
        opener = Mock()
        opener.open.side_effect = [item[0] for item in replies]
        with patch.object(p.urllib.request, 'build_opener', return_value=opener), \
             patch.object(p.time, 'monotonic', side_effect=clock.monotonic), \
             patch.object(p.time, 'sleep', side_effect=clock.sleep) as sleep:
            with self.assertRaises(URLError) as raised:
                p.fetch(p.FX_URL, deadline=10)
        self.assertIsInstance(raised.exception.__cause__, IncompleteRead)
        self.assertEqual(opener.open.call_count, 3)
        self.assertEqual(sleep.call_args_list, [call(1), call(3)])
        self.assertTrue(all(raw.closed for _, raw in replies))

    def test_body_byte_limit_still_rejects_without_retry(self):
        clock = Clock()
        reply, raw = response(b'12345', clock)
        opener = Mock()
        opener.open.return_value = reply
        with patch.object(p.urllib.request, 'build_opener', return_value=opener), \
             patch.object(p, 'LIMIT', 4), patch.object(p.time, 'sleep') as sleep:
            with self.assertRaisesRegex(ValueError, 'response exceeds size budget'):
                p.fetch(p.FX_URL)
        self.assertEqual(opener.open.call_count, 1)
        sleep.assert_not_called()
        self.assertTrue(raw.closed)

    def test_interrupted_chunked_body_retries_without_returning_its_prefix(self):
        clock = Clock()
        replies = [response(b'valid-looking prefix', clock, framing='chunked', incomplete_chunked=True),
                   response(b'complete response', clock)]
        opener = Mock()
        opener.open.side_effect = [item[0] for item in replies]
        with patch.object(p.urllib.request, 'build_opener', return_value=opener), \
             patch.object(p.time, 'monotonic', side_effect=clock.monotonic), \
             patch.object(p.time, 'sleep', side_effect=clock.sleep) as sleep:
            self.assertEqual(p.fetch(p.FX_URL, deadline=10), 'complete response')
        self.assertEqual(opener.open.call_count, 2)
        sleep.assert_called_once_with(1)
        self.assertTrue(all(raw.closed for _, raw in replies))

    def test_slow_market_preserves_accepted_price_and_evidence(self):
        old = good_market()
        before = copy.deepcopy(old)
        clock = Clock()
        reply, raw = response(fixture().encode(), clock, block_size=128, delay=1)
        opener = Mock()
        opener.open.return_value = reply
        with patch.object(p.urllib.request, 'build_opener', return_value=opener), \
             patch.object(p.time, 'monotonic', side_effect=clock.monotonic), \
             patch.object(p.time, 'sleep', side_effect=clock.sleep):
            result = p.observe({'code': 'us', 'name': '美国'}, old, NOW + 60,
                               getter=lambda url, **kw: p.fetch(url, deadline=2, **kw))
        self.assertEqual(result['status'], 'retained')
        self.assertEqual(result['error'], 'source_unverified')
        for key in ('offers', 'fingerprint', 'source_sha256', 'last_verified_at'):
            self.assertEqual(result[key], before[key])
        self.assertEqual(result['last_checked_at'], p.stamp(NOW + 60))
        self.assertEqual(old, before)
        self.assertEqual(opener.open.call_count, 1)
        self.assertTrue(raw.closed)

    def test_slow_fx_preserves_old_rates_and_source_timestamp(self):
        old = data_fixture()['fx']
        before = copy.deepcopy(old)
        rates = {code: 1 for code in ('AUD', 'BRL', 'CAD', 'CHF', 'CLP', 'COP', 'CZK', 'DKK',
                 'EGP', 'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'KRW', 'MXN',
                 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'ZAR')}
        rates.update(USD=1, CNY=7, JPY=150)
        payload = json.dumps({'result': 'success', 'base_code': 'USD',
                              'time_last_update_unix': NOW, 'rates': rates}).encode()
        clock = Clock()
        reply, raw = response(payload, clock, block_size=64, delay=1)
        opener = Mock()
        opener.open.return_value = reply
        with patch.object(p.urllib.request, 'build_opener', return_value=opener), \
             patch.object(p.time, 'monotonic', side_effect=clock.monotonic), \
             patch.object(p.time, 'sleep', side_effect=clock.sleep):
            result = p.collect_fx(NOW + 60, old, required_currencies=('JPY',),
                                  getter=lambda url: p.fetch(url, deadline=2))
        self.assertEqual(result, dict(before, fallback=True))
        self.assertEqual(old, before)
        self.assertEqual(opener.open.call_count, 1)
        self.assertTrue(raw.closed)


if __name__ == '__main__':
    unittest.main()
