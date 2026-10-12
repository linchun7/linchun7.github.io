import { assertStaticPageMatches, staticPageShell } from './static-page.mjs';
import { assertSeoProjectionMatches, renderSeoProjection } from './render-static-page.mjs';

// Only the deterministic price fragments and the six explicit SEO/brand
// projections may change in a data publication. Everything else remains exact.
export function assertSafeStaticPageUpdate(base, candidate, prices, history) {
  assertStaticPageMatches(candidate, prices, history);
  assertSeoProjectionMatches(candidate, prices);
  const expectedShell = staticPageShell(renderSeoProjection(base, prices));
  if (expectedShell !== staticPageShell(candidate)) {
    throw new Error('STATIC_PAGE_SHELL_CHANGED');
  }
  return true;
}
