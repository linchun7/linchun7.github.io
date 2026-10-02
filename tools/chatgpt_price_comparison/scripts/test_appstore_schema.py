"""Source-derived coverage for Apple's 2026-10-02 purchase schema migration."""
import copy
import json
import re
import unittest
from pathlib import Path

import pipeline as p
from test_pipeline import NOW, fixture, good_market

FIXTURES = Path(__file__).with_name('fixtures')


def record(code='us'):
    return json.loads((FIXTURES / f'appstore-20261002-{code}.json').read_text(encoding='utf-8'))


def source(value):
    return (value['canonical_link']
            + '<script id="software-application">' + json.dumps(value['application']) + '</script>'
            + ''.join(value['visible_html'])
            + '<script id="serialized-server-data">'
            + json.dumps({'data': [value['annotation']]}) + '</script>')


def mutate_legacy(change):
    text = fixture()
    pattern = r'(<script type="application/json" id="serialized-server-data">)(.*?)(</script>)'
    match = re.search(pattern, text)
    data = json.loads(match[2])
    change(data['data'][0])
    return text[:match.start(2)] + json.dumps(data) + text[match.end(2):]


class OfficialAppStoreSchemaTests(unittest.TestCase):
    def test_real_direct_sources_preserve_all_prices_and_multiple_plus_amounts(self):
        expected = {
            'us': ('USD', ['19.99', '200'], '500'),
            'jp': ('JPY', ['3000', '30000'], '84000'),
            'tr': ('TRY', ['999.99', '9999.99'], '26499'),
        }
        for code, (currency, plus, pro500) in expected.items():
            with self.subTest(code=code):
                value = record(code)
                self.assertNotIn('items_V3', value['annotation'])
                parsed = p.parse_store(source(value), code)
                offers = {o['label']: [a['amount'] for a in o['amounts']] for o in parsed['offers']}
                self.assertEqual(parsed['currency'], currency)
                self.assertEqual(set(offers), {'ChatGPT Go', 'ChatGPT Plus', 'ChatGPT Pro 100', 'ChatGPT Pro 200', 'ChatGPT Pro 500'})
                self.assertEqual(offers['ChatGPT Plus'], plus)
                self.assertEqual(offers['ChatGPT Pro 500'], [pro500])
                self.assertEqual(parsed['unclassified_labels'], ['100 Credits', '1000 Credits', '500 Credits'] if code == 'us' else [])

    def test_direct_title_can_change_only_with_unique_purchase_structure(self):
        value = record()
        value['annotation']['title'] = 'Subscriptions'
        self.assertEqual(p.parse_store(source(value), 'us')['currency'], 'USD')

    def test_present_second_representation_accepts_order_and_price_format_changes(self):
        value = record()
        second = copy.deepcopy(value['annotation']['items'][:-1])[::-1]
        for item in second:
            if item['leadingText'] == 'ChatGPT Go':
                item['leadingText'] = '  ChatGPT\u00a0Go  '
                item['trailingText'] = 'USD 8'
        value['annotation']['items_V3'] = second
        self.assertEqual(p.semantic(p.parse_store(source(value), 'us')), p.semantic(p.parse_store(source(record()), 'us')))

    def test_legacy_schema_remains_supported_with_reordered_v3(self):
        self.assertEqual(p.semantic(p.parse_store(mutate_legacy(lambda a: a['items_V3'].reverse()), 'us')),
                         p.semantic(p.parse_store(fixture(), 'us')))

    def test_legacy_without_second_representation_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'missing legacy purchase cross-check'):
            p.parse_store(mutate_legacy(lambda a: a.pop('items_V3')), 'us')

    def test_empty_null_or_wrong_type_second_representation_is_not_absence(self):
        for second in ([], None, 'bad', [{}]):
            with self.subTest(second=second), self.assertRaises(ValueError):
                value = record()
                value['annotation']['items_V3'] = second
                p.parse_store(source(value), 'us')

    def test_price_currency_label_and_duplicate_conflicts_are_rejected(self):
        for conflict in ('price', 'currency', 'label', 'missing', 'duplicate', 'missing_credit', 'credit_price'):
            with self.subTest(conflict=conflict), self.assertRaises(ValueError):
                value = record()
                second = copy.deepcopy(value['annotation']['items'][:-1])
                if conflict == 'price':
                    second[0]['trailingText'] = '$99.99'
                elif conflict == 'currency':
                    second[0]['trailingText'] = 'EUR 19.99'
                elif conflict == 'label':
                    second[0]['leadingText'] = 'ChatGPT Different'
                elif conflict == 'missing':
                    second.pop(0)
                elif conflict == 'duplicate':
                    second.append(copy.deepcopy(second[0]))
                elif conflict == 'missing_credit':
                    second.pop(2)
                else:
                    second[2]['trailingText'] = '$5.00'
                value['annotation']['items_V3'] = second
                p.parse_store(source(value), 'us')

    def test_missing_or_malformed_direct_fields_fail_closed(self):
        for bad in ({'$kind': 'textPair', 'leadingText': 'ChatGPT Plus'},
                    {'$kind': 'textPair', 'trailingText': '$19.99'},
                    {'$kind': 'textPair', 'leadingText': 42, 'trailingText': '$19.99'},
                    {'$kind': 'textPair', 'leadingText': 'ChatGPT Plus', 'trailingText': None},
                    {'$kind': 'textPair', 'leadingText': '', 'trailingText': '$19.99'},
                    {'$kind': 'textPair', 'leadingText': 'ChatGPT Plus', 'trailingText': '$0'},
                    {'$kind': 'textPair', 'leadingText': 'ChatGPT Plus', 'trailingText': 'EUR 19.99'},
                    {'$kind': 'unknown', 'leadingText': 'ChatGPT Plus', 'trailingText': '$19.99'}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                value = record()
                value['annotation']['items'][0] = bad
                p.parse_store(source(value), 'us')

    def test_missing_primary_and_mixed_shapes_fail_closed(self):
        for mode in ('absent', 'empty', 'null', 'mixed', 'ambiguous', 'button_price'):
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                value = record()
                annotation = value['annotation']
                if mode == 'absent':
                    annotation.pop('items')
                elif mode == 'empty':
                    annotation['items'] = []
                elif mode == 'null':
                    annotation['items'] = None
                elif mode == 'mixed':
                    annotation['items'].append({'$kind': 'AnnotationItem', 'textPairs': [['ChatGPT Plus', '$19.99']]})
                elif mode == 'ambiguous':
                    annotation['items'][0]['textPairs'] = [['ChatGPT Plus', '$19.99']]
                else:
                    annotation['items'][-1]['leadingText'] = 'ChatGPT Plus'
                p.parse_store(source(value), 'us')

    def test_legacy_malformed_pairs_are_validation_errors(self):
        for pair in (None, ['ChatGPT Plus'], ['ChatGPT Plus', 19.99], ['ChatGPT Plus', '$19.99', 'extra']):
            with self.subTest(pair=pair), self.assertRaises(ValueError):
                p.parse_store(mutate_legacy(lambda a: a['items'][0].update(textPairs=[pair])), 'us')

    def test_primary_must_match_complete_visible_plan_list_and_multiplicity(self):
        for mode in ('price', 'missing', 'extra_visible', 'duplicate_visible', 'duplicate_primary'):
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                value = record()
                if mode == 'price':
                    value['annotation']['items'][0]['trailingText'] = '$99.99'
                elif mode == 'missing':
                    value['annotation']['items'].pop(0)
                elif mode == 'extra_visible':
                    value['visible_html'].append('<div class="text-pair"><span>ChatGPT Future</span><span>$99.99</span></div>')
                elif mode == 'duplicate_visible':
                    value['visible_html'].append(value['visible_html'][0])
                else:
                    value['annotation']['items'].append(copy.deepcopy(value['annotation']['items'][0]))
                p.parse_store(source(value), 'us')

    def test_schema_conflict_retains_reliable_prices_and_original_date_indefinitely(self):
        value = record()
        value['annotation']['items_V3'] = copy.deepcopy(value['annotation']['items'][:-1])
        value['annotation']['items_V3'][0]['trailingText'] = '$99.99'
        old = good_market()
        checked = NOW + 30 * 86400
        result = p.observe({'code': 'us', 'name': '美国'}, old, checked, lambda *a, **kw: source(value))
        self.assertEqual(result['status'], 'retained')
        self.assertEqual(result['offers'], old['offers'])
        self.assertEqual(result['fingerprint'], old['fingerprint'])
        self.assertEqual(result['last_verified_at'], old['last_verified_at'])
        self.assertEqual(result['last_checked_at'], p.stamp(checked))


if __name__ == '__main__':
    unittest.main()
