import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import minimum_history
import pipeline as p
from test_pipeline import data_fixture, revise, NOW


class RetainedFxTests(unittest.TestCase):
    def baseline(self, root):
        config = [{'code': code, 'name': code.upper()} for code in ['us','gb','ca','au','nz','in','sg','ph','ae','za']]
        data = data_fixture()
        base = data['markets'][0]
        data['markets'] = []
        for item in config:
            market = copy.deepcopy(base)
            market.update(code=item['code'], name=item['name'], source_url=p.url_for(item['code']))
            data['markets'].append(market)
        revise(data)
        (root/'data').mkdir()
        (root/'markets.json').write_text(json.dumps(config))
        (root/'data/prices.json').write_text(json.dumps(data))
        history = minimum_history.advance_history(minimum_history.empty_history(), data)
        (root/'data/minimum-history.json').write_text(json.dumps(history))
        for relative in ['index.template.html','app.js','style.css','vendor/lucide-subset.js']:
            destination = root/relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((p.ROOT/relative).read_bytes())
        return data, config, history

    def failed(self, item, old, now, getter, **kwargs):
        market = copy.deepcopy(old)
        market.update(status='retained', last_checked_at=p.stamp(now),
                      error='http_503', error_detail='Synthetic unavailable source')
        if item['code'] == 'us':
            # One successful new observation must not sneak into a rejected batch.
            market['status'] = 'verified'
            market['last_verified_at'] = p.stamp(now)
            market['offers'][0]['amounts'][0]['amount'] = '1'
        return market

    def test_whole_baseline_fx_refresh_preserves_price_dates_and_history(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old, config, history = self.baseline(root)
            fx = copy.deepcopy(old['fx'])
            fx.update(updated_at=p.stamp(NOW+3600), fallback=False)
            fx['rates']['CNY'] = '8'
            deadlines = []
            def observed(*args, **kwargs):
                args[3]('https://example.test/price')
                return self.failed(*args, **kwargs)
            def collected(now, old_fx, getter, required):
                getter(p.FX_URL)
                return fx
            def fetched(url, **kwargs):
                deadlines.append((url, kwargs['deadline']))
                return ''
            with patch.object(p, 'ROOT', root), patch.object(p, 'observe', side_effect=observed), patch.object(p, 'collect_fx', side_effect=collected), patch.object(p, 'fetch', side_effect=fetched):
                actual = p.run(root/'candidate', NOW+3600)
            source_deadline = next(deadline for url, deadline in deadlines if url != p.FX_URL)
            fx_deadline = next(deadline for url, deadline in deadlines if url == p.FX_URL)
            self.assertEqual(fx_deadline - source_deadline, 45)
            self.assertTrue(all(m['status'] == 'retained' for m in actual['markets']))
            self.assertEqual(actual['changes'], old['changes'])
            for before, after in zip(old['markets'], actual['markets']):
                self.assertEqual(p.semantic(before), p.semantic(after))
                self.assertEqual(before['last_verified_at'], after['last_verified_at'])
                for offer in after['offers']:
                    for amount in offer['amounts']:
                        self.assertEqual(amount['cny'], p.converted(after, amount['amount'], fx, NOW+3600))
            recorded = json.loads((root/'candidate/minimum-history.json').read_text())
            self.assertEqual(recorded['events'], history['events'])
            self.assertEqual(recorded['checkpoint'], history['checkpoint'])
            self.assertTrue(recorded['pending_gap'])
            self.assertEqual(json.loads((root/'data/prices.json').read_text()), old)
            # Simulate atomic publication, then a genuine source recovery.
            for name in ['prices.json', 'minimum-history.json']:
                (root/'data'/name).write_bytes((root/'candidate'/name).read_bytes())
            recovered_fx = dict(fx, updated_at=p.stamp(NOW+7200))
            def recovered(item, prior, now, getter, **kwargs):
                market = copy.deepcopy(prior)
                market.update(status='verified', last_checked_at=p.stamp(now), last_verified_at=p.stamp(now))
                for key in ['error', 'error_detail', 'pending']:
                    market.pop(key, None)
                return market
            with patch.object(p,'ROOT',root), patch.object(p,'observe',side_effect=recovered), patch.object(p,'collect_fx',return_value=recovered_fx):
                recovered_data = p.run(root/'recovered', NOW+7200)
            recovered_history = json.loads((root/'recovered/minimum-history.json').read_text())
            self.assertTrue(all(m['status'] == 'verified' for m in recovered_data['markets']))
            self.assertEqual(recovered_data['changes'], old['changes'])
            self.assertFalse(recovered_history['pending_gap'])
            self.assertEqual(recovered_history['events'][:len(history['events'])], history['events'])

    def test_source_and_fx_failure_leave_production_untouched(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old, _, _ = self.baseline(root)
            stale_fx = dict(old['fx'], fallback=True)
            with patch.object(p, 'ROOT', root), patch.object(p, 'observe', side_effect=self.failed), patch.object(p, 'collect_fx', return_value=stale_fx):
                with self.assertRaisesRegex(ValueError, 'existing publication left untouched'):
                    p.run(root/'candidate', NOW+3600)
            self.assertFalse((root/'candidate').exists())
            self.assertEqual(json.loads((root/'data/prices.json').read_text()), old)

    def test_retained_batch_preserves_prior_change_pending_and_unavailable(self):
        old=data_fixture()
        current=old['markets'][0]
        before=p.semantic(current)
        before['offers'][0]['amounts']=['7']
        current['history_baseline']={'at':p.stamp(NOW-86400),'snapshot':before}
        old['changes']=[{'code':'us','at':p.stamp(NOW-60),'before':before,'after':p.semantic(current)}]
        pending=copy.deepcopy(current)
        pending.update(code='jp',name='日本',source_url=p.url_for('jp'),status='pending',
                       pending={'fingerprint':'b'*64,'since':p.stamp(NOW-60),'reason':'plan_added'})
        pending.pop('history_baseline')
        unavailable={'code':'de','name':'德国','source_url':p.url_for('de'),
                     'last_checked_at':p.stamp(NOW),'status':'unavailable','offers':[]}
        old['markets'].extend([pending,unavailable])
        revise(old)
        p.validate(old,NOW)
        retained=p.retained_batch(old,old['markets'],{'us','jp','de'},NOW+3600)
        self.assertEqual(retained[0]['history_baseline'],current['history_baseline'])
        self.assertEqual(retained[1]['pending'],pending['pending'])
        self.assertEqual(retained[2]['offers'],[])
        self.assertEqual(retained[2]['status'],'unavailable')
        result=copy.deepcopy(old)
        result.update(markets=retained,generated_at=p.stamp(NOW+3600))
        revise(result)
        p.validate(result,NOW+3600)
        self.assertEqual(result['changes'],old['changes'])

    def test_corrupt_baseline_is_rejected_before_fetch(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            old, _, _=self.baseline(root)
            old['revision']='0'*64
            (root/'data/prices.json').write_text(json.dumps(old))
            with patch.object(p,'ROOT',root), patch.object(p,'observe') as observe, patch.object(p,'collect_fx') as collect:
                with self.assertRaises(ValueError):
                    p.run(root/'candidate', NOW+3600)
                observe.assert_not_called()
                collect.assert_not_called()
            self.assertFalse((root/'candidate').exists())

    def test_missing_or_changed_baseline_cannot_enter_fx_only_path(self):
        data = data_fixture()
        with self.assertRaises(ValueError):
            p.retained_batch(None, [], {'us'}, NOW)
        with self.assertRaises(ValueError):
            p.retained_batch(data, data['markets'], {'us','jp'}, NOW)

    def test_summary_is_bounded_single_line_and_distinguishes_pending(self):
        market = data_fixture()['markets'][0]
        market.update(status='pending', pending={'reason':'plan_added'})
        summary = p.source_summary([market]*50, {'fallback':True})
        self.assertIn('待复核 50', summary)
        self.assertIn('plan_added', summary)
        self.assertIn('源日期未改变', summary)
        self.assertLessEqual(len(summary), 700)
        self.assertNotIn('\n', summary)

    def test_coverage_failure_emits_source_summary_before_rejection(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, _, _ = self.baseline(root)
            (root/'data/prices.json').unlink()
            def unavailable(item, old, now, getter, **kwargs):
                return {'code':item['code'],'name':item['name'],'source_url':p.url_for(item['code']),
                        'last_checked_at':p.stamp(now),'status':'unavailable','offers':[],
                        'error':'http_503','error_detail':'Synthetic outage'}
            output = root/'github-output'
            with patch.object(p,'ROOT',root), patch.object(p,'observe',side_effect=unavailable), patch.dict(os.environ, {'GITHUB_OUTPUT':str(output)}):
                with self.assertRaises(ValueError):
                    p.run(root/'candidate', NOW+3600)
            self.assertIn('source_summary=', output.read_text())
            self.assertIn('http_503', output.read_text())


if __name__ == '__main__':
    unittest.main()
