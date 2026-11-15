import copy
import json
import unittest
import os
import tempfile
from pathlib import Path
import minimum_history
import test_retained_fx
from urllib.error import URLError
from unittest.mock import patch

import pipeline as p
import fx_sanity as gate
from test_pipeline import NOW, data_fixture, revise


class FxSanityTests(unittest.TestCase):
    def baseline(self, age=3600):
        return {'source_url': p.FX_URL, 'updated_at': p.stamp(NOW-age),
                'rates': {'USD': '1', 'CNY': '7', 'INR': '94.26'}, 'fallback': False}

    def collect(self, rate=94.26, *, old=None, secondary=94.26, age=0, updated=None, mutate=None):
        rates = {'USD': 1, 'CNY': 7, 'INR': rate}
        rates.update({'X' + a + b: 2 for a in 'ABCDEFGHIJ' for b in 'ABC'})
        payload = {'result': 'success', 'base_code': 'USD',
                   'time_last_update_unix': NOW if updated is None else updated, 'rates': rates}
        evidence = [{'base': 'USD', 'quote': c, 'rate': v, 'date': p.stamp(NOW-age)[:10]}
                    for c, v in [('USD', 1), ('CNY', 7), ('INR', secondary)]]
        if mutate:
            mutate(evidence)
        calls = []
        def getter(url):
            calls.append(url)
            if url == p.FX_URL:
                return json.dumps(payload)
            self.assertEqual(url, gate.CONFIRM_URL)
            if isinstance(secondary, Exception):
                raise secondary
            return json.dumps(evidence)
        result = p.collect_fx(NOW, old, getter, {'INR'})
        return result, calls

    def test_decimal_shift_never_projects_hundredfold_price_and_retains_date(self):
        old = self.baseline()
        before = copy.deepcopy(old)
        result, calls = self.collect(0.9426, old=old)
        self.assertTrue(result['fallback'])
        self.assertEqual(result['rates'], old['rates'])
        self.assertEqual(result['updated_at'], old['updated_at'])
        self.assertEqual(old, before)
        market = {'currency': 'INR', 'last_verified_at': p.stamp(NOW)}
        self.assertEqual(p.converted(market, '1999', result, NOW),
                         p.converted(market, '1999', old, NOW))
        self.assertEqual(calls, [p.FX_URL, gate.CONFIRM_URL])

    def test_normal_drift_needs_no_extra_request_and_recovers_retained_state(self):
        old = dict(self.baseline(), fallback=True)
        result, calls = self.collect(95, old=old)
        self.assertFalse(result['fallback'])
        self.assertEqual(result['updated_at'], p.stamp(NOW))
        self.assertEqual(calls, [p.FX_URL])

    def test_legitimate_large_move_can_pass_independent_confirmation(self):
        result, calls = self.collect(150, old=self.baseline(), secondary=151)
        self.assertFalse(result['fallback'])
        self.assertEqual(result['rates']['INR'], '150')
        self.assertIn(gate.CONFIRM_URL, calls)

    def test_failure_repeated_outage_then_confirmed_recovery(self):
        old = self.baseline()
        for age in [1, 8, 90]:
            prior = dict(old, updated_at=p.stamp(NOW-age*86400), fallback=True)
            blocked, _ = self.collect(1000, old=prior, secondary=URLError('offline'))
            self.assertTrue(blocked['fallback'])
            self.assertEqual(blocked['updated_at'], prior['updated_at'])
            recovered, _ = self.collect(1000, old=blocked, secondary=1000)
            self.assertFalse(recovered['fallback'])
            self.assertEqual(recovered['updated_at'], p.stamp(NOW))

    def test_bootstrap_new_currency_and_normal_long_gap_do_not_depend_on_secondary(self):
        for old in [None, self.baseline(90*86400),
                    dict(self.baseline(), rates={'USD': '1', 'CNY': '7'})]:
            result, calls = self.collect(old=old, secondary=URLError('offline'))
            self.assertFalse(result['fallback'])
            self.assertEqual(calls, [p.FX_URL])

    def test_long_gap_does_not_allow_decimal_shift_just_because_baseline_is_old(self):
        result, calls = self.collect(0.9426, old=self.baseline(90*86400))
        self.assertTrue(result['fallback'])
        self.assertIn(gate.CONFIRM_URL, calls)

    def test_stale_future_missing_duplicate_wrong_base_and_bad_numeric_confirmation_rejected(self):
        mutations = [
            lambda rows: rows.pop(),
            lambda rows: rows.append(dict(rows[-1])),
            lambda rows: rows[-1].update(base='EUR'),
            lambda rows: rows[-1].update(date=p.stamp(NOW+2*86400)[:10]),
            lambda rows: rows[-1].update(date=p.stamp(NOW-8*86400)[:10]),
            lambda rows: rows[-1].update(rate=True),
            lambda rows: rows[-1].update(rate=float('nan')),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                result, _ = self.collect(150, old=self.baseline(), secondary=150, mutate=mutate)
                self.assertTrue(result['fallback'])

    def test_weekend_confirmation_and_both_symmetric_directions(self):
        accepted, _ = self.collect(150, old=self.baseline(), secondary=150, age=2*86400)
        self.assertFalse(accepted['fallback'])
        for rate in [0.9426, 9426]:
            result, _ = self.collect(rate, old=self.baseline())
            self.assertTrue(result['fallback'])

    def test_timestamp_regression_does_not_renew_proof(self):
        old = self.baseline(60)
        result, calls = self.collect(old=old, updated=NOW-120)
        self.assertTrue(result['fallback'])
        self.assertEqual(result['updated_at'], old['updated_at'])
        self.assertEqual(calls, [p.FX_URL])

    def test_gate_uses_cny_cross_rate_and_elapsed_source_age(self):
        old = self.baseline(2*86400)
        # Two days' compounded tolerance, rather than an inflexible one-day cap.
        self.assertEqual(gate.confirmation_currencies(
            NOW, NOW, {'USD': '1', 'CNY': '7', 'INR': '116'}, old, p.epoch), set())
        # Equal USD-leg scaling leaves INR conversion unchanged; USD itself changed.
        needed = gate.confirmation_currencies(
            NOW, NOW, {'USD': '1', 'CNY': '14', 'INR': '188.52'}, self.baseline(), p.epoch)
        self.assertEqual(needed, {'USD'})

    def test_secondary_requests_use_existing_url_allowlist_and_budget(self):
        with patch.object(p.urllib.request, 'build_opener') as opener:
            opener.return_value.open.side_effect = URLError('test')
            with patch.object(p.time, 'sleep'):
                with self.assertRaises(URLError):
                    p.fetch(gate.CONFIRM_URL, deadline=p.time.monotonic()+2)
            self.assertEqual(opener.return_value.open.call_args.args[0].full_url, gate.CONFIRM_URL)
        with self.assertRaisesRegex(ValueError, 'not allowlisted'):
            p.fetch(gate.CONFIRM_URL + '&evil=1')

    def test_pipeline_marks_anomaly_degraded_preserves_history_and_recovers(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old, config, _ = test_retained_fx.RetainedFxTests().baseline(root)
            old['fx']['rates']['INR'] = '94.26'
            india = next(m for m in old['markets'] if m['code'] == 'in')
            india['currency'] = 'INR'
            for offer in india['offers']:
                for price in offer['amounts']:
                    price['display'] = '₹' + price['amount']
                    price['cny'] = p.converted(india, price['amount'], old['fx'], NOW)
            india['fingerprint'] = p.digest(p.semantic(india))
            revise(old)
            history = minimum_history.advance_history(minimum_history.empty_history(), old)
            (root/'data/prices.json').write_text(json.dumps(old))
            (root/'data/minimum-history.json').write_text(json.dumps(history))
            p.validate(old, NOW)
            def observed(item, previous, now, getter, **kwargs):
                market = copy.deepcopy(previous)
                market.update(status='verified', last_checked_at=p.stamp(now), last_verified_at=p.stamp(now))
                return market
            for offset, rate, degraded in [(3600, .9426, True), (7200, 94.26, False)]:
                output = root/('status-' + str(offset))
                rates = {'USD': 1, 'CNY': 7, 'INR': rate}
                rates.update({'X'+a+b: 2 for a in 'ABCDEFGHIJ' for b in 'ABC'})
                def fetched(url, **kwargs):
                    if url == p.FX_URL:
                        return json.dumps({'result': 'success', 'base_code': 'USD',
                                           'time_last_update_unix': NOW+offset, 'rates': rates})
                    return json.dumps([{'base': 'USD', 'quote': code, 'rate': value,
                                        'date': p.stamp(NOW+offset)[:10]}
                                       for code, value in [('USD', 1), ('CNY', 7), ('INR', 94.26)]])
                candidate = root/('candidate-' + str(offset))
                with patch.object(p, 'ROOT', root), patch.object(p, 'observe', side_effect=observed),                         patch.object(p, 'fetch', side_effect=fetched),                         patch.dict(os.environ, {'GITHUB_OUTPUT': str(output)}):
                    result = p.run(candidate, NOW+offset)
                self.assertEqual(result['fx']['fallback'], degraded)
                self.assertIn('degraded=' + str(degraded).lower(), output.read_text())
                self.assertEqual(result['changes'], old['changes'])
                projected = next(m for m in result['markets'] if m['code'] == 'in')
                self.assertEqual(projected['offers'], india['offers'])
                ledger = json.loads((candidate/'minimum-history.json').read_text())
                self.assertEqual(ledger['events'], history['events'])
                if degraded:
                    self.assertEqual(result['fx']['updated_at'], old['fx']['updated_at'])
                else:
                    self.assertEqual(result['fx']['updated_at'], p.stamp(NOW+offset))
                for name in ['prices.json', 'minimum-history.json']:
                    (root/'data'/name).write_bytes((candidate/name).read_bytes())


if __name__ == '__main__':
    unittest.main()
