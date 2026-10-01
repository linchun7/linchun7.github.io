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


class MinimumHistoryTests(unittest.TestCase):
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
    def test_gap_fx_label_is_short_and_strictly_evidence_guarded(self):
        script = "import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport { runInNewContext } from 'node:vm';\nconst source = readFileSync(process.argv[1], 'utf8');\nconst match = source.match(/  function minimumHistoryCauseLabel\\(event\\) \\{[\\s\\S]*?\\n  \\}/);\nassert.ok(match);\nconst label = runInNewContext('(' + match[0].trim() + ')', { MINIMUM_CAUSE_LABELS: {unknown:'原因未能确定',fx:'汇率变化'} });\nconst evidence = {prices_changed:false,scope_changed:false,fx_changed:true,gap:true};\nassert.equal(label({cause:'unknown',evidence}), '汇率等因素');\nfor (const [key,value] of [['prices_changed',true],['scope_changed',true],['fx_changed',false],['fx_changed',null],['gap',false],['prices_changed','false']]) {\n  assert.equal(label({cause:'unknown',evidence:{...evidence,[key]:value}}), '原因未能确定');\n}\nassert.equal(label({cause:'unknown',evidence:{}}),'原因未能确定');\nassert.equal(label({cause:'fx',evidence}),'汇率变化');\nassert.match(source, /minimumHistoryNode\\('span', minimumHistoryCauseLabel\\(event\\), 'minimum-history-cause'\\)/);\n"
        subprocess.run(['node', '--input-type=module', '-e', script, str(p.ROOT / 'app.js')],
                       check=True, capture_output=True, text=True, timeout=10)


if __name__ == '__main__':
    unittest.main()
