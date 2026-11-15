"""FX anomaly gate. No credentials; confirmation never replaces the primary feed."""
import json
import re
from datetime import datetime, timezone
from decimal import Decimal

CONFIRM_URL = 'https://api.frankfurter.dev/v2/rates?base=USD'
MAX_BASELINE_AGE = 7 * 86400
MAX_CONFIRM_AGE = 4 * 86400  # Daily official rates can span weekends/holidays.
DAILY_RATIO = Decimal('1.12')
AGREEMENT_RATIO = Decimal('1.03')


def number(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError('invalid FX numeric value')
    result = Decimal(str(value))
    if not result.is_finite() or not 0 < result < Decimal('1e10'):
        raise ValueError('invalid FX numeric value')
    return result


def ratio(a, b):
    return max(a / b, b / a)


def confirmation_currencies(now, updated, rates, old, parse_time):
    """Compare actual CNY projections, not independent USD legs."""
    active = set(rates) - {'CNY'}
    if not old:
        return set()  # No reliable numeric anchor: retain existing bootstrap validation.
    baseline_at = parse_time(old['updated_at'])
    if updated < baseline_at:
        raise ValueError('FX source timestamp regressed')
    elapsed = updated - baseline_at
    if now - baseline_at < -300:
        raise ValueError('future FX baseline')
    # A recent accepted baseline is an anomaly detector, not an absolute cap:
    # large legitimate moves can still pass independent confirmation.
    days = Decimal(str(min(MAX_BASELINE_AGE / 86400, max(1, elapsed / 86400))))
    limit = DAILY_RATIO ** days
    previous = old.get('rates', {})
    suspicious = set()
    for code in active:
        if code not in previous or 'CNY' not in previous:
            continue  # A newly covered currency has no trustworthy prior comparison.
        before = number(previous['CNY']) / number(previous[code])
        after = number(rates['CNY']) / number(rates[code])
        if ratio(before, after) > limit:
            suspicious.add(code)
    return suspicious


def confirm(now, rates, currencies, getter):
    """Frankfurter v2 /rates schema; missing/stale/conflicting pairs fail closed."""
    payload = json.loads(getter(CONFIRM_URL))
    if not isinstance(payload, list) or not 1 <= len(payload) <= 500:
        raise ValueError('invalid independent FX response')
    required = set(currencies) | {'CNY'}
    evidence = {}
    for row in payload:
        if not isinstance(row, dict):
            raise ValueError('invalid independent FX row')
        code = row.get('quote')
        if code not in required:
            continue
        if code in evidence or row.get('base') != 'USD':
            raise ValueError('duplicate or wrong-base independent FX rate')
        date = row.get('date')
        if not isinstance(date, str) or not re.fullmatch(r'\d{4}-\d\d-\d\d', date):
            raise ValueError('invalid independent FX date')
        observed = datetime.strptime(date, '%Y-%m-%d').replace(tzinfo=timezone.utc).timestamp()
        if not -300 <= now - observed <= MAX_CONFIRM_AGE:
            raise ValueError('stale or future independent FX rate')
        value = number(row.get('rate'))
        if code == 'USD' and value != 1:
            raise ValueError('wrong independent USD rate')
        evidence[code] = value
    # Identity is defined by the USD base even if the API omits its row.
    evidence.setdefault('USD', Decimal(1))
    if required - set(evidence):
        raise ValueError('independent FX currency missing')
    if not 1 < evidence['CNY'] < 30:
        raise ValueError('invalid independent CNY rate')
    for code in currencies:
        primary = number(rates['CNY']) / number(rates[code])
        secondary = evidence['CNY'] / evidence[code]
        if ratio(primary, secondary) > AGREEMENT_RATIO:
            raise ValueError('independent FX disagrees for ' + code)
