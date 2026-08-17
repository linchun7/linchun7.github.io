from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[3]
PROJECT = ROOT / 'tools' / 'icloud_price_comparison'


def replace_once(path, old, new):
    text = path.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one replacement, found {count}: {old[:100]!r}')
    path.write_text(text.replace(old, new, 1), encoding='utf-8')


def replace_regex_once(path, pattern, replacement):
    text = path.read_text(encoding='utf-8')
    next_text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'{path}: regex replacement count={count}: {pattern[:100]!r}')
    path.write_text(next_text, encoding='utf-8')

followup = PROJECT / 'test' / 'followup-hardening.test.mjs'
replace_once(
    followup,
    """  const html = typeof fragments === 'string' ? fragments : JSON.stringify(fragments);
  assert.match(html, /mobile-rank[^>]*aria-hidden=\\\"true\\\"/);
  assert.match(html, /mobile-rank-sr visually-hidden[^>]*>全球价格排名第 /);
""",
    """  const html = typeof fragments === 'string' ? fragments : Object.values(fragments).join('\\n');
  assert.match(html, /mobile-rank[^>]*aria-hidden=\"true\"/);
  assert.match(html, /mobile-rank-sr visually-hidden[^>]*>全球价格排名第 /);
"""
)

reservations = PROJECT / 'test' / 'market-identity-reservations.test.mjs'
replace_once(
    reservations,
    """    (error) => error.code === 'MARKET_IDENTITY_REKEY'
      && /future market Germany cannot reserve historical marketId de/.test(error.message)
""",
    """    (error) => error.code === 'MARKET_IDENTITY_RESERVED_ID_COLLISION'
      && error.generatedMarketId === 'de'
      && error.newSourceName === 'Germany'
      && error.reservedOwners.some(({ sourceName }) => sourceName === 'Legacy German Code Owner')
"""
)

update_test = PROJECT / 'test' / 'update-prices.test.mjs'
replace_once(
    update_test,
    "test('blocks only exact-price rename ambiguity and reports repriced structural candidates', () => {",
    "test('blocks unique structural rename ambiguity even when Apple reprices simultaneously', () => {"
)
replace_once(
    update_test,
    """  const oneTierResult = validateAppleMarketRenameReview({ countries: [old] }, [changedPrice], unknownResolver);
  assert.equal(oneTierResult.status, 'suspected');
  assert.deepEqual(oneTierResult.warnings, [{
    oldSourceName: 'Old Apple Market',
    newSourceName: 'New Apple Market',
    oldMarketId: 'old-id',
    region: 'Asia Pacific',
    currency: 'USD',
    pricesMatch: false
  }]);
  const allPricesChanged = structuredClone(added);
  for (const plan of Object.values(allPricesChanged.plans)) plan.price += 10;
  assert.equal(
    validateAppleMarketRenameReview({ countries: [old] }, [allPricesChanged], unknownResolver).status,
    'suspected'
  );
""",
    """  const repricedError = requiresReview([old], [changedPrice]);
  assert.equal(repricedError.candidates[0].pricesMatch, false);
  assert.match(repricedError.message, /\\[repriced\\]/);
  const allPricesChanged = structuredClone(added);
  for (const plan of Object.values(allPricesChanged.plans)) plan.price += 10;
  const allRepricedError = requiresReview([old], [allPricesChanged]);
  assert.equal(allRepricedError.candidates[0].pricesMatch, false);
"""
)

replace_regex_once(
    update_test,
    r"test\('full updater warns but publishes a confirmed rename candidate with repricing', async \(t\) => \{.*?\n\}\);\n\ntest\('full updater warns and publishes ambiguous exact rename candidates'",
    """test('full updater blocks a unique rename candidate with repricing before FX or production writes', async (t) => {
  const { root, paths } = await createTemporaryProductionPaths();
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousText = await readFile(paths.currentDataPath, 'utf8');
  const previous = JSON.parse(previousText);
  const changed = structuredClone(previous);
  const renamed = changed.countries.find(({ country }) => country === 'Bahamas');
  renamed.country = 'Renamed Bahamas Market';
  renamed.plans['50GB'].price += 1;
  renamed.plans['50GB'].formattedPrice = `$${renamed.plans['50GB'].price.toFixed(2)}`;
  const html = buildAppleHtml(changed);
  const originalFetch = globalThis.fetch;
  let appleRequests = 0;
  let fxRequests = 0;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('support.apple.com')) {
      appleRequests += 1;
      return new Response(html, { status: 200 });
    }
    fxRequests += 1;
    throw new Error(`FX must not be requested before repriced identity review: ${target}`);
  };
  try {
    await assert.rejects(
      () => main({ dryRun: false, paths, stepSummaryPath: null }),
      (error) => error.code === 'MARKET_IDENTITY_RENAME_REVIEW_REQUIRED'
        && error.candidates.some(({ oldMarketId, newSourceName, pricesMatch }) => (
          oldMarketId === 'bs' && newSourceName === 'Renamed Bahamas Market' && pricesMatch === false
        ))
    );
    assert.equal(appleRequests, 2);
    assert.equal(fxRequests, 0);
    assert.equal(await readFile(paths.currentDataPath, 'utf8'), previousText);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('full updater warns and publishes ambiguous exact rename candidates'"""
)

replace_once(
    update_test,
    "test('production preflight rejects a market identity re-key before any network request', async (t) => {",
    "test('production preflight rejects a different identity claiming a published marketId before any network request', async (t) => {"
)
replace_once(
    update_test,
    """    (error) => error.code === 'MARKET_IDENTITY_REKEY'
  );
});

async function copyCommittedSnapshotStore(paths) {
""",
    """    (error) => error.code === 'MARKET_IDENTITY_RESERVED_ID_COLLISION'
      && error.generatedMarketId === 'jp'
      && error.reservedOwners.some(({ sourceName }) => sourceName === 'Japan Legacy')
  );
});

async function copyCommittedSnapshotStore(paths) {
"""
)

print('follow-up test expectations repaired')
