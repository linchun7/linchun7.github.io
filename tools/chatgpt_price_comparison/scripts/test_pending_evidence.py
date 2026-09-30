import copy
import json
import subprocess
import unittest

import pipeline as p
from test_pipeline import NOW, data_fixture, fixture, revise


CONFIG = {'code': 'us', 'name': 'United States'}


def source(label='ChatGPT Pro 100', price='$500.00', *, duplicate=False):
    pairs = [[label, '$100.00'], ['ChatGPT Pro 500', price]]
    if duplicate:
        pairs.append(['ChatGPT Pro 5x', '$100.00'])
    return fixture(pairs=pairs)


class PendingEvidenceTests(unittest.TestCase):
    def baseline(self):
        return p.observe(CONFIG, None, NOW, lambda *a, **kw: fixture(pairs=[['ChatGPT Pro 5x', '$100.00']]))

    def waiting(self):
        return p.observe(CONFIG, self.baseline(), NOW + 60, lambda *a, **kw: source())

    def test_reviewed_alias_changes_preserve_pending_clock_and_raw_evidence(self):
        first = self.waiting()
        since = first['pending']['since']
        later = p.observe(CONFIG, first, NOW + 60 + 3600, lambda *a, **kw: source('ChatGPT Pro $100'))
        self.assertEqual(later['status'], 'pending')
        self.assertEqual(later['pending']['since'], since)
        self.assertNotEqual(later['pending']['fingerprint'], first['pending']['fingerprint'])
        self.assertEqual(later['pending']['comparison_fingerprint'], first['pending']['comparison_fingerprint'])
        too_early = p.observe(CONFIG, later, NOW + 60 + p.PENDING_CONFIRMATION_SECONDS - 1, lambda *a, **kw: source('ChatGPT Pro 100'))
        self.assertEqual(too_early['status'], 'pending')
        self.assertEqual(too_early['pending']['since'], since)
        accepted = p.observe(CONFIG, too_early, NOW + 60 + p.PENDING_CONFIRMATION_SECONDS, lambda *a, **kw: source('ChatGPT Pro $100'))
        self.assertEqual(accepted['status'], 'verified')
        self.assertNotIn('pending', accepted)
        self.assertIn('ChatGPT Pro 500', [offer['label'] for offer in accepted['offers']])

    def test_real_candidate_change_or_duplicate_alias_resets_clock(self):
        first = self.waiting()
        changed_currency = fixture(currency='EUR', pairs=[['ChatGPT Pro 100', '€100.00'], ['ChatGPT Pro 500', '€500.00']])
        for text in (source(price='$550.00'), source(duplicate=True), source().replace('ChatGPT Pro 500', 'ChatGPT Pro 501'), changed_currency):
            with self.subTest(text=text):
                changed = p.observe(CONFIG, first, NOW + 60 + p.PENDING_CONFIRMATION_SECONDS, lambda *a, **kw: text)
                self.assertEqual(changed['status'], 'pending')
                self.assertEqual(changed['pending']['since'], p.stamp(NOW + 60 + p.PENDING_CONFIRMATION_SECONDS))
                self.assertNotEqual(changed['pending']['comparison_fingerprint'], first['pending']['comparison_fingerprint'])

    def test_ambiguous_alias_set_changes_are_not_collapsed(self):
        first = p.observe(CONFIG, self.baseline(), NOW + 60, lambda *a, **kw: source(duplicate=True))
        different_alias_set = source(duplicate=True).replace('ChatGPT Pro 5x', 'ChatGPT Pro 5X')
        next_observation = p.observe(CONFIG, first, NOW + 60 + p.PENDING_CONFIRMATION_SECONDS, lambda *a, **kw: different_alias_set)
        self.assertEqual(next_observation['status'], 'pending')
        self.assertEqual(next_observation['pending']['reason'], 'ambiguous_identity')
        self.assertEqual(next_observation['pending']['since'], p.stamp(NOW + 60 + p.PENDING_CONFIRMATION_SECONDS))
        self.assertNotEqual(next_observation['pending']['comparison_fingerprint'], first['pending']['comparison_fingerprint'])

    def test_baseline_response_cannot_singly_clear_pending_or_retained_evidence(self):
        waiting = self.waiting()
        baseline = fixture(pairs=[['ChatGPT Pro 5x', '$100.00']])
        for status in ('pending', 'retained'):
            old = copy.deepcopy(waiting)
            old['status'] = status
            calls = []
            def getter(*a, **kw):
                calls.append(kw.get('confirm', False))
                return source() if kw.get('confirm') else baseline
            result = p.observe(CONFIG, old, NOW + 60 + p.PENDING_CONFIRMATION_SECONDS, getter)
            self.assertEqual(calls, [False, True])
            self.assertEqual(result['status'], 'retained')
            self.assertEqual(result['pending'], old['pending'])
            self.assertEqual(result['last_verified_at'], old['last_verified_at'])
            self.assertEqual(result['offers'], old['offers'])

    def test_confirmed_recovery_to_baseline_clears_pending(self):
        old = self.waiting()
        baseline = fixture(pairs=[['ChatGPT Pro 5x', '$100.00']])
        calls = []
        def getter(*a, **kw):
            calls.append(kw.get('confirm', False))
            return baseline
        recovered = p.observe(CONFIG, old, NOW + 3600, getter)
        self.assertEqual(calls, [False, True])
        self.assertEqual(recovered['status'], 'verified')
        self.assertNotIn('pending', recovered)

    def test_legacy_pending_is_conservative_and_upgraded_on_exact_raw_match(self):
        first = self.waiting()
        del first['pending']['comparison_fingerprint']
        same = p.observe(CONFIG, first, NOW + 3600, lambda *a, **kw: source())
        self.assertEqual(same['pending']['since'], first['pending']['since'])
        self.assertIn('comparison_fingerprint', same['pending'])
        renamed = p.observe(CONFIG, first, NOW + 3600, lambda *a, **kw: source('ChatGPT Pro $100'))
        self.assertEqual(renamed['pending']['since'], p.stamp(NOW + 3600))

    def test_optional_comparison_fingerprint_contract(self):
        for value in (None, 'a' * 64):
            data = data_fixture()
            market = data['markets'][0]
            market['status'] = 'pending'
            market['pending'] = {'fingerprint': 'b' * 64, 'since': market['last_checked_at']}
            if value is not None:
                market['pending']['comparison_fingerprint'] = value
            revise(data)
            p.validate(data, NOW)
        for value in (None, True, 123, 'not-a-hash', 'a' * 63):
            data = data_fixture()
            market = data['markets'][0]
            market['status'] = 'pending'
            market['pending'] = {'fingerprint': 'b' * 64, 'since': market['last_checked_at'], 'comparison_fingerprint': value}
            revise(data)
            with self.assertRaises(ValueError):
                p.validate(data, NOW)

    def test_browser_comparison_fingerprint_contract(self):
        # Exercise the pure validators from the actual app, without a DOM or
        # network. Browser interaction stays in the browser acceptance suite.
        script = r'''
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const app = readFileSync(process.argv[1], 'utf8');
const source = app.slice(app.indexOf('  const STATUS ='), app.indexOf('  const $ ='))
  + app.slice(app.indexOf('  const canonical ='), app.indexOf('  const age ='))
  + app.slice(app.indexOf('  function validateHistorySnapshot('), app.indexOf('  async function verifyRevision('))
  + '\nglobalThis.validateSnapshot = validate;';
const context = {};
vm.runInNewContext(source, context);
const base = JSON.parse(readFileSync(0, 'utf8'));
for (const value of [undefined, 'a'.repeat(64), null, true, 123, 'not-a-hash', 'a'.repeat(63)]) {
  const data = structuredClone(base);
  if (value !== undefined) data.markets[0].pending.comparison_fingerprint = value;
  let accepted = true;
  try { context.validateSnapshot(data); } catch { accepted = false; }
  if (accepted !== (value === undefined || value === 'a'.repeat(64))) {
    throw new Error('Unexpected browser pending contract result for ' + String(value));
  }
}
'''
        data = data_fixture()
        market = data['markets'][0]
        market['status'] = 'pending'
        market['pending'] = {'fingerprint': 'b' * 64, 'since': market['last_checked_at']}
        revise(data)
        subprocess.run(['node', '--input-type=module', '-e', script, str(p.ROOT / 'app.js')], input=json.dumps(data), text=True, check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
