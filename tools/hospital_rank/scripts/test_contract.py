#!/usr/bin/env python3
"""Offline regression fixtures for ranking types, source fidelity and hospital identity."""
from __future__ import annotations
import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / 'data'
VALIDATOR = Path(__file__).with_name('validate_data.py')
NAMES = ('rankings.json', 'source-snapshot.json', 'audit.json')


def run() -> None:
    original = {name: json.loads((DATA / name).read_text(encoding='utf-8')) for name in NAMES}
    rankings = original['rankings.json']
    hospital = next(h for h in rankings['hospitals'] if h['name'] == '中山大学孙逸仙纪念医院')
    assert '中山大学附属第二医院' in hospital['aliases']
    assert not any(h['id'] == 'h_4d69dda48f' for h in rankings['hospitals'])
    history = [dict(row, year=b['year']) for b in rankings['years'] for row in b['records'] if row['hospitalId'] == hospital['id']]
    assert sorted(r['year'] for r in history if r['year'] <= 2023) == list(range(2010, 2024))
    old = next(r for r in history if r['year'] == 2010)
    assert old['rank'] == 57 and old['sourceName'] == '中山大学附属第二医院' and old['overallScore'] == 9.92
    assert len({r['hospitalId'] for b in rankings['years'] if b['year'] <= 2023 for r in b['records']}) == 127
    # Separate historical ranking participants must not be collapsed by affiliation.
    assert {'中国人民解放军总医院', '中国人民解放军总医院第一附属医院（304）'} <= {h['name'] for h in rankings['hospitals']}
    assert any(b['year'] == 2009 and [r['rank'] for r in b['records']][26:29] == [27, 27, 29] for b in rankings['years'])

    cases = [(f'rank-{value!r}', 'rank', value) for value in (0, -1, True, 1.5, '1', None)]
    cases += [(f'score-{value!r}', 'overallScore', value) for value in (-1, True, '1', None, float('inf'), float('nan'))]
    cases += [(name, None, None) for name in ('grade-order', 'grade-source-score', 'grade-source-rank', 'fractional-year', 'boolean-schema', 'empty-years', 'duplicate-year', 'alias-string', 'location-number', 'source-order', 'missing-score', 'historical-mode')]
    with tempfile.TemporaryDirectory(prefix='hospital-contract-') as temp:
        target = Path(temp)
        def validate(payloads: dict) -> subprocess.CompletedProcess:
            for name, payload in payloads.items():
                (target / name).write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
            return subprocess.run([sys.executable, '-B', str(VALIDATOR), '--data-dir', str(target)],
                                  capture_output=True, text=True, encoding='utf-8', errors='replace',
                                  creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        valid = validate(original)
        assert valid.returncode == 0, valid.stderr
        for name, field, value in cases:
            payloads = copy.deepcopy(original)
            r, s = payloads['rankings.json'], payloads['source-snapshot.json']
            numeric = [next(b for b in p['years'] if b['year'] == 2009) for p in (r, s)]
            if field:
                for block in numeric: block['records'][0][field] = value
            elif name == 'grade-order': r['rankingModes']['grade']['grades'].reverse()
            elif name == 'grade-source-score': next(b for b in s['years'] if b['year'] == 2023)['records'][0]['overallScore'] = 99
            elif name == 'grade-source-rank': next(b for b in s['years'] if b['year'] == 2023)['records'][0]['rank'] = 1
            elif name == 'fractional-year':
                for p in (r, s): next(b for b in p['years'] if b['year'] == 2022)['year'] = 2022.5
            elif name == 'boolean-schema': r['schemaVersion'] = True
            elif name == 'empty-years': r['years'] = []
            elif name == 'duplicate-year': r['years'].append(copy.deepcopy(r['years'][0]))
            elif name == 'alias-string': r['hospitals'][0]['aliases'] = '不是数组'
            elif name == 'location-number': r['hospitals'][0]['province'] = 123
            elif name == 'source-order': next(b for b in s['years'] if b['year'] == 2023)['records'].reverse()
            elif name == 'missing-score':
                for block in numeric: del block['records'][0]['researchAcademic']
            elif name == 'historical-mode':
                for block in numeric:
                    block['rankingMode'] = 'grade'
                    for row in block['records']:
                        row.update(rank=None, grade='A', specialtyReputation=None, researchAcademic=None, overallScore=None)
            failed = validate(payloads)
            assert failed.returncode != 0, f'invalid fixture accepted: {name}'
    print(json.dumps({'status': 'ok', 'invalidFixturesRejected': len(cases), 'identityYears': 14,
                      'baselineEntities': 127, 'officialTiesPreserved': True}, ensure_ascii=False))


if __name__ == '__main__':
    run()
