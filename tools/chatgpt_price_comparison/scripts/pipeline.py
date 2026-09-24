#!/usr/bin/env python3
"""Public App Store price observations. Python standard library; no credentials.

Never infer billing periods, purchase eligibility, or web prices from an IAP label.
Only this program generates data/prices.json and the HTML projection.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import copy
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

ROOT = Path(__file__).resolve().parents[1]
FX_URL = 'https://open.er-api.com/v6/latest/USD'
FRESH = 36 * 3600
EXPIRE = 7 * 86400
LIMIT = 4_000_000
PLAN = re.compile(r'ChatGPT [A-Za-z0-9][A-Za-z0-9 +()./-]{0,70}\Z')
AMOUNT = re.compile(r'(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?\Z')
ZERO_DECIMAL = {'JPY', 'KRW', 'VND', 'CLP', 'PYG', 'UGX', 'RWF', 'XOF', 'XAF'}
THREE_DECIMAL = {'BHD', 'IQD', 'JOD', 'KWD', 'OMR', 'TND'}
PLAN_ORDER = ('ChatGPT Go', 'ChatGPT Plus', 'ChatGPT Pro 5x', 'ChatGPT Pro 20x')
BEIJING = timezone(timedelta(hours=8))


def stamp(now: float | None = None) -> str:
    return datetime.fromtimestamp(time.time() if now is None else now, timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def epoch(value: str) -> float:
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', value):
        raise ValueError('invalid UTC timestamp')
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def clean(value: str) -> str:
    return ' '.join(unicodedata.normalize('NFKC', value).split())


def url_for(code: str) -> str:
    if not re.fullmatch('[a-z]{2}', code):
        raise ValueError('invalid storefront')
    return f'https://apps.apple.com/{code}/app/chatgpt/id6448311069'


def semantic(market: dict) -> dict:
    return {'currency': market['currency'], 'offers': [
        {'label': offer['label'], 'amounts': [x['amount'] for x in offer['amounts']]}
        for offer in market['offers']]}


class Element:
    def __init__(self, tag='', attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Element):
                yield from child.walk()

    def text(self):
        return ''.join(x.text() if isinstance(x, Element) else x for x in self.children)


class Document(HTMLParser):
    VOID = {'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}

    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.root = Element()
        self.stack = [self.root]
        self.feed(text)
        self.close()

    def handle_starttag(self, tag, attrs):
        node = Element(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, text):
        self.stack[-1].children.append(text)


def walk_json(value):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from walk_json(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk_json(item)


def parse_amount(display: str, currency: str) -> str:
    text = clean(display).replace('\u066b', '.').replace('\u066c', ',')
    if not text or len(text) > 80 or not re.fullmatch('[A-Z]{3}', currency):
        raise ValueError('invalid price text or currency')
    # Apple's Indonesian compact prices use a decimal comma and named scale.
    compact = re.fullmatch(r'(?:Rp|IDR) ?([0-9]+(?:,[0-9]{1,3})?) ?(ribu|juta)', text)
    if compact:
        if currency != 'IDR':
            raise ValueError('compact currency disagrees with storefront')
        value = Decimal(compact[1].replace(',', '.')) * (1000 if compact[2] == 'ribu' else 1000000)
    else:
        affixes = {
            'USD': {'$', 'US$'}, 'CAD': {'$', 'CA$'}, 'AUD': {'$', 'A$'},
            'NZD': {'$', 'NZ$'}, 'GBP': {'£'}, 'EUR': {'€'}, 'JPY': {'¥'},
            'CNY': {'¥'}, 'KRW': {'₩'}, 'TWD': {'NT$', '$'}, 'SGD': {'S$', '$'},
            'MYR': {'RM'}, 'THB': {'฿'}, 'VND': {'đ', '₫'}, 'IDR': {'Rp'},
            'PHP': {'₱'}, 'INR': {'₹'}, 'PKR': {'Rs'}, 'TRY': {'₺'},
            'BRL': {'R$'}, 'MXN': {'$', 'MX$'}, 'CLP': {'$'}, 'COP': {'$'},
            'PEN': {'S/'}, 'ZAR': {'R'}, 'ILS': {'₪'}, 'CZK': {'Kč'},
            'PLN': {'zł'}, 'RON': {'lei'}, 'SEK': {'kr'}, 'NOK': {'kr'},
            'DKK': {'kr'}, 'KZT': {'₸'}, 'NGN': {'₦'},
        }.get(currency, set()) | {currency}
        match = re.fullmatch(r"([^0-9]*)([0-9](?:[0-9., '\u2019]*[0-9])?)([^0-9]*)", text)
        if not match:
            raise ValueError('missing or multiple prices')
        prefix, number, suffix = (part.strip() for part in match.groups())
        if (bool(prefix) + bool(suffix) != 1) or (prefix or suffix) not in affixes:
            raise ValueError('unknown currency affix or amount unit')
        number = number.replace('’', "'")
        digits = 0 if currency in ZERO_DECIMAL else 3 if currency in THREE_DECIMAL else 2
        decimal = None
        if digits:
            for sep in ('.', ','):
                if sep in number and len(number.rsplit(sep, 1)[1]) == digits:
                    if decimal is not None:
                        raise ValueError('ambiguous decimal')
                    decimal = sep
        integer, fraction = number.rsplit(decimal, 1) if decimal else (number, '')
        separators = set(re.findall(r"[., ']+", integer))
        if len(separators) > 1 or (decimal and decimal in integer):
            raise ValueError('inconsistent number grouping')
        if separators:
            separator = next(iter(separators))
            if len(separator) != 1:
                raise ValueError('invalid grouping separator')
            group = re.escape(separator)
            if not (re.fullmatch(rf'[0-9]{{1,3}}(?:{group}[0-9]{{3}})+', integer) or
                    re.fullmatch(rf'[0-9]{{1,2}}(?:{group}[0-9]{{2}})+{group}[0-9]{{3}}', integer)):
                raise ValueError('invalid thousands grouping')
        integer = re.sub(r"[., ']", '', integer)
        value = Decimal(integer + ('.' + fraction if fraction else ''))
    if not value.is_finite() or not Decimal('0') < value < Decimal('1000000000'):
        raise ValueError('invalid paid price')
    return format(value.normalize(), 'f')


def parse_store(text: str, code: str) -> dict:
    nodes = list(Document(text).root.walk())
    scripts = {n.attrs.get('id'): n.text() for n in nodes if n.tag == 'script'}
    for key in ('software-application', 'serialized-server-data'):
        if sum(n.tag == 'script' and n.attrs.get('id') == key for n in nodes) != 1:
            raise ValueError('missing or duplicate source script')
    canonical_links = [n.attrs.get('href') for n in nodes if n.tag == 'link' and n.attrs.get('rel') == 'canonical']
    if canonical_links != [url_for(code)]:
        raise ValueError('wrong canonical storefront or application')
    meta = json.loads(scripts.get('software-application', '{}'))
    if meta.get('name') != 'ChatGPT' or '/developer/' not in meta.get('author', {}).get('url', '') or not re.search(r'/id1684349733(?:\?|$)', meta['author']['url']):
        raise ValueError('not the official OpenAI application')
    # offers.price is the FREE app download. Only its currency is used here.
    currency = meta.get('offers', {}).get('priceCurrency')
    if not isinstance(currency, str) or not re.fullmatch('[A-Z]{3}', currency):
        raise ValueError('missing storefront currency')
    data = json.loads(scripts.get('serialized-server-data', '{}'))
    annotations = [n for n in walk_json(data) if n.get('$kind') == 'Annotation' and clean(n.get('title', '')).replace('‑', '-') == 'In-App Purchases']
    if len(annotations) != 1:
        raise ValueError('missing or ambiguous purchase annotation')
    annotation = annotations[0]
    pairs = [pair for item in annotation.get('items', []) for pair in item.get('textPairs', [])]
    v3 = [[item.get('leadingText'), item.get('trailingText')] for item in annotation.get('items_V3', []) if item.get('$kind') == 'textPair']
    if not pairs or pairs != v3:
        raise ValueError('structured representations disagree')
    # Cross-check visible price pairs, never search review/description prose for prices.
    visible = []
    for node in nodes:
        if node.tag == 'div' and 'text-pair' in node.attrs.get('class', '').split():
            spans = [x for x in node.children if isinstance(x, Element) and x.tag == 'span']
            if len(spans) == 2:
                visible.append([clean(x.text()) for x in spans])
    expected = [[clean(a), clean(b)] for a, b in pairs]
    if any(visible.count(pair) != expected.count(pair) for pair in expected):
        raise ValueError('visible and structured prices disagree')
    offers, ignored = {}, []
    for label, display in expected:
        if not PLAN.fullmatch(label):
            ignored.append(label)
            continue
        amount = parse_amount(display, currency)
        offers.setdefault(label, {})[amount] = display
    if not offers or len(pairs) > 40:
        raise ValueError('no recognized paid plans or unexpected purchase list')
    result = {'currency': currency, 'offers': [
        {'label': label, 'amounts': [{'amount': amount, 'display': values[amount]}
                                   for amount in sorted(values, key=Decimal)]}
        for label, values in sorted(offers.items())], 'unclassified_labels': sorted(set(ignored)),
        'source_sha256': hashlib.sha256(text.encode()).hexdigest()}
    result['fingerprint'] = digest(semantic(result))
    return result


class RestrictedRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        before, after = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(newurl)
        if after.scheme != 'https' or after.netloc != before.netloc or after.path != before.path:
            raise ValueError('cross-origin, country or path redirect rejected')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url: str, *, confirm=False, deadline=float('inf')) -> str:
    if not (url == FX_URL or re.fullmatch(r'https://apps\.apple\.com/[a-z]{2}/app/chatgpt/id6448311069\?l=en-US', url)):
        raise ValueError('source URL is not allowlisted')
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (compatible; PublicPriceObserver/1.0)',
        'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache, no-store' if confirm else 'no-cache'})
    for attempt in range(3):
        if time.monotonic() >= deadline:
            raise TimeoutError('network run budget exhausted')
        try:
            with urllib.request.build_opener(RestrictedRedirect()).open(request, timeout=min(15, max(1, deadline-time.monotonic()))) as response:
                if int(response.headers.get('Age', '0')) > FRESH:
                    raise ValueError('source response is too old')
                raw = response.read(LIMIT + 1)
                if len(raw) > LIMIT:
                    raise ValueError('response exceeds size budget')
                return raw.decode('utf-8', errors='strict')
        except urllib.error.HTTPError as exc:
            if exc.code not in (408, 429, 500, 502, 503, 504) or attempt == 2:
                raise
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt == 2:
                raise
        time.sleep(1 + attempt * 2)
    raise RuntimeError('unreachable')


def unusual(old: dict, new: dict) -> bool:
    if old['currency'] != new['currency']:
        return True
    old_offers = {x['label']: x for x in old['offers']}
    new_offers = {x['label']: x for x in new['offers']}
    if len(new_offers) < len(old_offers) / 2:
        return True
    for label in old_offers.keys() & new_offers.keys():
        before, after = old_offers[label]['amounts'], new_offers[label]['amounts']
        if len(before) == len(after):
            for a, b in zip(before, after):
                ratio = Decimal(b['amount']) / Decimal(a['amount'])
                if ratio < Decimal('.5') or ratio > 2:
                    return True
    return False


def observe(config: dict, old: dict | None, now: float, getter=fetch) -> dict:
    result = copy.deepcopy(old) if old else {'code': config['code'], 'name': config['name'], 'source_url': url_for(config['code']), 'offers': []}
    result.update(name=config['name'], last_checked_at=stamp(now))
    try:
        candidate = parse_store(getter(url_for(config['code']) + '?l=en-US'), config['code'])
        changed = not old or old.get('fingerprint') != candidate['fingerprint']
        if changed:
            second = parse_store(getter(url_for(config['code']) + '?l=en-US', confirm=True), config['code'])
            if second['fingerprint'] != candidate['fingerprint']:
                raise ValueError('independent confirmation fetch disagrees')
            candidate = second
        if changed and old and old.get('offers') and unusual(old, candidate):
            pending = old.get('pending', {})
            if pending.get('fingerprint') != candidate['fingerprint'] or now - epoch(pending['since']) < 18 * 3600:
                result['pending'] = {'fingerprint': candidate['fingerprint'], 'since': pending['since'] if pending.get('fingerprint') == candidate['fingerprint'] else stamp(now)}
                result['status'] = 'pending'
                return result
        result.update(candidate, status='verified', last_verified_at=stamp(now))
        result.pop('pending', None)
        result.pop('error', None)
        result.pop('error_detail', None)
    except (ValueError, KeyError, TypeError, RecursionError, InvalidOperation, urllib.error.URLError, TimeoutError, OSError) as exc:
        result['status'] = 'retained' if result.get('offers') else 'unavailable'
        result['error'] = 'http_' + str(exc.code) if isinstance(exc, urllib.error.HTTPError) else 'source_unverified'
        result['error_detail'] = type(exc).__name__ + ': ' + clean(str(exc))[:160]
    return result


def collect_fx(now: float, old: dict | None, getter=fetch) -> dict | None:
    try:
        data = json.loads(getter(FX_URL))
        if data.get('result') != 'success' or data.get('base_code') != 'USD':
            raise ValueError('wrong FX base or status')
        updated = data['time_last_update_unix']
        if isinstance(updated, bool) or not isinstance(updated, (float, int)) or not -300 <= now - updated <= FRESH:
            raise ValueError('FX source timestamp is stale or future')
        rates = data['rates']
        if rates.get('USD') != 1 or not 1 < rates.get('CNY', 0) < 30:
            raise ValueError('FX units or base rate invalid')
        if len(rates) < 30 or any(not re.fullmatch('[A-Z]{3}', k) or isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 < v < 1e10 for k, v in rates.items()):
            raise ValueError('invalid FX rates')
        return {'source_url': FX_URL, 'updated_at': stamp(updated), 'rates': {k: str(v) for k, v in sorted(rates.items())}, 'fallback': False}
    except (ValueError, KeyError, TypeError, urllib.error.URLError, TimeoutError, OSError):
        if old and -300 <= now - epoch(old['updated_at']) <= EXPIRE:
            return dict(old, fallback=True)
        return None


def validate(data: dict, now: float | None = None) -> None:
    now = time.time() if now is None else now
    if data.get('schema') != 1 or data.get('channel') != 'ios-app-store' or data.get('billing_period') != 'not_disclosed' or data.get('purchase_eligibility') != 'not_verified':
        raise ValueError('invalid data contract')
    generated = epoch(data['generated_at'])
    if generated > now + 300 or data.get('revision') != digest({k: v for k, v in data.items() if k != 'revision'}):
        raise ValueError('invalid revision or generation time')
    codes = set()
    if not 1 <= len(data['markets']) <= 250:
        raise ValueError('invalid market count')
    for market in data['markets']:
        code = market['code']
        if code in codes or market['source_url'] != url_for(code):
            raise ValueError('duplicate or unsafe market identity')
        codes.add(code)
        if market['status'] not in ('verified', 'retained', 'unavailable', 'pending') or not isinstance(market['name'], str) or not 1 <= len(market['name']) <= 80:
            raise ValueError('invalid market status/name')
        if epoch(market['last_checked_at']) > generated:
            raise ValueError('invalid checked time')
        if market['offers']:
            if not re.fullmatch('[A-Z]{3}', market['currency']) or epoch(market['last_verified_at']) > epoch(market['last_checked_at']):
                raise ValueError('invalid verification time or currency')
            labels = set()
            for offer in market['offers']:
                if not PLAN.fullmatch(offer['label']) or offer['label'] in labels or not 1 <= len(offer['amounts']) <= 20:
                    raise ValueError('invalid plan or variants')
                labels.add(offer['label'])
                numbers = []
                for price in offer['amounts']:
                    if not AMOUNT.fullmatch(price['amount']) or parse_amount(price['display'], market['currency']) != price['amount']:
                        raise ValueError('amount disagrees with source display')
                    if price.get('cny') != converted(market, price['amount'], data['fx'], generated):
                        raise ValueError('CNY projection disagrees with FX')
                    numbers.append(Decimal(price['amount']))
                if numbers != sorted(set(numbers)):
                    raise ValueError('duplicate or unordered amounts')
            if market['fingerprint'] != digest(semantic(market)) or not re.fullmatch('[a-f0-9]{64}', market['source_sha256']):
                raise ValueError('invalid source fingerprint')
        elif market['status'] != 'unavailable':
            raise ValueError('empty verified market')
    fx = data['fx']
    if fx:
        if fx['source_url'] != FX_URL or epoch(fx['updated_at']) > generated + 300 or Decimal(fx['rates']['USD']) != 1:
            raise ValueError('invalid FX metadata')
        for code, rate in fx['rates'].items():
            if not re.fullmatch('[A-Z]{3}', code) or not Decimal(rate).is_finite() or not 0 < Decimal(rate) < Decimal('1e10'):
                raise ValueError('invalid FX rate')
        if not 1 < Decimal(fx['rates']['CNY']) < 30:
            raise ValueError('invalid CNY rate')
    if len(data['changes']) > 200:
        raise ValueError('history exceeds retention budget')


def converted(market: dict, amount: str, fx: dict | None, now: float) -> str | None:
    if not fx or now - epoch(fx['updated_at']) > EXPIRE or now - epoch(market['last_verified_at']) > EXPIRE:
        return None
    rate = fx['rates'].get(market['currency'])
    if not rate:
        return None
    value = Decimal(amount) / Decimal(rate) * Decimal(fx['rates']['CNY'])
    return format(value.quantize(Decimal('.01'), rounding=ROUND_HALF_UP), '.2f')


def plan_labels(data: dict) -> list[str]:
    labels = {offer['label'] for market in data['markets'] for offer in market['offers']}
    return [label for label in PLAN_ORDER if label in labels] + sorted(labels.difference(PLAN_ORDER))


def short_plan(label: str) -> str:
    return label.removeprefix('ChatGPT ')


def market_offer(market: dict, label: str) -> dict | None:
    return next((offer for offer in market['offers'] if offer['label'] == label), None)


def offer_min_cny(market: dict, label: str) -> Decimal | None:
    offer = market_offer(market, label)
    if not offer:
        return None
    values = [Decimal(amount['cny']) for amount in offer['amounts'] if amount.get('cny') is not None]
    return min(values) if values else None


def beijing_display(value: str) -> str:
    return datetime.fromtimestamp(epoch(value), timezone.utc).astimezone(BEIJING).strftime('%Y/%m/%d %H:%M')


def render_price_options(market: dict, plan: str, minimum: Decimal | None) -> str:
    offer = market_offer(market, plan)
    if not offer:
        return '<span class="missing-price">—</span>'
    options = []
    for amount in offer['amounts']:
        cny = Decimal(amount['cny']) if amount.get('cny') is not None else None
        badge = '<span class="minimum-badge">最低</span>' if minimum is not None and cny == minimum else ''
        converted = (
            f'<span class="price-symbol">¥</span><span class="price-amount">{format(cny, ",.2f")}</span>'
            if cny is not None else '<span class="price-amount">—</span>'
        )
        options.append(
            '<div class="price-option">'
            f'<strong class="price-cny">{badge}{converted}</strong>'
            f'<span class="price-local">{html.escape(amount["display"])}</span>'
            '</div>'
        )
    return ''.join(options)


def render(data: dict, template: str) -> str:
    plans = plan_labels(data)
    if not plans:
        raise ValueError('no plans available for static projection')
    default_plan = 'ChatGPT Plus' if 'ChatGPT Plus' in plans else plans[0]
    generated = epoch(data['generated_at'])
    fx_fresh = bool(data['fx']) and -300 <= generated - epoch(data['fx']['updated_at']) <= FRESH

    minimums: dict[str, Decimal | None] = {}
    winners: dict[str, list[dict]] = {}
    for plan in plans:
        candidates = []
        if fx_fresh:
            for market in data['markets']:
                value = offer_min_cny(market, plan)
                if (
                    market['status'] == 'verified'
                    and value is not None
                    and -300 <= generated - epoch(market['last_verified_at']) <= FRESH
                ):
                    candidates.append((value, market))
        minimum = min((item[0] for item in candidates), default=None)
        minimums[plan] = minimum
        winners[plan] = sorted(
            [market for value, market in candidates if minimum is not None and value == minimum],
            key=lambda market: market['code'],
        )

    minimum_cards = []
    for plan in plans:
        minimum = minimums[plan]
        plan_winners = winners[plan]
        if minimum is None or not plan_winners:
            minimum_cards.append(
                '<button type="button" class="minimum-card" disabled>'
                f'<span class="minimum-plan-label">{html.escape(short_plan(plan))}</span>'
                '<strong class="minimum-country">暂无可靠最低价</strong>'
                '<small class="minimum-price">—</small>'
                '</button>'
            )
            continue
        names = [market['name'] for market in plan_winners]
        country = (
            f'{html.escape("、".join(names[:3]))}等 {len(names)} 个地区'
            if len(names) > 3 else html.escape('、'.join(names))
        )
        minimum_cards.append(
            f'<button type="button" class="minimum-card" data-plan="{html.escape(plan)}" '
            f'data-market-id="{plan_winners[0]["code"]}" disabled>'
            f'<span class="minimum-plan-label">{html.escape(short_plan(plan))}</span>'
            f'<strong class="minimum-country">{country}</strong>'
            f'<small class="minimum-price">¥{format(minimum, ",.2f")}</small>'
            '</button>'
        )

    head = []
    for plan in plans:
        active = ' is-active-plan' if plan == default_plan else ''
        sort_value = 'ascending' if plan == default_plan else 'none'
        arrow = '↑' if plan == default_plan else '↕'
        head.append(
            f'<th scope="col" data-plan-header="true" data-plan="{html.escape(plan)}" '
            f'class="{active.strip()}" aria-sort="{sort_value}">'
            f'<button type="button" data-sort-plan="{html.escape(plan)}" disabled>'
            f'{html.escape(short_plan(plan))} <span aria-hidden="true">{arrow}</span>'
            '</button></th>'
        )

    rank_values = sorted({
        value for market in data['markets']
        if (value := offer_min_cny(market, default_plan)) is not None
    })
    rank_map = {value: index + 1 for index, value in enumerate(rank_values)}

    def sort_key(market: dict):
        value = offer_min_cny(market, default_plan)
        return (value is None, value if value is not None else Decimal('Infinity'), market['name'])

    rows = []
    for market in sorted(data['markets'], key=sort_key):
        value = offer_min_cny(market, default_plan)
        rank = rank_map.get(value) if value is not None else None
        rank_class = ' class="rank-top"' if rank is not None and rank <= 3 else ''
        status = '' if market['status'] == 'verified' else f' · {market["status"]}'
        cells = []
        for plan in plans:
            active = ' is-active-plan is-sorted' if plan == default_plan else ''
            minimum_class = ''
            if minimums[plan] is not None and offer_min_cny(market, plan) == minimums[plan] and market in winners[plan]:
                minimum_class = ' is-minimum'
            cells.append(
                f'<td class="price-cell{active}{minimum_class}" data-plan="{html.escape(plan)}">'
                f'{render_price_options(market, plan, minimums[plan] if market in winners[plan] else None)}</td>'
            )
        rows.append(
            f'<tr data-market-id="{market["code"]}">'
            f'<td{rank_class}>{rank if rank is not None else "—"}</td>'
            '<td><button type="button" class="country-history-button" disabled>'
            f'<span class="country-name">{html.escape(market["name"])}</span>'
            f'<span class="mobile-rank" aria-hidden="true">{rank if rank is not None else "—"}</span>'
            f'<span class="country-meta">{market["code"].upper()} · {html.escape(market.get("currency", "—"))}{html.escape(status)}</span>'
            '<span class="history-affordance" aria-hidden="true">›</span>'
            '<span class="visually-hidden">，启用 JavaScript 后查看价格历史</span>'
            '</button></td>'
            + ''.join(cells)
            + '</tr>'
        )

    payload = canonical(data).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    priced_markets = [market for market in data['markets'] if market['offers']]
    values = {
        'MINIMUMS': '\\n'.join(minimum_cards),
        'TABLE_HEAD': '\\n'.join(head),
        'ROWS': '\\n'.join(rows),
        'DATA': payload,
        'GENERATED_BEIJING': beijing_display(data['generated_at']),
        'REVISION': data['revision'],
        'COUNT': str(len(priced_markets)),
        'RESULT_COUNT': str(len(priced_markets)),
        'TOTAL': str(len(data['markets'])),
        'CURRENCY_COUNT': str(len({market.get('currency') for market in priced_markets if market.get('currency')})),
        'PLAN_COUNT': str(len(plans)),
    }
    for key, value in values.items():
        marker = '{{' + key + '}}'
        if template.count(marker) != 1:
            raise ValueError('template marker missing or duplicated: ' + key)
        template = template.replace(marker, value)
    return template


def run(output: Path, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    config = json.loads((ROOT / 'markets.json').read_text(encoding='utf-8'))
    if len({c['code'] for c in config}) != len(config):
        raise ValueError('duplicate configured storefront')
    previous_path = ROOT / 'data/prices.json'
    old = json.loads(previous_path.read_text(encoding='utf-8')) if previous_path.exists() else None
    if old:
        validate(old, now)
    previous = {m['code']: m for m in old['markets']} if old else {}
    deadline = time.monotonic() + 240
    getter = lambda url, **kw: fetch(url, deadline=deadline, **kw)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        markets = list(executor.map(lambda c: observe(c, previous.get(c['code']), now, getter), config))
    for market in markets:
        if market.get('error'):
            print('SOURCE_ERROR', market['code'], market['error_detail'], flush=True)
    known = sum(bool(m['offers']) for m in markets)
    verified = sum(m['status'] == 'verified' for m in markets)
    if verified < max(10, int(sum(bool(m['offers']) for m in previous.values()) * .8)) or known < len(config) * .6:
        raise ValueError('insufficient fresh source coverage; existing publication left untouched')
    fx = collect_fx(now, old.get('fx') if old else None, getter)
    for market in markets:
        for offer in market['offers']:
            for price in offer['amounts']:
                price['cny'] = converted(market, price['amount'], fx, now)
    changes = list(old['changes']) if old else []
    for market in markets:
        before = previous.get(market['code'])
        if market['status'] == 'verified' and before and before.get('offers') and before['fingerprint'] != market['fingerprint']:
            changes.append({'at': stamp(now), 'code': market['code'], 'before': semantic(before), 'after': semantic(market)})
    data = {'schema': 1, 'channel': 'ios-app-store', 'billing_period': 'not_disclosed', 'purchase_eligibility': 'not_verified',
            'generated_at': stamp(now), 'markets': markets, 'fx': fx, 'changes': changes[-200:]}
    data['revision'] = digest(data)
    validate(data, now)
    page = render(data, (ROOT / 'index.template.html').read_text(encoding='utf-8'))
    output.mkdir(parents=True, exist_ok=True)
    # Output is staging only. Git publication atomically commits JSON and its HTML projection.
    (output / 'prices.json').write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    (output / 'index.html').write_text(page, encoding='utf-8')
    degraded = any(m['status'] in ('retained', 'pending') for m in markets) or fx is None or fx['fallback']
    message = f'核验成功 {verified}/{len(config)} 个地区；有标价 {known}；沿用/待复核 {sum(m["status"] in ("retained", "pending") for m in markets)}；汇率 {"降级" if fx is None or fx["fallback"] else "正常"}。'
    print(message)
    for m in markets:
        print(m['code'], m['status'], m.get('currency', '—'), ', '.join(x['label'] + ': ' + '/'.join(v['amount'] for v in x['amounts']) for x in m['offers']))
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
            stream.write(f'degraded={str(degraded).lower()}\n')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
            stream.write('## ChatGPT App Store 公开标价\n\n' + message + '\n\n只核验公开标价；周期、税费口径和新购资格未确认。非官网月费表。\n')
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--check', type=Path, help='Validate staged prices.json AND deterministic HTML, no network')
    args = parser.parse_args()
    if args.check:
        data = json.loads((args.check / 'prices.json').read_text(encoding='utf-8'))
        validate(data)
        if (args.check / 'index.html').read_text(encoding='utf-8') != render(data, (ROOT / 'index.template.html').read_text(encoding='utf-8')):
            raise ValueError('HTML is not the validated data projection')
        print('Data contract and static projection passed.')
    elif args.output:
        run(args.output)
    else:
        parser.error('choose --output or --check')


if __name__ == '__main__':
    main()
