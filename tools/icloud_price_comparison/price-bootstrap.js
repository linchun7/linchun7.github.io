{
  const initialUrl = new URL(location.href);
  const maximumSearchCodePoints = 160;
  const publicRegions = new Set([
    'Americas',
    'Europe, Middle East & Africa',
    'Asia Pacific'
  ]);
  const boundedQuery = (value) => [...value.slice(0, maximumSearchCodePoints * 2)]
    .slice(0, maximumSearchCodePoints)
    .join('');
  const canonicalTier = (value) => {
    if (typeof value !== 'string' || value.length > 32 || !/^\d+(?:\.\d+)?(?:GB|TB)$/.test(value)) return null;
    const match = value.match(/^(\d+(?:\.\d+)?)(GB|TB)$/);
    const amount = Number(match[1]);
    const capacityGb = amount * (match[2] === 'TB' ? 1024 : 1);
    return Number.isFinite(capacityGb)
      && String(amount) === match[1]
      && capacityGb > 0
      && capacityGb <= 1024 * 1024
      ? value
      : null;
  };
  const tier = canonicalTier(initialUrl.searchParams.get('tier'));
  const sort = ['tier', 'country'].includes(initialUrl.searchParams.get('sort'))
    ? initialUrl.searchParams.get('sort')
    : null;
  const direction = ['asc', 'desc'].includes(initialUrl.searchParams.get('dir'))
    ? initialUrl.searchParams.get('dir')
    : null;
  const region = publicRegions.has(initialUrl.searchParams.get('region'))
    ? initialUrl.searchParams.get('region')
    : null;
  const initialQuery = initialUrl.searchParams.get('q');
  if (initialQuery !== null) globalThis.__icloudInitialQuery = boundedQuery(initialQuery);

  initialUrl.search = '';
  if (tier !== null) initialUrl.searchParams.set('tier', tier);
  if (sort !== null) initialUrl.searchParams.set('sort', sort);
  if (direction !== null) initialUrl.searchParams.set('dir', direction);
  if (region !== null) initialUrl.searchParams.set('region', region);
  if (initialUrl.hash && initialUrl.hash !== '#priceWorkspace') initialUrl.hash = '';
  if (initialUrl.href !== location.href) history.replaceState(null, '', initialUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  globalThis.__icloudInitialPriceRequest = fetch('data/prices.json', {
    cache: 'default',
    redirect: 'error',
    signal: controller.signal
  }).then(
    (response) => ({ response, finish: () => clearTimeout(timeout) }),
    (error) => {
      clearTimeout(timeout);
      return { error };
    }
  );
}
