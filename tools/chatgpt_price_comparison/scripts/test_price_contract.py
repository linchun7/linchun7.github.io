"""One hand-reviewed price fixture locks Python output to shipped JavaScript.

Synthetic accepted-price contracts do not independently verify Apple prices.
No network, production data, browser oracle, or wall-clock dependency is used.
"""
import copy
import json
import subprocess
import unittest
from pathlib import Path

import minimum_history as h
import pipeline as p

HERE = Path(__file__).resolve().parent
FIXTURE = json.loads((HERE / 'fixtures/price-contracts.json').read_text(encoding='utf-8'))


def projection(data):
    generated = p.epoch(data['generated_at'])
    fx_usable = bool(data['fx']) and generated - p.epoch(data['fx']['updated_at']) >= -300
    result = []
    for label in p.plan_labels(data):
        values = [p.comparable_min_cny(market, label, generated, fx_usable) for market in data['markets']]
        prices = sorted({value for value in values if value is not None})
        ranks = {value: index + 1 for index, value in enumerate(prices)}
        local = []
        for market in data['markets']:
            offer = p.market_offer(market, label)
            displayed = p.display_amounts(offer) if offer else []
            local.append(displayed[0]['amount'] if displayed else None)
        minimum = prices[0] if prices else None
        result.append({
            'label': label,
            'local': local,
            'cny': [format(value, '.2f') if value is not None else None for value in values],
            'ranks': [ranks.get(value) for value in values],
            'minimum': format(minimum, '.2f') if minimum is not None else None,
            'winners': sorted(market['code'] for market, value in zip(data['markets'], values)
                              if minimum is not None and value == minimum),
        })
    return result


class PriceContractTests(unittest.TestCase):
    def test_python_and_shipped_javascript_match_the_same_goldens(self):
        results = []
        for example in FIXTURE['cases']:
            with self.subTest(case=example['name']):
                data = {
                    'generated_at': FIXTURE['generated_at'], 'revision': FIXTURE['revision'],
                    'fx': copy.deepcopy(example['fx']), 'markets': copy.deepcopy(example['markets']),
                }
                before = copy.deepcopy(data)
                actual = projection(data)
                self.assertEqual(actual, example['expected'])
                snapshot = h.build_snapshot(data)
                self.assertEqual(snapshot is not None, example['reliable_history'])
                if snapshot is not None:
                    historical = {plan['id']: h.winner_ids(plan['winners']) for plan in snapshot['plans']}
                    for row in actual:
                        self.assertEqual(historical[p.plan_ids.plan_identity(row['label'])], row['winners'])
                self.assertEqual(data, before, 'projection must not mutate accepted source evidence')
                results.append({'name': example['name'], 'projection': actual})
        completed = subprocess.run(
            ['node', str(HERE / 'price-contract.mjs')],
            check=True, capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(json.loads(completed.stdout), results)

    def test_fixture_conversion_and_missing_fx_are_bound_to_decimal_rounding(self):
        for example in FIXTURE['cases']:
            if example['name'] in ('future_fx_temporarily_hides_comparison', 'future_market_cannot_win'):
                continue
            for market in example['markets']:
                for offer in market['offers']:
                    for amount in offer['amounts']:
                        with self.subTest(case=example['name'], market=market['code'], amount=amount['amount']):
                            actual = p.converted(market, amount['amount'], example['fx'],
                                                 p.epoch(FIXTURE['generated_at']))
                            self.assertEqual(actual, amount['cny'])


if __name__ == '__main__':
    unittest.main()
