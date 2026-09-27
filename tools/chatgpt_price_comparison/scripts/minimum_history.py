#!/usr/bin/env python3
"""Auditable minimum-price winner history for ChatGPT App Store observations."""
from __future__ import annotations

import argparse
import copy
import json
import re
import subprocess
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

FRESH = 36 * 3600
PROJECT_SINCE = '2026-09-24'
PLAN_ORDER = ('ChatGPT Go', 'ChatGPT Plus', 'ChatGPT Pro 5x', 'ChatGPT Pro 20x')
PLAN = re.compile(r'ChatGPT [^\x00-\x1f\x7f<>]{1,70}\Z')
AMOUNT = re.compile(r'(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?\Z')
CNY = re.compile(r'(?:0|[1-9][0-9]*)\.\d{2}\Z')
ISO = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\Z')
SHA = re.compile(r'[a-f0-9]{64}\Z')
CODE = re.compile(r'[a-z]{2}\Z')
CURRENCY = re.compile(r'[A-Z]{3}\Z')
CAUSES = {
    'initial': '首次可核验记录',
    'fx': '汇率变化',
    'storefront': 'App Store 标价变化',
    'mixed': '标价与汇率均有变化',
    'scope': '比较范围变化',
    'unknown': '原因未能确定',
}
ROOT = Path(__file__).resolve().parents[1]
PRICE_PATH = 'tools/chatgpt_price_comparison/data/prices.json'


def epoch(value: str) -> float:
    if not isinstance(value, str) or not ISO.fullmatch(value):
        raise ValueError('invalid minimum-history timestamp')
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def decimal_text(value: str) -> str:
    number = Decimal(value)
    return format(number.normalize(), 'f')


def ordered_plans(data: dict) -> list[str]:
    labels = {offer['label'] for market in data.get('markets', []) for offer in market.get('offers', [])}
    return [label for label in PLAN_ORDER if label in labels] + sorted(labels.difference(PLAN_ORDER))


def min_offer(market: dict, plan: str):
    offer = next((item for item in market.get('offers', []) if item.get('label') == plan), None)
    if not offer or not offer.get('amounts'):
        return None
    amount = min(offer['amounts'], key=lambda item: Decimal(item['amount']))
    if amount.get('cny') is None:
        return None
    return decimal_text(amount['amount']), format(Decimal(amount['cny']), '.2f')


def build_snapshot(data: dict) -> dict | None:
    generated = epoch(data['generated_at'])
    fx = data.get('fx')
    if not isinstance(fx, dict) or fx.get('fallback') is not False:
        return None
    fx_age = generated - epoch(fx.get('updated_at'))
    if not -300 <= fx_age <= FRESH:
        return None
    markets = data.get('markets')
    if not isinstance(markets, list) or not markets or any(market.get('status') != 'verified' for market in markets):
        return None
    for market in markets:
        if market.get('offers') and (
            not market.get('last_verified_at')
            or not -300 <= generated - epoch(market['last_verified_at']) <= FRESH
        ):
            return None

    rates = fx.get('rates')
    if not isinstance(rates, dict):
        return None
    required = {'USD', 'CNY', *(market.get('currency') for market in markets if market.get('offers'))}
    if any(not code or code not in rates for code in required):
        return None
    fx_signature = {
        'updated_at': fx['updated_at'],
        'rates': {code: str(rates[code]) for code in sorted(required)},
    }

    plans = []
    for plan in ordered_plans(data):
        rows = []
        for market in markets:
            value = min_offer(market, plan)
            if value is None:
                if any(offer.get('label') == plan for offer in market.get('offers', [])):
                    return None
                continue
            local, cny = value
            rows.append({
                'code': market['code'],
                'name': market['name'],
                'currency': market['currency'],
                'local': local,
                'cny': cny,
            })
        if not rows:
            continue
        rows.sort(key=lambda row: row['code'])
        minimum = min(Decimal(row['cny']) for row in rows)
        winners = [copy.deepcopy(row) for row in rows if Decimal(row['cny']) == minimum]
        plans.append({
            'id': plan,
            'scope': [[row['code'], row['currency']] for row in rows],
            'prices': [[row['code'], row['currency'], row['local']] for row in rows],
            'winners': winners,
        })
    if not plans:
        return None
    return {
        'at': data['generated_at'],
        'revision': data['revision'],
        'fx': fx_signature,
        'plans': plans,
    }


