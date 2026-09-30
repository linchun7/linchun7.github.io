import copy
import json
import tempfile
import time
import unittest
from pathlib import Path

import pipeline as p
import reviewed_confirmation as review
from test_pipeline import fixture


class ReviewedConfirmationTests(unittest.TestCase):
    def setUp(self):
        self.now = int(time.time())
        self.config = {'code': 'us', 'name': '美国'}
        self.source = fixture(pairs=[['ChatGPT Plus', '$19.99'], ['ChatGPT Go', '$8.00'],
            ['ChatGPT Plus', '$200.00'], ['ChatGPT Pro 500', '$500.00'], ['100 Credits', '$4.00']])
        old = p.observe(self.config, None, self.now - 3600, lambda *a, **k: fixture())
        self.pending = p.observe(self.config, old, self.now - 1800, lambda *a, **k: self.source)
        self.candidate = p.parse_store(self.source, 'us')
        self.batch = {'schema': 1, 'reason': 'plan_added',
            'reviewed_at': p.stamp(self.now - 10), 'expires_at': p.stamp(self.now + 3600),
            'evidence_url': 'https://github.com/linchun7/linchun7.github.io/actions/runs/36790877836',
            'markets': {'us': {'before_fingerprint': old['fingerprint'],
                'candidate_fingerprint': self.candidate['fingerprint'],
                'pending_since': self.pending['pending']['since']}}}

    def test_default_wait_remains_eighteen_hours(self):
        self.assertEqual(p.PENDING_CONFIRMATION_SECONDS, 18 * 3600)
        result = p.observe(self.config, self.pending, self.now, lambda *a, **k: self.source)
        self.assertEqual(result['status'], 'pending')
        self.assertEqual(result['pending']['since'], self.pending['pending']['since'])

    def test_exact_review_accepts_only_after_independent_double_fetch(self):
        calls = []
        def getter(*args, **kwargs):
            calls.append(kwargs.get('confirm', False))
            return self.source
        result = p.observe(self.config, self.pending, self.now, getter, reviews=self.batch)
        self.assertEqual(calls, [False, True])
        self.assertEqual(result['status'], 'verified')
        self.assertEqual(result['fingerprint'], self.candidate['fingerprint'])
        self.assertEqual(result['last_verified_at'], p.stamp(self.now))
        self.assertNotIn('pending', result)

    def test_source_disagreement_still_retains_old_data(self):
        sources = iter([self.source, fixture()])
        result = p.observe(self.config, self.pending, self.now,
            lambda *a, **k: next(sources), reviews=self.batch)
        self.assertEqual(result['status'], 'retained')
        self.assertEqual(result['offers'], self.pending['offers'])

    def test_a_different_candidate_is_not_approved(self):
        changed = self.source.replace('$500.00', '$501.00')
        result = p.observe(self.config, self.pending, self.now,
            lambda *a, **k: changed, reviews=self.batch)
        self.assertEqual(result['status'], 'pending')
        self.assertEqual(result['pending']['since'], p.stamp(self.now))

    def test_boundaries_and_exact_evidence_cannot_be_reused(self):
        for now in (self.now - 11, self.now + 3600, self.now + 3601):
            self.assertFalse(review.allows(self.batch, 'us', self.pending, self.candidate, 'plan_added', now))
        self.assertFalse(review.allows(self.batch, 'gb', self.pending, self.candidate, 'plan_added', self.now))
        self.assertFalse(review.allows(self.batch, 'us', self.pending, self.candidate, 'currency_change', self.now))
        for field, value in [('fingerprint', '0' * 64), ('status', 'verified')]:
            old = copy.deepcopy(self.pending)
            old[field] = value
            self.assertFalse(review.allows(self.batch, 'us', old, self.candidate, 'plan_added', self.now))
        for field, value in [('fingerprint', '0' * 64), ('since', p.stamp(self.now - 1700)), ('reason', 'currency_change')]:
            old = copy.deepcopy(self.pending)
            old['pending'][field] = value
            self.assertFalse(review.allows(self.batch, 'us', old, self.candidate, 'plan_added', self.now))

    def test_expired_review_does_not_bypass_pending(self):
        batch = copy.deepcopy(self.batch)
        batch['expires_at'] = p.stamp(self.now)
        result = p.observe(self.config, self.pending, self.now,
            lambda *a, **k: self.source, reviews=batch)
        self.assertEqual(result['status'], 'pending')

    def test_loader_fails_closed_for_malformed_or_unbounded_reviews(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'reviews.json'
            self.assertIsNone(review.load(path, {'us'}))
            path.write_text(json.dumps(self.batch))
            self.assertEqual(review.load(path, {'us'}), self.batch)
            for key, value in [('schema', True), ('schema', 2), ('reason', 'currency_change'),
                ('expires_at', p.stamp(self.now + 49 * 3600)), ('reviewed_at', 'invalid'),
                ('evidence_url', 'https://example.com/approval'), ('markets', {})]:
                batch = copy.deepcopy(self.batch)
                batch[key] = value
                path.write_text(json.dumps(batch))
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    review.load(path, {'us'})
            path.write_text(json.dumps(self.batch))
            with self.assertRaises(ValueError):
                review.load(path, {'gb'})
            path.write_text('{"schema":1,"schema":1}')
            with self.assertRaisesRegex(ValueError, 'duplicate'):
                review.load(path)

    def test_repository_review_manifest_is_bounded_and_configured(self):
        config = json.loads((p.ROOT / 'markets.json').read_text())
        batch = review.load(p.ROOT / 'reviewed-changes.json', {item['code'] for item in config})
        self.assertIsNotNone(batch)
        self.assertLessEqual(review.timestamp(batch['expires_at']) - review.timestamp(batch['reviewed_at']), 48 * 3600)


if __name__ == '__main__':
    unittest.main()
