"""Offline publication/consumer byte-budget contract; run only in GitHub CI."""
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import minimum_history as h
import pipeline as p
from test_pipeline import NOW, data_fixture, revise
import test_retained_fx as retained_fx


MAX_JSON_BYTES = 2_000_000
MAX_HTML_BYTES = 4_000_000


def serialized(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8')


def pad_json(raw, target_bytes):
    if len(raw) > target_bytes:
        raise AssertionError('fixture already exceeds its target size')
    # JSON whitespace changes serialized bytes without changing its semantics.
    return raw + b' ' * (target_bytes - len(raw))


class PublicationBudgetTests(unittest.TestCase):
    def candidate(self, directory, *, chinese_name=False):
        data = data_fixture()
        if chinese_name:
            data['markets'][0]['name'] = '国' * 80
            revise(data)
        ledger = h.advance_history(h.empty_history(), data)
        p.validate(data, NOW)
        h.assert_matches(ledger, data)
        files = {
            'prices.json': serialized(data),
            'minimum-history.json': serialized(ledger),
            'index.html': p.render(data, (p.ROOT / 'index.template.html').read_text(encoding='utf-8')).encode('utf-8'),
        }
        directory.mkdir()
        for name, raw in files.items():
            (directory / name).write_bytes(raw)
        return files

    def check(self, directory):
        with patch('sys.argv', ['pipeline.py', '--check', str(directory)]), \
             patch.object(p, 'fetch', side_effect=AssertionError('offline check must not fetch')), \
             contextlib.redirect_stdout(io.StringIO()):
            p.main()

    def test_current_sized_candidate_still_passes_without_changing_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / 'candidate'
            files = self.candidate(directory)
            self.check(directory)
            self.assertEqual({name: (directory / name).read_bytes() for name in files}, files)

    def test_exact_json_byte_ceiling_passes(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / 'candidate'
            files = self.candidate(directory)
            for name in ('prices.json', 'minimum-history.json'):
                raw = pad_json(files[name], MAX_JSON_BYTES)
                (directory / name).write_bytes(raw)
                self.assertEqual((directory / name).stat().st_size, MAX_JSON_BYTES)
            self.check(directory)

    def test_one_byte_over_json_ceiling_is_rejected_before_publication(self):
        for name in ('prices.json', 'minimum-history.json'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp) / 'candidate'
                files = self.candidate(directory)
                raw = pad_json(files[name], MAX_JSON_BYTES + 1)
                # Both payloads remain semantically valid and exactly matched.
                self.assertEqual(json.loads(raw), json.loads(files[name]))
                (directory / name).write_bytes(raw)
                with self.assertRaisesRegex(ValueError, name.replace('.', r'\.') + '.*publication.*budget'):
                    self.check(directory)
                self.assertEqual((directory / name).read_bytes(), raw)

    def test_utf8_byte_ceiling_cannot_be_replaced_by_character_count(self):
        for name in ('prices.json', 'minimum-history.json'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp) / 'candidate'
                files = self.candidate(directory, chinese_name=True)
                raw = pad_json(files[name], MAX_JSON_BYTES + 1)
                self.assertGreater(len(raw), MAX_JSON_BYTES)
                self.assertLess(len(raw.decode('utf-8')), MAX_JSON_BYTES)
                (directory / name).write_bytes(raw)
                with self.assertRaisesRegex(ValueError, name.replace('.', r'\.') + '.*publication.*budget'):
                    self.check(directory)

    def test_deterministic_html_over_ceiling_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            retained_fx.RetainedFxTests().baseline(root)
            original = (root / 'index.template.html').read_text(encoding='utf-8')
            (root / 'index.template.html').write_text(original + ' ' * MAX_HTML_BYTES, encoding='utf-8')
            with patch.object(p, 'ROOT', root):
                directory = root / 'candidate'
                files = self.candidate(directory)
                self.assertGreater(len(files['index.html']), MAX_HTML_BYTES)
                with self.assertRaisesRegex(ValueError, r'index\.html.*publication.*budget'):
                    self.check(directory)

    def test_generation_checks_all_output_budgets_before_creating_candidate(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old, _, _ = retained_fx.RetainedFxTests().baseline(root)
            before = {name: (root / 'data' / name).read_bytes() for name in ('prices.json', 'minimum-history.json')}
            template = (root / 'index.template.html').read_text(encoding='utf-8')
            (root / 'index.template.html').write_text(template + ' ' * MAX_HTML_BYTES, encoding='utf-8')
            now = NOW + 60
            fx = copy.deepcopy(old['fx'])
            fx.update(updated_at=p.stamp(now), fallback=False)

            def observed(item, prior, checked_at, getter, **kwargs):
                market = copy.deepcopy(prior)
                market.update(name=item['name'], status='verified', last_checked_at=p.stamp(checked_at), last_verified_at=p.stamp(checked_at))
                return market

            directory = root / 'candidate'
            with patch.object(p, 'ROOT', root), \
                 patch.object(p, 'observe', side_effect=observed), \
                 patch.object(p, 'collect_fx', return_value=fx), \
                 patch.object(p, 'fetch', side_effect=AssertionError('fixture must not fetch')), \
                 contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, r'index\.html.*publication.*budget'):
                    p.run(directory, now)
            self.assertFalse(directory.exists(), 'oversize generation must not leave a partial candidate')
            self.assertEqual({name: (root / 'data' / name).read_bytes() for name in before}, before)


if __name__ == '__main__':
    unittest.main()
