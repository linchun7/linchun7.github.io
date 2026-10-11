"""Strict live-source candidate checks against configured markets and prior history.

A valid update may append observed changes and prune only the oldest global
prefix beyond the production retention budget. Rebuild that exact transition
from the trusted baseline instead of requiring an unbounded append-only log.
"""
from __future__ import annotations

import copy

import pipeline as p


def validate_live_candidate(baseline: dict, candidate: dict, config: list) -> dict:
    p.validate(baseline)
    p.validate(candidate)
    configured = [item['code'] for item in config]
    expected_codes = set(configured)
    if len(expected_codes) != len(configured):
        raise ValueError('duplicate configured storefront')
    by_code = {market['code']: market for market in candidate['markets']}
    if set(by_code) != expected_codes:
        raise ValueError('candidate markets do not match configured storefronts')
    if any(market['status'] != 'verified' for market in candidate['markets']):
        raise ValueError('live markets not fully verified: ' + p.source_summary(candidate['markets']))
    if any(market['last_verified_at'] != candidate['generated_at'] for market in candidate['markets']):
        raise ValueError('live verification time does not match candidate generation')
    if not candidate['fx'] or candidate['fx']['fallback']:
        raise ValueError('live FX is not newly verified')

    previous, prior_changes = p.scope_previous(baseline, expected_codes)
    changes = copy.deepcopy(prior_changes)
    # Incoming baselines are evidence to check, never input to the replay.
    # Production appends changes in config order; array presentation order is free.
    markets = copy.deepcopy([by_code[code] for code in configured])
    for market in markets:
        market.pop('history_baseline', None)
        before = previous.get(market['code'])
        if p.should_record_history_change(before, market):
            changes.append({
                'at': candidate['generated_at'], 'code': market['code'],
                'before': p.semantic(before), 'after': p.semantic(market),
            })
    unpruned_count = len(changes)
    expected_changes = p.update_country_history(previous, markets, changes)
    if candidate['changes'] != expected_changes:
        raise ValueError('candidate changes do not match exact retained history transition')
    for expected_market in markets:
        actual_market = by_code[expected_market['code']]
        if actual_market.get('history_baseline') != expected_market.get('history_baseline'):
            raise ValueError('candidate baseline does not match exact history transition: ' + actual_market['code'])

    return {
        'verified_markets': len(candidate['markets']),
        'generated_at': candidate['generated_at'],
        'fx_updated_at': candidate['fx']['updated_at'],
        'data_revision': candidate['revision'],
        'price_date_label': p.price_date_label(candidate),
        'history_transition_validated': True,
        'retained_changes': len(expected_changes),
        'pruned_changes': unpruned_count - len(expected_changes),
        'new_markets': sorted(set(configured) - set(previous)),
    }
