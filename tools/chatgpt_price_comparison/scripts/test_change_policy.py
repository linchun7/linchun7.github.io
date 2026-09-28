from __future__ import annotations

import unittest
from decimal import Decimal

import change_policy as cp


LOW = Decimal('0.5')
HIGH = Decimal('2')


def market(currency='USD', offers=None):
    return {
        'currency': currency,
        'offers': offers or [
            {'label': 'ChatGPT Plus', 'amounts': [{'amount': '20'}]},
        ],
    }


class ChangePolicyTests(unittest.TestCase):
    def decision(self, old, new):
        return cp.classify(old, new, ratio_low=LOW, ratio_high=HIGH)

    def test_normal_price_change_is_immediate(self):
        result = self.decision(market(), market(offers=[
            {'label': 'ChatGPT Plus', 'amounts': [{'amount': '25'}]},
        ]))
        self.assertEqual((result.kind, result.quarantine), ('price_change', False))

    def test_extreme_price_change_is_quarantined(self):
        result = self.decision(market(), market(offers=[
            {'label': 'ChatGPT Plus', 'amounts': [{'amount': '100'}]},
        ]))
        self.assertEqual((result.kind, result.quarantine), ('extreme_price_change', True))

    def test_plan_addition_is_time_separated_before_publication(self):
        result = self.decision(market(), market(offers=[
            {'label': 'ChatGPT Plus', 'amounts': [{'amount': '20'}]},
            {'label': 'ChatGPT Future', 'amounts': [{'amount': '40'}]},
        ]))
        self.assertEqual((result.kind, result.quarantine), ('plan_added', True))

    def test_plan_removal_replacement_split_or_merge_is_quarantined(self):
        old = market(offers=[
            {'label': 'ChatGPT Plus', 'amounts': [{'amount': '20'}]},
            {'label': 'ChatGPT Future', 'amounts': [{'amount': '40'}]},
        ])
        result = self.decision(old, market())
        self.assertEqual((result.kind, result.quarantine), ('plan_removed_or_replaced', True))

    def test_currency_change_is_quarantined(self):
        result = self.decision(market('USD'), market('EUR'))
        self.assertEqual((result.kind, result.quarantine), ('currency_change', True))

    def test_variant_set_change_is_quarantined(self):
        result = self.decision(market(), market(offers=[
            {'label': 'ChatGPT Plus', 'amounts': [{'amount': '20'}, {'amount': '200'}]},
        ]))
        self.assertEqual((result.kind, result.quarantine), ('variant_set_changed', True))

    def test_same_count_multi_variant_price_change_is_quarantined(self):
        old = market(offers=[
            {'label': 'ChatGPT Plus', 'amounts': [{'amount': '20'}, {'amount': '200'}]},
        ])
        new = market(offers=[
            {'label': 'ChatGPT Plus', 'amounts': [{'amount': '25'}, {'amount': '180'}]},
        ])
        result = self.decision(old, new)
        self.assertEqual((result.kind, result.quarantine), ('multi_variant_price_change', True))

    def test_known_rename_preserves_identity(self):
        old = market(offers=[{'label': 'ChatGPT Pro 5x', 'amounts': [{'amount': '100'}]}])
        new = market(offers=[{'label': 'ChatGPT Pro $100', 'amounts': [{'amount': '100'}]}])
        result = self.decision(old, new)
        self.assertEqual((result.kind, result.quarantine), ('known_rename', False))

    def test_unknown_rename_is_not_guessed(self):
        old = market(offers=[{'label': 'ChatGPT Old Name', 'amounts': [{'amount': '40'}]}])
        new = market(offers=[{'label': 'ChatGPT New Name', 'amounts': [{'amount': '40'}]}])
        result = self.decision(old, new)
        self.assertEqual((result.kind, result.quarantine), ('plan_removed_or_replaced', True))

    def test_duplicate_aliases_are_ambiguous(self):
        old = market(offers=[{'label': 'ChatGPT Pro 5x', 'amounts': [{'amount': '100'}]}])
        new = market(offers=[
            {'label': 'ChatGPT Pro 5x', 'amounts': [{'amount': '100'}]},
            {'label': 'ChatGPT Pro $100', 'amounts': [{'amount': '100'}]},
        ])
        result = self.decision(old, new)
        self.assertEqual((result.kind, result.quarantine), ('ambiguous_identity', True))


if __name__ == '__main__':
    unittest.main()
