"""Conservative policy for future ChatGPT App Store plan changes.

This module decides whether a source-confirmed change may be accepted immediately
or must first survive the pending window. It deliberately does not infer billing
periods, eligibility, promotions, or plan identity from price ratios.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

import plan_identity as plan_ids


@dataclass(frozen=True)
class Decision:
    kind: str
    quarantine: bool


def _offers_by_identity(offers: list[dict]) -> dict[str, dict] | None:
    indexed: dict[str, dict] = {}
    for offer in offers:
        identity = plan_ids.plan_identity(offer['label'])
        if identity in indexed:
            return None
        indexed[identity] = offer
    return indexed


def classify(old: dict, new: dict, *, ratio_low: Decimal, ratio_high: Decimal) -> Decision:
    """Classify one storefront change without guessing unknown plan relationships."""
    if old['currency'] != new['currency']:
        return Decision('currency_change', True)

    old_offers = _offers_by_identity(old['offers'])
    new_offers = _offers_by_identity(new['offers'])
    if old_offers is None or new_offers is None:
        return Decision('ambiguous_identity', True)

    old_ids, new_ids = set(old_offers), set(new_offers)
    removed = old_ids - new_ids
    added = new_ids - old_ids

    # Removal can mean retirement, replacement, split, or merge. The visible
    # source does not expose enough stable product metadata to distinguish those
    # safely, so require time-separated confirmation.
    if removed:
        return Decision('plan_removed_or_replaced', True)

    saw_known_rename = False
    saw_price_change = False
    for identity in sorted(old_ids & new_ids):
        before_offer, after_offer = old_offers[identity], new_offers[identity]
        if before_offer['label'] != after_offer['label']:
            saw_known_rename = True

        before = before_offer['amounts']
        after = after_offer['amounts']
        if len(before) != len(after):
            return Decision('variant_set_changed', True)

        for a, b in zip(before, after):
            old_amount = Decimal(a['amount'])
            new_amount = Decimal(b['amount'])
            if old_amount != new_amount:
                saw_price_change = True
            ratio = new_amount / old_amount
            if ratio < ratio_low or ratio > ratio_high:
                return Decision('extreme_price_change', True)

    if added:
        # Additions are non-destructive. Existing plans stay intact, so a newly
        # introduced plan can be published after the normal independent refetch.
        return Decision('plan_added', False)
    if saw_price_change and saw_known_rename:
        return Decision('known_rename_and_price_change', False)
    if saw_price_change:
        return Decision('price_change', False)
    if saw_known_rename:
        return Decision('known_rename', False)
    return Decision('metadata_only', False)
