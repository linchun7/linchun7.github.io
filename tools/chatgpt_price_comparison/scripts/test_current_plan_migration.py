import unittest
import pipeline as p
from test_pipeline import NOW, fixture
OLD_PAIRS = [['ChatGPT Go','$8.00'],['ChatGPT Plus','$19.99'],['ChatGPT Plus','$200.00'],['ChatGPT Pro 5x','$100.00'],['ChatGPT Pro 20x','$200.00']]
RENAMED_PAIRS = [['ChatGPT Go','$8.00'],['ChatGPT Plus','$19.99'],['ChatGPT Plus','$200.00'],['ChatGPT Pro 100','$100.00'],['ChatGPT Pro 200','$200.00']]
CONFIG = {'code':'us','name':'美国'}
class CurrentPlanMigrationTests(unittest.TestCase):
    def baseline(self):
        return p.observe(CONFIG, None, NOW, lambda *args, **kwargs: fixture(pairs=OLD_PAIRS))
    def test_documented_rename_preserves_price_series_and_raw_label(self):
        old = self.baseline()
        calls = []
        def getter(*args, **kwargs):
            calls.append(kwargs.get('confirm', False))
            return fixture(pairs=RENAMED_PAIRS)
        new = p.observe(CONFIG, old, NOW + 60, getter)
        self.assertEqual(calls, [False, True])
        self.assertEqual(new['status'], 'verified')
        self.assertNotIn('pending', new)
        self.assertFalse(p.should_record_history_change(old, new))
        self.assertEqual([offer['label'] for offer in new['offers']], ['ChatGPT Go','ChatGPT Plus','ChatGPT Pro 100','ChatGPT Pro 200'])
    def test_new_500_plan_still_waits_for_full_pending_window(self):
        old = self.baseline()
        getter = lambda *args, **kwargs: fixture(pairs=RENAMED_PAIRS + [['ChatGPT Pro 500','$500.00']])
        first_at = NOW + 60
        pending = p.observe(CONFIG, old, first_at, getter)
        self.assertEqual(pending['status'], 'pending')
        self.assertEqual(pending['pending']['reason'], 'plan_added')
        self.assertEqual(pending['offers'], old['offers'])
        self.assertEqual(pending['last_verified_at'], old['last_verified_at'])
        self.assertNotIn('ChatGPT Pro 500', [offer['label'] for offer in pending['offers']])
        too_early = p.observe(CONFIG, pending, first_at + p.PENDING_CONFIRMATION_SECONDS - 1, getter)
        self.assertEqual(too_early['status'], 'pending')
        self.assertEqual(too_early['pending'], pending['pending'])
        accepted = p.observe(CONFIG, too_early, first_at + p.PENDING_CONFIRMATION_SECONDS, getter)
        self.assertEqual(accepted['status'], 'verified')
        self.assertNotIn('pending', accepted)
        self.assertIn('ChatGPT Pro 500', [offer['label'] for offer in accepted['offers']])
        self.assertTrue(p.should_record_history_change(old, accepted))
    def test_plus_minimum_never_comes_from_another_plan(self):
        market = self.baseline()
        plus = next(o for o in market['offers'] if o['label']=='ChatGPT Plus')
        pro = next(o for o in market['offers'] if o['label']=='ChatGPT Pro 20x')
        pro['amounts'] = [{'amount':'1','display':'$1.00'}]
        self.assertEqual(p.display_amounts(plus)[0]['amount'], '19.99')
        plus['amounts'] = [{'amount':'29.99','display':'$29.99'},{'amount':'200','display':'$200.00'}]
        self.assertEqual(p.display_amounts(plus)[0]['amount'], '29.99')
if __name__ == '__main__': unittest.main()
