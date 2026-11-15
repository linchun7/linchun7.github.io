#!/usr/bin/env python3
"""Explicit read-only diagnostic, not part of offline discovery or publication."""
import json
import time
from decimal import Decimal
import pipeline as p
import fx_sanity as gate

now = time.time()
deadline = time.monotonic() + 45
current = json.loads((p.ROOT / 'data/prices.json').read_text())
required = sorted({'USD', 'CNY'} | {m['currency'] for m in current['markets'] if m.get('offers')})
primary = json.loads(p.fetch(p.FX_URL, deadline=deadline))
secondary_text = p.fetch(gate.CONFIRM_URL, deadline=deadline)
secondary = json.loads(secondary_text)
if primary.get('base_code') != 'USD' or primary.get('result') != 'success':
    raise ValueError('primary base/status mismatch')
rows = {r['quote']: r for r in secondary if r.get('base') == 'USD'}
report = {'required_count': len(required), 'primary_updated': primary['time_last_update_unix'],
          'missing': sorted(set(required) - set(rows)), 'pairs': []}
for code in required:
    row = rows.get(code)
    if not row:
        continue
    before = Decimal(str(primary['rates']['CNY'])) / Decimal(str(primary['rates'][code]))
    after = Decimal(str(rows['CNY']['rate'])) / Decimal(str(row['rate']))
    report['pairs'].append({'currency': code, 'date': row['date'],
                            'symmetric_ratio': str(gate.ratio(before, after))})
print(json.dumps(report, indent=2, sort_keys=True), flush=True)
gate.confirm(now, primary['rates'], set(required) - {'CNY'}, lambda url: secondary_text)
print('LIVE_CONFIRMATION_ALL_CURRENT_CURRENCIES_PASS', flush=True)
