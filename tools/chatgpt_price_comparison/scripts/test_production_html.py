import copy
import json
import unittest
from pathlib import Path

import pipeline
from production_html import validate_html
from test_pipeline import data_fixture

class ProductionHtmlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = data_fixture()
        cls.html = pipeline.render(cls.data, (pipeline.ROOT / 'index.template.html').read_text(encoding='utf-8'))

    def test_actual_generator_output_and_formatting_are_accepted(self):
        validate_html(self.html, self.html, self.data)
        formatted = self.html.replace('><', '>\n  <').replace('<body>', '<body><!-- harmless edge comment -->')
        validate_html(self.html, formatted, self.data)

    def test_snapshot_json_equivalent_numeric_spelling_is_accepted(self):
        # JSON numbers are semantic, while booleans remain distinct.
        from production_html import equal_json
        self.assertTrue(equal_json({'value': 1.0}, {'value': 1}))
        self.assertFalse(equal_json({'value': True}, {'value': 1}))

    def test_generated_body_failures_cannot_hide_behind_valid_head(self):
        import re
        snapshot = re.search(r'<script type="application/json" id="price-data">.*?</script>', self.html, re.S).group()
        workspace = re.search(r'<section id="priceWorkspace"[\s\S]*?</section>', self.html).group()
        variants = {
            'head-only': self.html[:self.html.index('<body>')] + '</html>',
            'missing-snapshot': self.html.replace(snapshot, ''),
            'duplicated-snapshot': self.html.replace(snapshot, snapshot + snapshot),
            'inert-snapshot': self.html.replace(snapshot, '<template>' + snapshot + '</template>'),
            'comment-snapshot': self.html.replace(snapshot, '<!--' + snapshot + '-->'),
            'wrong-snapshot': self.html.replace(snapshot, '<script type="application/json" id="price-data">{}</script>'),
            'missing-workspace': self.html.replace(workspace, ''),
            'hidden-workspace': self.html.replace(workspace, '<div hidden>' + workspace + '</div>'),
            'inert-workspace': self.html.replace(workspace, '<template>' + workspace + '</template>'),
            'comment-workspace': self.html.replace(workspace, '<!--' + workspace + '-->'),
            'missing-rows': re.sub(r'(<tbody id="priceRows">)[\s\S]*?(</tbody>)', r'\1\2', self.html),
            'inert-app': self.html.replace('<script defer data-cfasync="false"', '<script type="application/json" defer data-cfasync="false"'),
            'disabled-style': self.html.replace('rel="stylesheet"', 'rel="alternate stylesheet"'),
        }
        for name, actual in variants.items():
            with self.subTest(name=name):
                self.assertNotEqual(actual, self.html)
                with self.assertRaises(ValueError):
                    validate_html(self.html, actual, self.data)

if __name__ == '__main__':
    unittest.main()
