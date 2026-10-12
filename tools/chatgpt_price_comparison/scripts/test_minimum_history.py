from __future__ import annotations

import copy
import json
import tempfile
import subprocess
import unittest
from unittest.mock import patch
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


def scoped_fx_fixture(offset=0, *, us_price='20', lk_price='21', jpy='150', cny='7',
                      future_currencies=('USD', 'USD')):
    """All configured markets are valid; FutureTier has only two storefronts."""
    data = fixture(offset)
    base = copy.deepcopy(data['markets'][0])
    data['fx']['rates'].update(JPY=jpy, CNY=cny)
    config = json.loads((p.ROOT / 'markets.json').read_text(encoding='utf-8'))
    data['markets'] = []
    for item in config:
        market = copy.deepcopy(base)
        currency = 'JPY' if item['code'] == 'jp' else 'USD'
        if item['code'] in ('us', 'lk'):
            currency = future_currencies[('us', 'lk').index(item['code'])]
        market.update(code=item['code'], name=item['name'], source_url=p.url_for(item['code']), currency=currency)
        plus = {'USD': '30', 'JPY': '4500', 'CNY': '210'}[currency]
        market['offers'] = [{'label': 'ChatGPT Plus', 'amounts': [{'amount': plus}]}]
        if item['code'] in ('us', 'lk'):
            local = us_price if item['code'] == 'us' else lk_price
            market['offers'].append({'label': 'ChatGPT FutureTier', 'amounts': [{'amount': local}]})
        data['markets'].append(market)
    return refresh_scoped_fixture(data)


def refresh_scoped_fixture(data):
    now = p.epoch(data['generated_at'])
    for market in data['markets']:
        for offer in market['offers']:
            for amount in offer['amounts']:
                local = Decimal(amount['amount'])
                amount['amount'] = h.decimal_text(amount['amount'])
                digits = 0 if market['currency'] == 'JPY' else 2
                amount['display'] = market['currency'] + ' ' + format(local, f'.{digits}f')
                amount['cny'] = p.converted(market, amount['amount'], data['fx'], now)
        market['offers'].sort(key=lambda offer: offer['label'])
        market['fingerprint'] = p.digest(p.semantic(market))
        market['history_baseline'] = {'at': data['generated_at'], 'snapshot': p.semantic(market)}
    revise(data)
    p.validate(data, now)
    return data


