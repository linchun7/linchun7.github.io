const ORDER = ['ChatGPT Go', 'ChatGPT Plus', 'ChatGPT Pro 5x', 'ChatGPT Pro 20x'];
const ALIASES = new Map([
  ['ChatGPT Pro 5X', 'ChatGPT Pro 5x'], ['ChatGPT Pro $100', 'ChatGPT Pro 5x'], ['ChatGPT Pro 100', 'ChatGPT Pro 5x'],
  ['ChatGPT Pro 20X', 'ChatGPT Pro 20x'], ['ChatGPT Pro $200', 'ChatGPT Pro 20x'], ['ChatGPT Pro 200', 'ChatGPT Pro 20x'],
]);
const FRESH = 36 * 3600e3;
export const identity = label => ALIASES.get(label) || label;
function comparePlans(a, b) {
  const ai = ORDER.indexOf(identity(a));
  const bi = ORDER.indexOf(identity(b));
  return (ai < 0 ? ORDER.length : ai) - (bi < 0 ? ORDER.length : bi) || identity(a).localeCompare(identity(b)) || a.localeCompare(b);
}
export function plansFor(data) {
  const groups = new Map();
  for (const market of data.markets) for (const offer of market.offers) {
    const id = identity(offer.label);
    if (!groups.has(id)) groups.set(id, { all: new Map(), verified: new Map() });
    const group = groups.get(id);
    group.all.set(offer.label, (group.all.get(offer.label) || 0) + 1);
    if (market.status === 'verified') group.verified.set(offer.label, (group.verified.get(offer.label) || 0) + 1);
  }
  return [...groups].map(([id, group]) => {
    const counts = group.verified.size ? group.verified : group.all;
    return [...counts].sort((a, b) => b[1] - a[1] || (a[0] === id ? -1 : b[0] === id ? 1 : 0) || a[0].localeCompare(b[0]))[0][0];
  }).sort(comparePlans);
}
export function offerFor(market, plan) {
  const matches = market.offers.filter(offer => identity(offer.label) === identity(plan));
  return matches.length === 1 ? matches[0] : null;
}
function freshAt(timestamp, now) {
  const age = now - Date.parse(timestamp);
  return Number.isFinite(age) && age >= -300e3 && age <= FRESH;
}
export function comparableCents(data, market, plan, now) {
  if (market.status !== 'verified' || !freshAt(market.last_verified_at, now) || !data.fx || !freshAt(data.fx.updated_at, now)) return null;
  const offer = offerFor(market, plan);
  if (!offer) return null;
  const values = offer.amounts.filter(amount => amount.cny != null).map(amount => Number(amount.cny)).filter(Number.isFinite).map(value => Math.round(value * 100));
  return values.length ? Math.min(...values) : null;
}
export function comparisonFor(data, plan, now) {
  const rows = data.markets.map(market => ({ market, cents: comparableCents(data, market, plan, now) }));
  const prices = [...new Set(rows.filter(row => row.cents != null).map(row => row.cents))].sort((a,b) => a-b);
  const ranks = new Map(prices.map((price,index) => [price,index+1]));
  const minimum = prices.length ? prices[0] : null;
  const winners = rows.filter(row => minimum != null && row.cents === minimum).map(row => row.market).sort((a,b) => a.code.localeCompare(b.code));
  return { rows, ranks, minimum, winners };
}
