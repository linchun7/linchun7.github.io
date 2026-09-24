#!/usr/bin/env python3
from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import render_static

ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / 'scripts' / 'validate_data.py'
DATA = ROOT / 'data'


def main() -> None:
    originals = {name: json.loads((DATA / name).read_text(encoding='utf-8'))
                 for name in ('rankings.json', 'source-snapshot.json', 'audit.json')}
    next_year = max(b['year'] for b in originals['rankings.json']['years']) + 1
    source = (ROOT / 'index.html').read_text(encoding='utf-8')
    with tempfile.TemporaryDirectory(prefix='hospital-future-') as temp_dir:
        target = Path(temp_dir)
        for mode in ('grade', 'numeric'):
            payloads = copy.deepcopy(originals)
            # Check two successive additions: a real 2024 must not collide with a fixed fixture year.
            for future_year in (next_year, next_year + 1):
                for filename in ('rankings.json', 'source-snapshot.json'):
                    data = payloads[filename]
                    template = next(b for b in reversed(data['years']) if b['rankingMode'] == mode)
                    block = copy.deepcopy(template)
                    block['year'] = future_year
                    if 'sourceUrl' in block:
                        block['sourceUrl'] = f'https://rank.cn-healthcare.com/fudan/national-general/year/{future_year}'
                    data['years'].append(block)
                for name, payload in payloads.items():
                    (target / name).write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
                result = subprocess.run([sys.executable, '-B', str(VALIDATOR), '--data-dir', str(target)],
                                        capture_output=True, text=True, encoding='utf-8', errors='replace',
                                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                assert result.returncode == 0, result.stderr
                render_static.RANKINGS_PATH = target / 'rankings.json'
                rendered = render_static.render_index(source, payloads['rankings.json'])
                expected = len(payloads['rankings.json']['years'][-1]['records'])
                assert f'<option value="{future_year}" selected>' in rendered
                assert f'{future_year} 年医院榜单 · 共 {expected} 家医院' in rendered
                assert rendered.count('data-static-prerendered="true"') == expected
                assert rendered.count(f'data-year="{future_year}"') == expected
                assert f'id="rankColumnLabel">{"等级" if mode == "grade" else "排名"}</span>' in rendered
                assert render_static.render_index(rendered, payloads['rankings.json']) == rendered
    marker = '<!-- STATIC_LATEST_ROWS_START --><!-- STATIC_LATEST_ROWS_END -->'
    literal = r'测试\1\g<1>医院 & <script>'
    assert literal in render_static.replace_between(marker, render_static.ROWS_START, render_static.ROWS_END, literal)
    assert '&lt;script&gt;' in render_static.esc(literal)
    print('future-year validator/static-render regressions: 4 scenarios ok')


if __name__ == '__main__':
    main()
