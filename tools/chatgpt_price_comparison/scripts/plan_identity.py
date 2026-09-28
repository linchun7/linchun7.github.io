"""Stable identities for ChatGPT App Store plan labels.

Apple may rename an in-app purchase without changing the underlying plan.  Keep
source labels untouched in prices.json, but use these identities for ordering,
rename-sensitive safety checks, and historical continuity.

Unknown labels intentionally keep their own identity.  This avoids guessing that
an actually new plan is a rename.
"""

PLAN_ORDER = (
    'ChatGPT Go',
    'ChatGPT Plus',
    'ChatGPT Pro 5x',
    'ChatGPT Pro 20x',
)

PLAN_ALIASES = {
    'ChatGPT Go': 'ChatGPT Go',
    'ChatGPT Plus': 'ChatGPT Plus',
    # OpenAI's current public naming for the lower Pro tier is Pro $100.
    # The App Store currently exposes the legacy "Pro 5x" label.
    'ChatGPT Pro 5x': 'ChatGPT Pro 5x',
    'ChatGPT Pro 5X': 'ChatGPT Pro 5x',
    'ChatGPT Pro $100': 'ChatGPT Pro 5x',
    # OpenAI currently describes the higher tier as Pro $200 (Pro 20X).
    'ChatGPT Pro 20x': 'ChatGPT Pro 20x',
    'ChatGPT Pro 20X': 'ChatGPT Pro 20x',
    'ChatGPT Pro $200': 'ChatGPT Pro 20x',
}


def plan_identity(label: str) -> str:
    return PLAN_ALIASES.get(label, label)


def plan_order_key(label: str) -> tuple[int, str, str]:
    identity = plan_identity(label)
    try:
        index = PLAN_ORDER.index(identity)
    except ValueError:
        index = len(PLAN_ORDER)
    return index, identity, label
