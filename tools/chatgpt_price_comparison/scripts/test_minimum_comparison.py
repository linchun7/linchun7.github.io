from __future__ import annotations
import copy
import json
import subprocess
import unittest
from unittest.mock import patch
import minimum_history as h
import pipeline as p
from test_minimum_history import fixture
from test_pipeline import revise

def pro_snapshot(offset=0, today=False):
    data = fixture(offset)
    data['fx']['rates'] = {'USD':'1', 'CNY':'6.714553' if today else '6.716878',
                          'CHF':'0.832335' if today else '0.835134',
                          'THB':'33.667593' if today else '33.580261'}
    template = data['markets'][0]
    data['markets'] = []
    for code, name, currency, local in [('ch','瑞士','CHF','83'),('th','泰国','THB','3350')]:
        market = copy.deepcopy(template)
        market.update(code=code, name=name, currency=currency, source_url=p.url_for(code))
        market['offers'] = [{'label':'ChatGPT Pro 100' if today else 'ChatGPT Pro 5x',
                             'amounts':[{'amount':local, 'display':currency+' '+local,
                                         'cny':p.converted(market, local, data['fx'], p.epoch(data['generated_at']))}]}]
        market['fingerprint'] = p.digest(p.semantic(market))
        data['markets'].append(market)
    revise(data)
    return data

def sequence(gap=False):
    old, current = pro_snapshot(), pro_snapshot(86400, True)
    ledger = h.advance_history(h.empty_history(), old)
    if gap:
        retained = pro_snapshot(43200, True)
        for market in retained['markets']:
            market['status'] = 'retained'
        revise(retained)
        ledger = h.advance_history(ledger, retained)
    return old, current, h.advance_history(ledger, current)

def legacy(ledger):
    result = copy.deepcopy(ledger)
    for event in result['events']:
        event.pop('comparison', None)
    return result

