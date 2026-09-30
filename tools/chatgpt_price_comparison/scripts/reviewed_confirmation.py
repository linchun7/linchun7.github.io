"""Bounded, exact approvals for independently reviewed pending additions.

This is not a force switch. The regular source parser, double fetch, coverage,
FX, artifact, browser and production gates remain mandatory.
"""
import json
import re
from datetime import datetime
from pathlib import Path

FIELDS = {'schema', 'reason', 'reviewed_at', 'expires_at', 'evidence_url', 'markets'}
ENTRY_FIELDS = {'before_fingerprint', 'candidate_fingerprint', 'pending_since'}
HASH = re.compile(r'[0-9a-f]{64}\Z')


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', value):
        raise ValueError('invalid review timestamp')
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate review key')
        result[key] = value
    return result


def load(path: Path, configured_codes=None):
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=unique_object)
    if not isinstance(data, dict) or set(data) != FIELDS or type(data['schema']) is not int or data['schema'] != 1:
        raise ValueError('invalid reviewed-change schema')
    if data['reason'] != 'plan_added':
        raise ValueError('unsupported reviewed-change reason')
    reviewed, expires = timestamp(data['reviewed_at']), timestamp(data['expires_at'])
    if not 0 < expires - reviewed <= 48 * 3600:
        raise ValueError('review validity must be bounded to 48 hours')
    if not isinstance(data['evidence_url'], str) or not re.fullmatch(
        r'https://github\.com/linchun7/linchun7\.github\.io/actions/runs/[0-9]+', data['evidence_url']
    ):
        raise ValueError('invalid review evidence URL')
    markets = data['markets']
    if not isinstance(markets, dict) or not 1 <= len(markets) <= 300:
        raise ValueError('invalid reviewed markets')
    for code, entry in markets.items():
        if not re.fullmatch(r'[a-z]{2}', code) or (configured_codes is not None and code not in configured_codes):
            raise ValueError('invalid reviewed storefront')
        if not isinstance(entry, dict) or set(entry) != ENTRY_FIELDS:
            raise ValueError('invalid reviewed fingerprints')
        if any(not isinstance(entry[k], str) or not HASH.fullmatch(entry[k])
               for k in ('before_fingerprint', 'candidate_fingerprint')):
            raise ValueError('invalid reviewed fingerprint')
        if entry['before_fingerprint'] == entry['candidate_fingerprint']:
            raise ValueError('review must identify a change')
        if timestamp(entry['pending_since']) > reviewed:
            raise ValueError('review predates pending evidence')
    return data


def allows(review, code, old, candidate, reason, now):
    if review is None or reason != 'plan_added' or review['reason'] != reason:
        return False
    if not timestamp(review['reviewed_at']) <= now < timestamp(review['expires_at']):
        return False
    entry = review['markets'].get(code)
    pending = old.get('pending', {})
    return bool(entry and old.get('status') == 'pending'
        and old.get('fingerprint') == entry['before_fingerprint']
        and candidate.get('fingerprint') == entry['candidate_fingerprint']
        and pending.get('fingerprint') == entry['candidate_fingerprint']
        and pending.get('since') == entry['pending_since']
        and pending.get('reason') == reason)