class MinimumHistoryTests(unittest.TestCase):
    def test_plan_local_fx_ignores_other_plans_currency_changes(self):
        first = scoped_fx_fixture()
        self.assertEqual(len(first['markets']), 59)
        history = h.advance_history(h.empty_history(), first)
        original = copy.deepcopy(history)
        current = scoped_fx_fixture(86400, us_price='22', jpy='151')
        updated = h.advance_history(history, current)
        event = next(event for event in updated['events'] if event['plan'] == 'ChatGPT FutureTier' and event['kind'] == 'change')
        self.assertEqual(h.winner_ids(event['from']), ['us'])
        self.assertEqual(h.winner_ids(event['to']), ['lk'])
        self.assertEqual(event['cause'], 'storefront')
        self.assertFalse(event['evidence']['fx_changed'])
        self.assertEqual(set(event['comparison']['fx']['rates']), {'USD', 'CNY'})
        self.assertEqual(history, original)
        self.assertEqual(updated['events'][:len(history['events'])], history['events'])
        self.assertTrue(h.assert_matches(updated, current))

    def test_unrelated_fx_alone_does_not_create_plan_winner_event(self):
        history = h.advance_history(h.empty_history(), scoped_fx_fixture())
        current = scoped_fx_fixture(86400, jpy='151')
        updated = h.advance_history(history, current)
        self.assertEqual([event for event in updated['events']
                          if event['plan'] == 'ChatGPT FutureTier' and event['kind'] == 'change'], [])
        related = [event for event in updated['events']
                   if event['plan'] == 'ChatGPT Plus' and event['kind'] == 'change']
        self.assertEqual(len(related), 1)
        self.assertEqual(related[0]['cause'], 'fx')
        self.assertTrue(h.assert_matches(updated, current))

    def test_relevant_cny_change_is_mixed_for_usd_plan(self):
        history = h.advance_history(h.empty_history(), scoped_fx_fixture())
        current = scoped_fx_fixture(86400, us_price='22', jpy='151', cny='8')
        updated = h.advance_history(history, current)
        event = next(event for event in updated['events'] if event['plan'] == 'ChatGPT FutureTier' and event['kind'] == 'change')
        self.assertEqual(event['cause'], 'mixed')
        self.assertTrue(event['evidence']['fx_changed'])
        self.assertTrue(h.assert_matches(updated, current))

    def test_cny_storefront_factor_stays_one_when_raw_cny_rate_changes(self):
        options = {'future_currencies': ('CNY', 'CNY')}
        history = h.advance_history(h.empty_history(), scoped_fx_fixture(**options))
        current = scoped_fx_fixture(86400, us_price='22', cny='8', **options)
        updated = h.advance_history(history, current)
        event = next(event for event in updated['events'] if event['plan'] == 'ChatGPT FutureTier' and event['kind'] == 'change')
        self.assertEqual(event['cause'], 'storefront')
        self.assertFalse(event['evidence']['fx_changed'])
        self.assertTrue(h.assert_matches(updated, current))

    def test_relevant_jpy_factor_alone_can_change_the_winner(self):
        options = {'future_currencies': ('USD', 'JPY'), 'lk_price': '3150'}
        history = h.advance_history(h.empty_history(), scoped_fx_fixture(**options))
        current = scoped_fx_fixture(86400, jpy='160', **options)
        updated = h.advance_history(history, current)
        event = next(event for event in updated['events'] if event['plan'] == 'ChatGPT FutureTier' and event['kind'] == 'change')
        self.assertEqual(h.winner_ids(event['to']), ['lk'])
        self.assertEqual(event['cause'], 'fx')
        self.assertFalse(event['evidence']['prices_changed'])
        self.assertTrue(event['evidence']['fx_changed'])
        self.assertTrue(h.assert_matches(updated, current))

    def test_equal_effective_factors_are_not_fx_changes(self):
        options = {'future_currencies': ('JPY', 'JPY'), 'lk_price': '3150'}
        history = h.advance_history(h.empty_history(), scoped_fx_fixture(us_price='3000', **options))
        current = scoped_fx_fixture(86400, us_price='3300', jpy='300', cny='14', **options)
        updated = h.advance_history(history, current)
        event = next(event for event in updated['events'] if event['plan'] == 'ChatGPT FutureTier' and event['kind'] == 'change')
        self.assertEqual(event['cause'], 'storefront')
        self.assertFalse(event['evidence']['fx_changed'])
        self.assertTrue(h.assert_matches(updated, current))

    def test_plan_local_fx_preserves_initial_scope_and_gap_classification(self):
        first = scoped_fx_fixture()
        history = h.advance_history(h.empty_history(), first)
        initial = next(event for event in history['events'] if event['plan'] == 'ChatGPT FutureTier')
        self.assertEqual(initial['cause'], 'initial')
        self.assertIsNone(initial['evidence']['fx_changed'])
        expanded = scoped_fx_fixture(86400, jpy='151')
        market = next(market for market in expanded['markets'] if market['code'] == 'ca')
        market['offers'].append({'label': 'ChatGPT FutureTier', 'amounts': [{'amount': '19'}]})
        refresh_scoped_fixture(expanded)
        scoped = h.advance_history(history, expanded)
        event = next(event for event in scoped['events'] if event['plan'] == 'ChatGPT FutureTier' and event['kind'] == 'change')
        self.assertEqual(event['cause'], 'scope')
        self.assertTrue(event['evidence']['scope_changed'])
        self.assertTrue(h.assert_matches(scoped, expanded))

        degraded = scoped_fx_fixture(43200)
        degraded['fx']['fallback'] = True
        revise(degraded)
        gap = h.advance_history(history, degraded)
        recovered_data = scoped_fx_fixture(86400, us_price='22', jpy='151')
        recovered = h.advance_history(gap, recovered_data)
        event = next(event for event in recovered['events'] if event['plan'] == 'ChatGPT FutureTier' and event['kind'] == 'change')
        self.assertEqual(event['cause'], 'unknown')
        self.assertTrue(event['evidence']['gap'])
        self.assertFalse(event['evidence']['fx_changed'])
        self.assertTrue(h.assert_matches(recovered, recovered_data))

    def test_legacy_events_are_not_reclassified_and_missing_rates_are_unknown(self):
        first = scoped_fx_fixture()
        history = h.advance_history(h.empty_history(), first)
        legacy = h.advance_history(history, scoped_fx_fixture(86400, us_price='22', jpy='151'))
        # Model the already-persisted global-FX attribution without rewriting it.
        event = next(event for event in legacy['events'] if event['plan'] == 'ChatGPT FutureTier' and event['kind'] == 'change')
        event['evidence']['fx_changed'] = True
        event['cause'] = 'mixed'
        h.validate_history(legacy)
        original = copy.deepcopy(legacy)
        current = scoped_fx_fixture(2 * 86400, jpy='152')
        updated = h.advance_history(legacy, current)
        self.assertEqual(legacy, original)
        self.assertEqual(updated['events'][:len(legacy['events'])], legacy['events'])
        self.assertEqual(updated['events'][-1]['cause'], 'storefront')
        self.assertTrue(h.assert_matches(updated, current))

        missing = copy.deepcopy(history)
        del missing['checkpoint']['fx']['rates']['CNY']
        h.validate_history(missing)
        current = scoped_fx_fixture(86400, us_price='22')
        updated = h.advance_history(missing, current)
        event = next(event for event in updated['events'] if event['plan'] == 'ChatGPT FutureTier' and event['kind'] == 'change')
        self.assertEqual(event['cause'], 'unknown')
        self.assertIsNone(event['evidence']['fx_changed'])
        self.assertTrue(h.assert_matches(updated, current))

    def test_unreadable_git_versions_fail_closed_instead_of_hiding_a_gap(self):
        first = fixture()
        latest = fixture(86400)
        first_sha, broken_sha, last_sha = ('a' * 40, 'b' * 40, 'c' * 40)
        for broken in ('{ invalid JSON', json.dumps({'generated_at': 'not-a-timestamp'}), '{}', 'missing-price-file', 'missing-git-object'):
            with self.subTest(broken=broken), tempfile.TemporaryDirectory() as directory:
                project = Path(directory) / 'repo/tools/chatgpt_price_comparison'
                data_dir = project / 'data'
                data_dir.mkdir(parents=True)
                price_path = data_dir / 'prices.json'
                price_bytes = json.dumps(latest).encode()
                price_path.write_bytes(price_bytes)
                def git_output(args, **kwargs):
                    if args[1] == 'rev-parse':
                        return 'false\n'
                    if args[1] == 'log':
                        return '\n'.join((first_sha, broken_sha, last_sha)) + '\n'
                    if args[1] == 'ls-tree':
                        return h.PRICE_PATH + '\n'
                    self.assertEqual(args[1], 'show')
                    if args[2].startswith(first_sha):
                        return json.dumps(first)
                    if args[2].startswith(last_sha):
                        return json.dumps(latest)
                    if broken in ('missing-price-file', 'missing-git-object'):
                        raise subprocess.CalledProcessError(128, args)
                    return broken
                with patch.object(h.subprocess, 'check_output', side_effect=git_output):
                    with self.assertRaisesRegex(ValueError, 'unreadable or invalid Git price snapshot: ' + broken_sha):
                        h.backfill_history(project_dir=project)
                self.assertEqual(price_path.read_bytes(), price_bytes)
                self.assertFalse((data_dir / 'minimum-history.json').exists())

    def test_proven_deletion_marks_gap_including_same_snapshot_restoration(self):
        def data_at(offset, cheaper):
            data = fixture(offset)
            second = copy.deepcopy(data['markets'][0])
            second.update(code='jp', name='Japan', source_url=p.url_for('jp'))
            for offer in second['offers']:
                for amount in offer['amounts']:
                    local = Decimal(amount['amount']) * (1 if cheaper else 2)
                    amount['amount'] = format(local.normalize(), 'f')
                    amount['display'] = 'USD ' + format(local, '.2f')
                    amount['cny'] = p.converted(second, amount['amount'], data['fx'], p.epoch(data['generated_at']))
            second['fingerprint'] = p.digest(p.semantic(second))
            data['markets'].append(second)
            revise(data)
            p.validate(data, NOW + 86400)
            return data
        first, current = data_at(0, False), data_at(86400, True)
        for restore_same, trailing_deletion in ((False, False), (True, False), (False, True)):
            with self.subTest(restore_same=restore_same, trailing_deletion=trailing_deletion), tempfile.TemporaryDirectory() as directory:
                repo = Path(directory)
                project = repo / 'tools/chatgpt_price_comparison'
                path = project / 'data/prices.json'
                path.parent.mkdir(parents=True)
                def git(*args):
                    return subprocess.check_output(['git', *args], cwd=repo, text=True, stderr=subprocess.DEVNULL).strip()
                git('init', '-b', 'main')
                git('config', 'gc.auto', '0')
                git('config', 'user.name', 'Fixture')
                git('config', 'user.email', 'fixture@example.invalid')
                def save(data, message):
                    if data is None:
                        path.unlink()
                    else:
                        path.write_text(json.dumps(data))
                    git('add', '-A')
                    git('-c', 'commit.gpgSign=false', 'commit', '-m', message)
                save(first, 'A verified prices')
                save(None, 'Published price artifact deleted')
                if restore_same:
                    save(first, 'Restore A without inventing a later observation')
                if trailing_deletion:
                    path.write_text(json.dumps(current))
                else:
                    save(current, 'C verified prices')
                history, _ = h.backfill_history(project_dir=project)
                self.assertEqual(history['excluded_versions'], 1)
                self.assertEqual(history['gaps'], [{'from': first['generated_at'], 'to': current['generated_at']}])
                changes = [event for event in history['events'] if event['kind'] == 'change']
                self.assertTrue(changes)
                self.assertTrue(all(event['evidence']['gap'] and event['cause'] == 'unknown' for event in changes))
                self.assertFalse(history['pending_gap'])
                self.assertTrue(h.assert_matches(history, current))

    def test_history_rejects_timestamps_outside_its_observation_bounds(self):
        data=fixture()
        baseline=h.advance_history(h.empty_history(),data)
        cases=[]
        future=copy.deepcopy(baseline)
        future['events'][-1]['at']=p.stamp(NOW+86400)
        cases.append(future)
        gap=copy.deepcopy(baseline)
        gap['gaps']=[{'from':p.stamp(NOW-1),'to':p.stamp(NOW+86400)}]
        cases.append(gap)
        checkpoint=copy.deepcopy(baseline)
        checkpoint['pending_gap']=True
        checkpoint['checkpoint']['at']=p.stamp(NOW+3600)
        cases.append(checkpoint)
        backwards=copy.deepcopy(baseline)
        backwards['pending_gap']=True
        backwards['checked_at']=p.stamp(NOW-1)
        cases.append(backwards)
        no_checkpoint=copy.deepcopy(baseline)
        no_checkpoint.update(checkpoint=None,observations=0,first_observed_at=None,pending_gap=True)
        cases.append(no_checkpoint)
        for index,value in enumerate(cases):
            with self.subTest(index=index):
                with self.assertRaises(ValueError):
                    h.validate_history(value)
        self.assertTrue(h.assert_matches(baseline,data))

    def test_candidate_check_rejects_future_events_without_changing_prices(self):
        data=fixture()
        ledger=h.advance_history(h.empty_history(),data)
        ledger['events'][-1]['at']=p.stamp(NOW+86400)
        with self.assertRaises(ValueError):
            h.assert_matches(ledger,data)

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
                    amount['cny']=p.converted(second, amount['amount'], data['fx'], p.epoch(data['generated_at']))
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
        plan['amounts'][0]['cny']=p.converted(market, '1', changed['fx'], p.epoch(changed['generated_at']))
        market['fingerprint']=p.digest(p.semantic(market))
        revise(changed)
        updated=h.advance_history(same,changed)
        changes=[e for e in updated['events'] if e['kind']=='change']
        self.assertTrue(changes)
        self.assertEqual(changes[-1]['to'][0]['code'],'jp')
        self.assertEqual(changes[-1]['cause'],'storefront')

    def test_known_plan_rename_keeps_same_history_identity(self):
        first=fixture()
        history=h.advance_history(h.empty_history(), first)
        before_events=len(history['events'])

        renamed=fixture(86400)
        for market in renamed['markets']:
            for offer in market['offers']:
                if offer['label']=='ChatGPT Pro 20x':
                    offer['label']='ChatGPT Pro $200'
            market['fingerprint']=p.digest(p.semantic(market))
        revise(renamed)

        updated=h.advance_history(history, renamed)
        self.assertEqual(len(updated['events']), before_events)
        self.assertIn('ChatGPT Pro 20x', [plan['id'] for plan in updated['checkpoint']['plans']])
        self.assertNotIn('ChatGPT Pro $200', [plan['id'] for plan in updated['checkpoint']['plans']])
        self.assertTrue(h.assert_matches(updated, renamed))

    def test_same_storefront_duplicate_aliases_make_minimum_snapshot_unreliable(self):
        data=fixture()
        market=data['markets'][0]
        original=next(offer for offer in market['offers'] if offer['label']=='ChatGPT Pro 20x')
        duplicate=copy.deepcopy(original)
        duplicate['label']='ChatGPT Pro $200'
        market['offers'].append(duplicate)
        market['fingerprint']=p.digest(p.semantic(market))
        revise(data)
        self.assertIsNone(h.build_snapshot(data))

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


    def test_backfill_is_reproducible_in_self_contained_git_fixture(self):
        with tempfile.TemporaryDirectory() as temp:
            repo=Path(temp)/'repo'
            project=repo/'tools/chatgpt_price_comparison'
            data_dir=project/'data'
            data_dir.mkdir(parents=True)
            def git(*args, cwd=repo):
                return subprocess.check_output(
                    ['git', *args], cwd=cwd, text=True, stderr=subprocess.DEVNULL,
                    env={**__import__('os').environ, 'GIT_CONFIG_NOSYSTEM':'1'}
                ).strip()
            subprocess.check_call(['git','init','--initial-branch=main'],cwd=repo,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            # Keep this tiny throwaway repository deterministic. Some Git builds
            # may launch auto-gc after commits, which can race TemporaryDirectory
            # cleanup after every assertion has already passed.
            git('config','gc.auto','0')
            def save(data, message):
                (data_dir/'prices.json').write_text(json.dumps(data),encoding='utf-8')
                git('add','.')
                subprocess.check_call(
                    ['git','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
                     '-c','commit.gpgSign=false','commit','-m',message],
                    cwd=repo,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL
                )
            first=fixture()
            degraded=fixture(43200)
            degraded['fx']['fallback']=True
            revise(degraded)
            second=fixture(86400)
            save(first,'first observation')
            save(degraded,'unreliable fallback observation')
            save(second,'second observation')
            actual, versions=h.backfill_history(project_dir=project)
            again, again_versions=h.backfill_history(project_dir=project)
            self.assertEqual(versions,3)
            self.assertEqual(again_versions,3)
            self.assertEqual(actual,again)
            self.assertEqual(actual['observations'],2)
            self.assertEqual(actual['excluded_versions'],1)
            self.assertEqual(len(actual['gaps']),1)
            self.assertFalse(actual['pending_gap'])
            self.assertTrue(h.assert_matches(actual,second))


class CauseLabelPresentationTests(unittest.TestCase):
    def test_frontend_cause_classification_matches_backend(self):
        import itertools
        cases = []
        for gap, scope, prices, fx in itertools.product([False, True], [False, True], [False, True], [False, True, None]):
            evidence = dict(gap=gap, scope_changed=scope, prices_changed=prices, fx_changed=fx)
            cases.append(dict(evidence=evidence, expected=h.cause_for(evidence)))
        script = r"""
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(process.argv[1], 'utf8');
const match = source.match(/  function minimumHistoryCause\(evidence\) \{[\s\S]*?\n  \}/);
assert.ok(match);
const classify = runInNewContext('(' + match[0].trim() + ')');
for (const {evidence, expected} of JSON.parse(process.argv[2])) {
  assert.equal(classify(evidence), expected, JSON.stringify(evidence));
}
"""
        subprocess.run(['node', '--input-type=module', '-e', script, str(p.ROOT / 'app.js'), json.dumps(cases)],
                       check=True, capture_output=True, text=True, timeout=10)


    def test_gap_fx_label_is_visible_and_strictly_evidence_guarded(self):
        script = r"""
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(process.argv[1], 'utf8');
const match = source.match(/  function minimumHistoryCauseLabel\(event\) \{[\s\S]*?\n  \}/);
assert.ok(match);
const label = runInNewContext('(' + match[0].trim() + ')', { MINIMUM_CAUSE_LABELS: {unknown:'原因未能确定',fx:'汇率变化'} });
const evidence = {prices_changed:false,scope_changed:false,fx_changed:true,gap:true};
assert.equal(label({cause:'unknown',evidence}), '汇率等因素');
for (const [key,value] of [['prices_changed',true],['scope_changed',true],['fx_changed',false],['fx_changed',null],['prices_changed','false']]) {
  assert.equal(label({cause:'unknown',evidence:{...evidence,[key]:value}}), '记录缺口');
}
assert.equal(label({cause:'unknown',evidence:{...evidence,gap:false}}), '原因未能确定');
assert.equal(label({cause:'unknown',evidence:{}}),'原因未能确定');
assert.equal(label({cause:'fx',evidence}),'汇率变化');
assert.match(source, /minimumHistoryNode\('span', minimumHistoryCauseLabel\(event\), 'minimum-history-cause'\)/);
"""
        subprocess.run(['node', '--input-type=module', '-e', script, str(p.ROOT / 'app.js')],
                       check=True, capture_output=True, text=True, timeout=10)



if __name__ == '__main__':
    unittest.main()