def empty_history() -> dict:
    return {
        'schema': 1,
        'project_since': PROJECT_SINCE,
        'first_observed_at': None,
        'checked_at': None,
        'observations': 0,
        'excluded_versions': 0,
        'pending_gap': False,
        'gaps': [],
        'events': [],
        'checkpoint': None,
    }


def winner_ids(rows: list[dict]) -> list[str]:
    return [row['code'] for row in rows]


def projection(snapshot: dict) -> dict:
    return {
        'fx': snapshot['fx'],
        'plans': [{
            'id': plan['id'],
            'scope': plan['scope'],
            'prices': plan['prices'],
            'winners': [{key: value for key, value in row.items() if key != 'name'} for row in plan['winners']],
        } for plan in snapshot['plans']],
    }


def cause_for(evidence: dict) -> str:
    if evidence['gap']:
        return 'unknown'
    if evidence['scope_changed']:
        return 'scope'
    if not evidence['prices_changed']:
        return 'fx' if evidence['fx_changed'] is True else 'unknown'
    if evidence['fx_changed'] is False:
        return 'storefront'
    return 'mixed' if evidence['fx_changed'] is True else 'unknown'


def _valid_winners(rows) -> bool:
    if not isinstance(rows, list) or len(rows) > 250:
        return False
    previous = ''
    for row in rows:
        if not isinstance(row, dict) or set(row) != {'code', 'name', 'currency', 'local', 'cny'}:
            return False
        if not CODE.fullmatch(row.get('code', '')) or row['code'] <= previous:
            return False
        if not isinstance(row.get('name'), str) or not row['name'] or len(row['name']) > 80:
            return False
        if not CURRENCY.fullmatch(row.get('currency', '')) or not AMOUNT.fullmatch(row.get('local', '')) or not CNY.fullmatch(row.get('cny', '')):
            return False
        previous = row['code']
    return True


