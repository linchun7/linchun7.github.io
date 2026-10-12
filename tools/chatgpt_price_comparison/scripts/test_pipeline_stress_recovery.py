"""Second-round bounded stress: natural history growth and partial recovery."""
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import minimum_history as h
import pipeline as p
import test_publication_budget as budgets
import test_retained_fx as retained_fx
from test_pipeline import NOW, revise


class PipelineStressRecoveryTests(unittest.TestCase):
    def test_naturally_grown_valid_country_history_cannot_exceed_consumer_budget(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / 'candidate'
            helpers = budgets.PublicationBudgetTests()
            helpers.candidate(directory)
            data = json.loads((directory / 'prices.json').read_text(encoding='utf-8'))
            market = data['markets'][0]
            first = p.semantic(market)
            higher = copy.deepcopy(first)
            go = next(offer for offer in higher['offers'] if offer['label'] == 'ChatGPT Go')
            self.assertEqual(go['amounts'], ['8'], 'controlled fixture, not a production price')
            go['amounts'] = ['9']
            market['history_baseline'] = {'at': p.stamp(NOW - 5000), 'snapshot': copy.deepcopy(first)}
            data['changes'] = []
            previous = first
            for index in range(4096):
                after = higher if index % 2 == 0 else first
                data['changes'].append({
                    'at': p.stamp(NOW - 4096 + index),
                    'code': market['code'],
                    'before': copy.deepcopy(previous),
                    'after': copy.deepcopy(after),
                })
                previous = after
            self.assertEqual(previous, p.semantic(market))
            revise(data)
            # Prove this is a valid continuous ledger, not random padding or an
            # invalid history rejected by a different contract.
            p.validate(data, NOW)
            ledger = h.advance_history(h.empty_history(), data)
            h.assert_matches(ledger, data)
            raw = budgets.serialized(data)
            self.assertEqual(len(json.loads(raw)['changes']), 4096)
            self.assertGreater(len(raw), budgets.MAX_JSON_BYTES)
            page = p.render(data, (p.ROOT / 'index.template.html').read_text(encoding='utf-8')).encode('utf-8')
            self.assertLessEqual(len(page), budgets.MAX_HTML_BYTES, 'isolate JSON growth from the HTML ceiling')
            contents = {'prices.json': raw, 'minimum-history.json': budgets.serialized(ledger), 'index.html': page}
            for name, value in contents.items():
                (directory / name).write_bytes(value)
            with self.assertRaisesRegex(ValueError, r'prices\.json.*publication.*budget'):
                helpers.check(directory)
            self.assertEqual({name: (directory / name).read_bytes() for name in contents}, contents)

    def test_accepted_partial_batches_recover_one_exact_gap_without_duplicate_price_events(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old, config, _ = retained_fx.RetainedFxTests().baseline(root)
            # Thirteen synthetic USD markets make eleven successful sources
            # meet the actual absolute floor and 80% ratio. Ten require all ten.
            for code in ('jp', 'hk', 'fr'):
                item = {'code': code, 'name': code.upper()}
                config.append(item)
                market = copy.deepcopy(old['markets'][0])
                market.update(code=code, name=item['name'], source_url=p.url_for(code))
                old['markets'].append(market)
            revise(old)
            p.validate(old, NOW)
            history = h.advance_history(h.empty_history(), old)
            h.assert_matches(history, old)
            (root / 'markets.json').write_bytes(budgets.serialized(config))
            (root / 'data/prices.json').write_bytes(budgets.serialized(old))
            (root / 'data/minimum-history.json').write_bytes(budgets.serialized(history))
            self.assertEqual(p.minimum_verified_required(13), 11)
            failed_codes = {'hk', 'fr'}

            def observed(item, prior, now, getter, **kwargs):
                market = copy.deepcopy(prior)
                market.update(name=item['name'], last_checked_at=p.stamp(now))
                if item['code'] in failed_codes:
                    market.update(status='retained', error='http_503', error_detail='Bounded synthetic outage')
                    return market
                market.update(status='verified', last_verified_at=p.stamp(now))
                market.pop('error', None)
                market.pop('error_detail', None)
                if item['code'] == 'us':
                    offer = next(offer for offer in market['offers'] if offer['label'] == 'ChatGPT Go')
                    offer['amounts'][0].update(amount='9', display='USD 9.00')
                    market['fingerprint'] = p.digest(p.semantic(market))
                return market

            def stage_and_publish(label, now):
                before = {name: (root / 'data' / name).read_bytes() for name in ('prices.json', 'minimum-history.json')}
                fx = copy.deepcopy(old['fx'])
                fx.update(updated_at=p.stamp(now), fallback=False)
                directory = root / label
                with patch.object(p, 'ROOT', root), \
                     patch.object(p, 'observe', side_effect=observed), \
                     patch.object(p, 'collect_fx', return_value=fx), \
                     patch.object(p, 'fetch', side_effect=AssertionError('bounded fixture must not fetch')), \
                     contextlib.redirect_stdout(io.StringIO()):
                    data = p.run(directory, now)
                    budgets.PublicationBudgetTests().check(directory)
                    self.assertEqual(json.loads((directory / 'prices.json').read_text(encoding='utf-8')), data)
                ledger = json.loads((directory / 'minimum-history.json').read_text(encoding='utf-8'))
                h.assert_matches(ledger, data)
                self.assertEqual({name: (root / 'data' / name).read_bytes() for name in before}, before)
                self.assertEqual({item.name for item in directory.iterdir()}, {'prices.json', 'minimum-history.json', 'index.html'})
                # Model the already-authorized atomic Git publication within
                # isolated test files, never mutate repository production data.
                for name in ('prices.json', 'minimum-history.json'):
                    (root / 'data' / name).write_bytes((directory / name).read_bytes())
                (root / 'index.html').write_bytes((directory / 'index.html').read_bytes())
                return data, ledger

            first, first_history = stage_and_publish('partial-one', NOW + 60)
            self.assertEqual(sum(market['status'] == 'verified' for market in first['markets']), 11)
            self.assertEqual(sum(market['status'] == 'retained' for market in first['markets']), 2)
            self.assertTrue(first_history['pending_gap'])
            self.assertEqual(first_history['events'], history['events'])
            self.assertEqual(first_history['checkpoint'], history['checkpoint'])
            self.assertEqual(first_history['gaps'], history['gaps'])
            self.assertEqual(len(first['changes']), 1, 'accepted source changes survive a permitted partial batch')
            self.assertEqual(first['changes'][0]['at'], p.stamp(NOW + 60))
            for code in failed_codes:
                before = next(market for market in old['markets'] if market['code'] == code)
                after = next(market for market in first['markets'] if market['code'] == code)
                for key in ('offers', 'fingerprint', 'source_sha256', 'last_verified_at'):
                    self.assertEqual(after[key], before[key])

            second, second_history = stage_and_publish('partial-two', NOW + 120)
            self.assertEqual(second['changes'], first['changes'])
            self.assertEqual(second_history['checkpoint'], history['checkpoint'])
            self.assertEqual(second_history['events'], history['events'])
            self.assertEqual(second_history['gaps'], history['gaps'])
            self.assertTrue(second_history['pending_gap'])
            self.assertEqual(second_history['excluded_versions'], history['excluded_versions'] + 2)

            failed_codes.clear()
            recovered, recovered_history = stage_and_publish('recovered', NOW + 180)
            self.assertTrue(all(market['status'] == 'verified' for market in recovered['markets']))
            self.assertEqual(recovered['changes'], first['changes'])
            self.assertFalse(recovered_history['pending_gap'])
            self.assertEqual(recovered_history['gaps'], history['gaps'] + [
                {'from': history['checkpoint']['at'], 'to': p.stamp(NOW + 180)}
            ])
            self.assertEqual(recovered_history['events'][:len(history['events'])], history['events'])
            self.assertEqual(len(recovered_history['events']), len(history['events']) + 1)
            event = recovered_history['events'][-1]
            self.assertEqual(event['plan'], 'ChatGPT Go')
            self.assertEqual(event['cause'], 'unknown', 'a gap must not invent confident storefront attribution')
            self.assertTrue(event['evidence']['gap'])
            self.assertTrue(event['evidence']['prices_changed'])
            self.assertFalse(event['evidence']['fx_changed'])
            self.assertFalse(event['evidence']['scope_changed'])
            self.assertEqual(event['previous_at'], history['checkpoint']['at'])
            self.assertEqual(event['at'], p.stamp(NOW + 180))
            self.assertIn('us', h.winner_ids(event['from']))
            self.assertNotIn('us', h.winner_ids(event['to']))
            h.assert_matches(recovered_history, recovered)


if __name__ == '__main__':
    unittest.main()
