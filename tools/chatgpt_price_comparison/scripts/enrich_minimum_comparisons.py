#!/usr/bin/env python3
"""Enrich existing events from exact Git snapshots; never rebuild their facts."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import minimum_history as history
import pipeline

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ref', default='HEAD')
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    source = history.ROOT / 'data/minimum-history.json'
    original = json.loads(source.read_text(encoding='utf-8'))
    enriched, report = history.enrich_history_from_git(original, args.ref)
    if args.write:
        source.write_text(json.dumps(enriched, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        data = json.loads((history.ROOT / 'data/prices.json').read_text(encoding='utf-8'))
        page = pipeline.render(data, (history.ROOT / 'index.template.html').read_text(encoding='utf-8'))
        (history.ROOT / 'index.html').write_text(page, encoding='utf-8')
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True))

if __name__ == '__main__':
    main()