def validate_history(value: dict) -> dict:
    top = {'schema','project_since','first_observed_at','checked_at','observations','excluded_versions','pending_gap','gaps','events','checkpoint'}
    if not isinstance(value, dict) or set(value) != top or value.get('schema') != 1 or value.get('project_since') != PROJECT_SINCE:
        raise ValueError('invalid minimum history')
    for key in ('first_observed_at','checked_at'):
        if value[key] is not None:
            epoch(value[key])
    if not isinstance(value['observations'], int) or value['observations'] < 0 or not isinstance(value['excluded_versions'], int) or value['excluded_versions'] < 0:
        raise ValueError('invalid minimum history counts')
    if not isinstance(value['pending_gap'], bool) or not isinstance(value['gaps'], list) or not isinstance(value['events'], list):
        raise ValueError('invalid minimum history collections')
    if len(value['gaps']) > 20000 or len(value['events']) > 20000:
        raise ValueError('minimum history too large')

    previous_gap = float('-inf')
    for gap in value['gaps']:
        if not isinstance(gap, dict) or set(gap) != {'from','to'}:
            raise ValueError('invalid minimum history gap')
        start, end = epoch(gap['from']), epoch(gap['to'])
        if start >= end or start < previous_gap:
            raise ValueError('invalid minimum history gap chronology')
        previous_gap = end

    latest = {}
    last_at = float('-inf')
    seen_event_keys = set()
    for event in value['events']:
        keys = {'plan','at','previous_at','kind','cause','from','to','evidence','source_revision'}
        if not isinstance(event, dict) or set(event) != keys or not PLAN.fullmatch(event.get('plan','')):
            raise ValueError('invalid minimum history event')
        at = epoch(event['at'])
        if at < last_at or (event['at'], event['plan']) in seen_event_keys:
            raise ValueError('invalid minimum history event chronology')
        seen_event_keys.add((event['at'], event['plan']))
        if event['previous_at'] is not None and epoch(event['previous_at']) >= at:
            raise ValueError('invalid minimum history previous timestamp')
        if event['kind'] not in ('initial','change') or event['cause'] not in CAUSES or not SHA.fullmatch(event.get('source_revision','')):
            raise ValueError('invalid minimum history event metadata')
        if not _valid_winners(event['from']) or not _valid_winners(event['to']):
            raise ValueError('invalid minimum history winners')
        evidence = event['evidence']
        if not isinstance(evidence, dict) or set(evidence) != {'prices_changed','scope_changed','fx_changed','gap'}:
            raise ValueError('invalid minimum history evidence')
        if any(not isinstance(evidence[k], bool) for k in ('prices_changed','scope_changed','gap')) or evidence['fx_changed'] not in (True, False, None):
            raise ValueError('invalid minimum history evidence values')
        previous = latest.get(event['plan'])
        if event['kind'] == 'initial':
            if previous is not None or event['from'] or not event['to'] or event['cause'] != 'initial' or event['previous_at'] is not None:
                raise ValueError('invalid minimum history initial event')
        else:
            if previous is None or event['previous_at'] is None or winner_ids(previous['to']) != winner_ids(event['from']) or winner_ids(event['from']) == winner_ids(event['to']):
                raise ValueError('invalid minimum history event chain')
            if event['cause'] != cause_for(evidence):
                raise ValueError('invalid minimum history cause')
        latest[event['plan']] = event
        last_at = at

    checkpoint = value['checkpoint']
    if checkpoint is not None:
        if not isinstance(checkpoint, dict) or set(checkpoint) != {'at','revision','fx','plans'}:
            raise ValueError('invalid minimum history checkpoint')
        epoch(checkpoint['at'])
        if not SHA.fullmatch(checkpoint.get('revision','')) or not isinstance(checkpoint['fx'], dict) or set(checkpoint['fx']) != {'updated_at','rates'}:
            raise ValueError('invalid minimum history checkpoint metadata')
        epoch(checkpoint['fx']['updated_at'])
        rates = checkpoint['fx']['rates']
        if not isinstance(rates, dict) or not rates or any(not CURRENCY.fullmatch(k) or not isinstance(v,str) or Decimal(v) <= 0 for k,v in rates.items()):
            raise ValueError('invalid minimum history FX checkpoint')
        ids = set()
        for plan in checkpoint['plans']:
            if not isinstance(plan, dict) or set(plan) != {'id','scope','prices','winners'} or not PLAN.fullmatch(plan.get('id','')) or plan['id'] in ids:
                raise ValueError('invalid minimum history plan checkpoint')
            ids.add(plan['id'])
            if not isinstance(plan['scope'], list) or not isinstance(plan['prices'], list) or not _valid_winners(plan['winners']) or not plan['winners']:
                raise ValueError('invalid minimum history plan projection')
            if len(plan['scope']) != len(plan['prices']) or len(plan['scope']) > 250:
                raise ValueError('invalid minimum history plan scope')
            if any(not isinstance(row,list) or len(row)!=2 or not CODE.fullmatch(row[0]) or not CURRENCY.fullmatch(row[1]) for row in plan['scope']):
                raise ValueError('invalid minimum history scope row')
            if any(not isinstance(row,list) or len(row)!=3 or not CODE.fullmatch(row[0]) or not CURRENCY.fullmatch(row[1]) or not AMOUNT.fullmatch(row[2]) for row in plan['prices']):
                raise ValueError('invalid minimum history price row')
            if plan['scope'] != sorted(plan['scope']) or plan['prices'] != sorted(plan['prices']):
                raise ValueError('unordered minimum history checkpoint')
            if winner_ids(latest.get(plan['id'], {'to': []})['to']) != winner_ids(plan['winners']):
                raise ValueError('minimum history checkpoint does not match event chain')
    if (value['observations'] == 0) != (checkpoint is None):
        raise ValueError('invalid minimum history observation state')
    if (checkpoint is None) != (value['first_observed_at'] is None):
        raise ValueError('invalid minimum history first observation')
    if value['events'] and value['events'][0]['at'] != value['first_observed_at']:
        raise ValueError('invalid minimum history first event')
    if checkpoint is not None and not value['pending_gap'] and value['checked_at'] != checkpoint['at']:
        raise ValueError('minimum history checkpoint is not current')
    return value


