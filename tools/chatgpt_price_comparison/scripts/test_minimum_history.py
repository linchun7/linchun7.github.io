from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path
from decimal import Decimal

import minimum_history as h
import pipeline as p
from test_pipeline import NOW, data_fixture, revise


def fixture(offset=0):
    data=copy.deepcopy(data_fixture())
    now=NOW+offset
    data['generated_at']=p.stamp(now)
    data['fx']['updated_at']=p.stamp(now)
    data['fx']['fallback']=False
    for market in data['markets']:
        market['last_checked_at']=p.stamp(now)
        market['last_verified_at']=p.stamp(now)
        for offer in market['offers']:
            for amount in offer['amounts']:
                amount['cny']=p.converted(market, amount['amount'], data['fx'], now)
    revise(data)
    return data


class MinimumHistoryTests(unittest.TestCase):
    def test_committed_history_matches_prices(self):
        data=json.loads((p.ROOT/'data/prices.json').read_text(encoding='utf-8'))
        history=json.loads((p.ROOT/'data/minimum-history.json').read_text(encoding='utf-8'))
        self.assertTrue(h.assert_matches(history,data))

    def test_only_winner_changes_create_events_and_fx_is_classified(self):
        def two_markets(offset=0):
            data=fixture(offset)
            second=copy.deepcopy(data['markets'][0])
            second['code']='jp'
            second['name']='日本'
            second['source_url']=p.url_for('jp')
            for offer in second['offers']:
                for amount in offer['amounts']:
                    amount['amount']=str(Decimal(amount['amount'])*2)
                    amount['cny']=format(Decimal(amount['cny'])*2,'.2f')
            second['fingerprint']=p.digest(p.semantic(second))
            data['markets'].append(second)
            revise(data)
            return data

        first=two_markets()
        history=h.advance_history(h.empty_history(),first)
        unchanged=two_markets(86400)
        for rate in unchanged['fx']['rates']:
            if rate not in ('USD','CNY'):
                unchanged['fx']['rates'][rate]=str(float(unchanged['fx']['rates'][rate])*1.01)
        revise(unchanged)
        same=h.advance_history(history,unchanged)
        self.assertEqual(len([e for e in same['events'] if e['kind']=='change']),0)

        changed=two_markets(2*86400)
        target_plan=same['checkpoint']['plans'][0]['id']
        market=next(market for market in changed['markets'] if market['code']=='jp')
        plan=next(offer for offer in market['offers'] if offer['label']==target_plan)
        plan['amounts'][0]['amount']='1'
        plan['amounts'][0]['cny']='0.01'
        market['fingerprint']=p.digest(p.semantic(market))
        revise(changed)
        updated=h.advance_history(same,changed)
        changes=[e for e in updated['events'] if e['kind']=='change']
        self.assertTrue(changes)
        self.assertEqual(changes[-1]['to'][0]['code'],'jp')
        self.assertEqual(changes[-1]['cause'],'storefront')

    def test_degraded_observation_creates_gap_not_winner_event(self):
        first=fixture()
        history=h.advance_history(h.empty_history(),first)
        stale=fixture(86400)
        stale['fx']['fallback']=True
        revise(stale)
        gap=h.advance_history(history,stale)
        self.assertTrue(gap['pending_gap'])
        self.assertEqual(len(gap['events']),len(history['events']))
        recovered=h.advance_history(gap,fixture(2*86400))
        self.assertFalse(recovered['pending_gap'])
        self.assertEqual(len(recovered['gaps']),1)

    def test_same_timestamp_conflict_and_rollback_fail_closed(self):
        data=fixture()
        history=h.advance_history(h.empty_history(),data)
        self.assertEqual(h.advance_history(history,data),history)
        conflict=copy.deepcopy(data)
        conflict['markets'][0]['offers'][0]['amounts'][0]['cny']='0.01'
        revise(conflict)
        with self.assertRaisesRegex(ValueError,'conflicting'):
            h.advance_history(history,conflict)
        with self.assertRaisesRegex(ValueError,'roll back'):
            h.advance_history(history,fixture(-1))

    def test_malformed_history_is_rejected(self):
        history=h.advance_history(h.empty_history(),fixture())
        for mutate in (
            lambda x: x.update(schema=2),
            lambda x: x['events'][0].update(cause='fx'),
            lambda x: x['checkpoint']['plans'][0]['winners'][0].update(code='BAD'),
            lambda x: x['checkpoint']['plans'][0]['prices'][0].__setitem__(2,'bad'),
        ):
            broken=copy.deepcopy(history); mutate(broken)
            with self.assertRaises(ValueError):
                h.validate_history(broken)


if __name__ == '__main__':
    unittest.main()
