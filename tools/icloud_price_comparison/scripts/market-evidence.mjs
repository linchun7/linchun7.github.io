import { normalizedNameKey, resolveMarket } from './market-registry.mjs';

// The first source spelling in chronological snapshot evidence anchors a fallback
// ID. Never trust history.json's claimed ID as its own proof, and never hash a
// later case-only spelling again. Registry aliases still resolve to the same ID.
export function createSnapshotMarketResolver(index, snapshots, resolve = resolveMarket) {
  const firstByName = new Map();
  for (const publication of index.snapshots) {
    for (const revision of publication.revisions) {
      const snapshot = snapshots.get(revision.dataFile);
      if (!snapshot) throw new Error(`Missing market identity evidence: ${revision.dataFile}`);
      for (const { country } of snapshot.countries) {
        const key = normalizedNameKey(country);
        const market = resolve(country);
        const prior = firstByName.get(key);
        if (prior && !market.unknown && prior.id !== market.id) {
          throw new Error(`MARKET_IDENTITY_REKEY: ${country} changes ${prior.id} to ${market.id}`);
        }
        if (!prior) firstByName.set(key, market);
      }
    }
  }
  return (sourceName) => {
    const first = firstByName.get(normalizedNameKey(sourceName));
    if (!first) throw new Error(`Market source name has no snapshot evidence: ${sourceName}`);
    return { ...resolve(sourceName), id: first.id };
  };
}

// Exact evidence anchors only. Publication dating is for archive reconstruction;
// first confirmation dates an online observation. No interval/tolerance inference.
export function evidenceDateAnchors(publication, revision) {
  return [...new Set([publication.publishedDate, revision.firstConfirmedDate].filter(Boolean))];
}