def advance_history(history: dict | None, data: dict) -> dict:
    result = copy.deepcopy(history) if history is not None else empty_history()
    validate_history(result)
    generated = data['generated_at']
    if result['checked_at'] is not None and epoch(generated) < epoch(result['checked_at']):
        raise ValueError('minimum history cannot roll back')
    current = build_snapshot(data)
    if current is None:
        if result['checked_at'] != generated:
            result['excluded_versions'] += 1
        result['checked_at'] = generated
        result['pending_gap'] = True
        return validate_history(result)

    last = result['checkpoint']
    if last is not None and last['at'] == current['at']:
        if canonical(projection(last)) != canonical(projection(current)):
            raise ValueError('conflicting minimum snapshots at the same timestamp')
        result['checkpoint'] = current
        result['checked_at'] = current['at']
        return validate_history(result)

    if last is not None and result['pending_gap']:
        result['gaps'].append({'from': last['at'], 'to': current['at']})
    before = {plan['id']: plan for plan in (last['plans'] if last else [])}
    after = {plan['id']: plan for plan in current['plans']}
    seen = {event['plan'] for event in result['events']}
    fx_changed = None if last is None else canonical(last['fx']) != canonical(current['fx'])

    for plan_id in sorted(set(before) | set(after), key=lambda value: (PLAN_ORDER.index(value) if value in PLAN_ORDER else len(PLAN_ORDER), value)):
        old_plan, new_plan = before.get(plan_id), after.get(plan_id)
        old_winners = old_plan['winners'] if old_plan else []
        new_winners = new_plan['winners'] if new_plan else []
        if winner_ids(old_winners) == winner_ids(new_winners):
            continue
        initial = plan_id not in seen
        evidence = {
            'prices_changed': bool(old_plan and new_plan and canonical(old_plan['prices']) != canonical(new_plan['prices'])),
            'scope_changed': old_plan is None or new_plan is None or canonical(old_plan['scope']) != canonical(new_plan['scope']),
            'fx_changed': fx_changed,
            'gap': result['pending_gap'],
        }
        result['events'].append({
            'plan': plan_id,
            'at': current['at'],
            'previous_at': None if initial else last['at'],
            'kind': 'initial' if initial else 'change',
            'cause': 'initial' if initial else cause_for(evidence),
            'from': copy.deepcopy(old_winners),
            'to': copy.deepcopy(new_winners),
            'evidence': evidence,
            'source_revision': current['revision'],
        })
    result['first_observed_at'] = result['first_observed_at'] or current['at']
    result['checked_at'] = current['at']
    result['checkpoint'] = current
    result['observations'] += 1
    result['pending_gap'] = False
    return validate_history(result)


def assert_matches(history: dict, data: dict) -> bool:
    validate_history(history)
    if history['checked_at'] != data['generated_at']:
        raise ValueError('minimum history does not match current prices')
    snapshot = build_snapshot(data)
    if snapshot is None:
        if not history['pending_gap']:
            raise ValueError('unreliable candidate must leave minimum history pending')
    elif history['pending_gap'] or canonical(history['checkpoint']) != canonical(snapshot):
        raise ValueError('minimum history checkpoint does not match current prices')
    return True


def backfill_history(ref='HEAD', project_dir=ROOT):
    repo = project_dir.parents[1]
    if not re.fullmatch(r'[A-Za-z0-9_./-]+', ref) or ref.startswith('-'):
        raise ValueError('invalid Git ref')
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=repo, text=True, stderr=subprocess.DEVNULL)
    if git('rev-parse','--is-shallow-repository').strip() != 'false':
        raise ValueError('backfill requires full Git history')
    shas = [line for line in git('log','--first-parent','--reverse','--format=%H',ref,'--',PRICE_PATH).splitlines() if line]
    groups, excluded = {}, 0
    for sha in shas:
        try:
            data = json.loads(git('show', f'{sha}:{PRICE_PATH}'))
            snapshot = build_snapshot(data)
        except Exception:
            excluded += 1
            continue
        groups.setdefault(data['generated_at'], []).append((data, snapshot))
    history = empty_history()
    for at in sorted(groups, key=epoch):
        candidates = groups[at]
        reliable = [(data,snapshot) for data,snapshot in candidates if snapshot is not None]
        if not reliable:
            excluded += len(candidates)
            history = advance_history(history, candidates[-1][0])
            continue
        signatures = {canonical(projection(snapshot)) for _,snapshot in reliable}
        if len(signatures) != 1:
            excluded += len(reliable)
            history['pending_gap'] = True
            continue
        history = advance_history(history, reliable[-1][0])
    history['excluded_versions'] += excluded
    current = json.loads((project_dir/'data/prices.json').read_text(encoding='utf-8'))
    history = advance_history(history, current)
    assert_matches(history, current)
    return history, len(shas)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--backfill', action='store_true')
    parser.add_argument('--ref', default='HEAD')
    parser.add_argument('--output', type=Path, default=ROOT/'data/minimum-history.json')
    args = parser.parse_args()
    if not args.backfill:
        parser.error('--backfill is required')
    history, versions = backfill_history(args.ref)
    args.output.write_text(json.dumps(history, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'versions': versions, 'observations': history['observations'], 'excluded_versions': history['excluded_versions'], 'events': len(history['events'])}, ensure_ascii=False))


if __name__ == '__main__':
    main()
