{
  const initialUrl = new URL(location.href);
  const initialQuery = initialUrl.searchParams.get('q');
  if (initialQuery !== null) {
    globalThis.__icloudInitialQuery = initialQuery;
    initialUrl.searchParams.delete('q');
    history.replaceState(null, '', initialUrl);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  globalThis.__icloudInitialPriceRequest = fetch('data/prices.json', {
    cache: 'default',
    signal: controller.signal
  }).then(
    (response) => ({ response }),
    (error) => ({ error })
  ).finally(() => clearTimeout(timeout));
}