class SameObservationTests(unittest.TestCase):
    def test_swiss_66756_is_preserved_but_comparison_is_66957_vs_66811(self):
        old, current, ledger = sequence(True)
        event = ledger['events'][-1]
        self.assertEqual(event['plan'], 'ChatGPT Pro 5x')
        self.assertEqual(event['from'][0]['cny'], '667.56')
        self.assertEqual(event['to'][0]['cny'], '668.11')
        self.assertEqual(event['comparison']['from'][0]['cny'], '669.57')
        self.assertEqual(event['comparison']['to'][0]['cny'], '668.11')
        self.assertEqual(event['comparison']['fx']['rates'], current['fx']['rates'])
        self.assertEqual(event['cause'], 'unknown')
        self.assertTrue(event['evidence']['gap'])
        self.assertTrue(h.assert_matches(ledger, current))

    def test_only_currency_amount_changes_do_not_create_winner_events(self):
        old = pro_snapshot()
        first = h.advance_history(h.empty_history(), old)
        current = pro_snapshot(86400)
        current['fx']['rates']['CNY'] = '7'
        for market in current['markets']:
            price = market['offers'][0]['amounts'][0]
            price['cny'] = p.converted(market, price['amount'], current['fx'], p.epoch(current['generated_at']))
        revise(current)
        self.assertEqual(h.advance_history(first, current)['events'], first['events'])

    def test_tied_winners_keep_all_prices_at_the_same_observation(self):
        old, current = pro_snapshot(), pro_snapshot(86400, True)
        for data, local_th in [(old,'84'),(current,'83')]:
            data['fx']['rates'] = {'USD':'1','CNY':'1','CHF':'1','THB':'1'}
            for market in data['markets']:
                local = '83' if market['code']=='ch' else local_th
                market['offers'][0]['amounts'][0].update(amount=local,cny=local+'.00')
            revise(data)
        ledger = h.advance_history(h.advance_history(h.empty_history(), old), current)
        event = ledger['events'][-1]
        self.assertEqual(h.winner_ids(event['to']), ['ch','th'])
        self.assertEqual(h.winner_ids(event['comparison']['to']), ['ch','th'])
        self.assertEqual(event['comparison']['from'][0]['cny'], '83.00')

    def test_old_winner_removed_from_plan_is_missing_not_reconverted(self):
        old, current = pro_snapshot(), pro_snapshot(86400, True)
        current['markets'][0]['offers'] = []
        revise(current)
        ledger = h.advance_history(h.advance_history(h.empty_history(), old), current)
        event = ledger['events'][-1]
        self.assertEqual(event['comparison']['from'], [])
        self.assertEqual(event['comparison']['missing'], [{'code':'ch','name':'瑞士'}])
        self.assertEqual(event['from'][0]['cny'], '667.56')
        self.assertTrue(h.assert_matches(ledger, current))

    def test_legacy_events_remain_valid_without_new_evidence(self):
        _, _, ledger = sequence()
        self.assertEqual(h.validate_history(legacy(ledger)), legacy(ledger))

    def test_exact_backfill_preserves_every_old_fact_and_is_idempotent(self):
        old, current, ledger = sequence(True)
        original = legacy(ledger)
        observations = [('a'*40,old),('b'*40,current),('c'*40,current)]
        enriched, report = h.enrich_history(original, observations)
        self.assertEqual(legacy(enriched), original)
        self.assertEqual(report['complete'], 2)
        self.assertEqual(report['missing'], 0)
        self.assertEqual(enriched['events'][-1]['comparison']['source_commit'], 'b'*40)
        again, _ = h.enrich_history(enriched, observations)
        self.assertEqual(enriched, again)

    def test_same_time_wrong_revision_and_future_prices_cannot_fill_old_event(self):
        old, current, ledger = sequence()
        original = legacy(ledger)
        wrong = copy.deepcopy(current)
        wrong['revision'] = 'f'*64
        later = pro_snapshot(2*86400, True)
        for data in (wrong,later):
            enriched, report = h.enrich_history(original, [('a'*40,data)])
            self.assertEqual(enriched, original)
            self.assertEqual(report['missing'], 2)

    def test_unreliable_exact_snapshot_stays_unfilled(self):
        old, current, ledger = sequence()
        original = legacy(ledger)
        for market in current['markets']:
            market['status'] = 'retained'
        enriched, report = h.enrich_history(original, [('a'*40,current)])
        self.assertEqual(enriched, original)
        self.assertEqual(report['missing'], 2)
        self.assertEqual(report['events'][-1]['reason'], 'exact_snapshot_unreliable')
        self.assertEqual(report['events'][-1]['candidate_commits'], ['a'*40])

    def test_comparison_rejects_wrong_time_revision_fx_and_missing_coverage(self):
        _, _, ledger = sequence()
        for mutate in (
            lambda c: c.update(at=p.stamp(p.epoch(c['at'])+1)),
            lambda c: c.update(source_revision='f'*64),
            lambda c: c['from'][0].update(cny='667.56'),
            lambda c: c['fx']['rates'].update(CHF='0'),
            lambda c: c.update(missing=[{'code':'ch','name':'瑞士'}]),
            lambda c: c['fx'].update(updated_at=p.stamp(p.epoch(c['at'])-2*86400)),
        ):
            broken = copy.deepcopy(ledger)
            mutate(broken['events'][-1]['comparison'])
            with self.assertRaises(ValueError):
                h.validate_history(broken)

    def test_frontend_rejects_mismatched_time_revision_and_fx(self):
        _, _, ledger = sequence()
        event = ledger['events'][-1]
        script = r"""
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(process.argv[1],'utf8');
const event = JSON.parse(process.argv[2]);
const context = {canonical:JSON.stringify};
for (const name of ['validMinimumWinner','validateMinimumComparison']) {
  const match = source.match(new RegExp('  function '+name+'\\([^]*?\\n  \\}'));
  assert.ok(match,name);
  context[name] = runInNewContext('('+match[0].trim()+')',context);
}
context.validateMinimumComparison(event);
const legacy = structuredClone(event); delete legacy.comparison;
context.validateMinimumComparison(legacy);
for (const mutate of [
  c => c.at='2026-09-01T00:00:00Z',
  c => c.source_revision='f'.repeat(64),
  c => c.from[0].cny='667.56',
  c => c.fx.rates.CHF='0',
  c => c.missing=[{code:'ch',name:'瑞士'}],
  c => c.to.push({...c.to[0],code:'us'})
]) {
  const broken=structuredClone(event); mutate(broken.comparison);
  assert.throws(() => context.validateMinimumComparison(broken));
}
"""
        subprocess.run(['node','--input-type=module','-e',script,str(p.ROOT/'app.js'),
                        json.dumps(event,ensure_ascii=False)],
                       check=True,capture_output=True,text=True,timeout=10)

    def test_conflicting_exact_snapshots_do_not_choose_one_arbitrarily(self):
        old, current, ledger = sequence()
        changed = copy.deepcopy(current)
        changed['markets'][0]['name'] = 'Different observed name'
        enriched, report = h.enrich_history(legacy(ledger), [('a'*40,current),('b'*40,changed)])
        self.assertNotIn('comparison',enriched['events'][-1])
        self.assertEqual(report['events'][-1]['reason'],'conflicting_exact_snapshots')

    def test_snapshot_selection_rejects_event_mismatch(self):
        _, current, ledger = sequence()
        for key in ('at','source_revision'):
            event = copy.deepcopy(ledger['events'][-1])
            event[key] = 'f'*64 if key=='source_revision' else p.stamp(p.epoch(event['at'])+1)
            with self.assertRaisesRegex(ValueError,'exact reliable'):
                h.comparison_for(event, current)

    def test_git_backfill_uses_exact_first_parent_commit(self):
        old, current, ledger = sequence()
        original = legacy(ledger)
        def git(args, **kwargs):
            command = args[1]
            if command=='rev-parse': return 'false\n'
            if command=='log': return 'a'*40+'\n'+'b'*40+'\n'
            if command=='ls-tree': return h.PRICE_PATH+'\n'
            if command=='show': return json.dumps(old if args[2].startswith('a') else current)
            raise AssertionError(args)
        with patch.object(h.subprocess,'check_output',side_effect=git):
            enriched, report = h.enrich_history_from_git(original)
        self.assertEqual(report['complete'],2)
        self.assertEqual(enriched['events'][-1]['comparison']['source_commit'],'b'*40)
        self.assertEqual(legacy(enriched),original)

    def test_frontend_shows_same_observation_missing_and_legacy_without_current_data(self):
        old, current, ledger = sequence(True)
        event = ledger['events'][-1]
        missing = copy.deepcopy(event)
        missing['comparison']['from'] = []
        missing['comparison']['missing'] = [{'code':'ch','name':'瑞士'}]
        old_event = copy.deepcopy(event)
        old_event.pop('comparison')
        script = r"""
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(process.argv[1],'utf8');
const cases = JSON.parse(process.argv[2]);
const context = {};
for (const name of ['minimumWinnerSummary','minimumEventSummary']) {
  const match = source.match(new RegExp('  function '+name+'\\([^]*?\\n  \\}'));
  assert.ok(match, name);
  context[name] = runInNewContext('('+match[0].trim()+')',context);
}
assert.equal(context.minimumEventSummary(cases[0]),'瑞士 ¥669.57 → 泰国 ¥668.11');
assert.equal(context.minimumEventSummary(cases[1]),'瑞士（同期价缺失） → 泰国 ¥668.11');
assert.equal(context.minimumEventSummary(cases[2]),'瑞士（同期价未记录） → 泰国 ¥668.11');
"""
        subprocess.run(['node','--input-type=module','-e',script,str(p.ROOT/'app.js'),
                        json.dumps([event,missing,old_event],ensure_ascii=False)],
                       check=True,capture_output=True,text=True,timeout=10)
