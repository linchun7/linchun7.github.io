import copy
import json
import re
import time
import unittest
from urllib.error import URLError
from urllib.request import Request
from unittest.mock import patch
from pathlib import Path
import tempfile

import pipeline as p

NOW = time.time()


def fixture(code='us', currency='USD', pairs=None):
    pairs = pairs or [['ChatGPT Plus', '$19.99'], ['ChatGPT Go', '$8.00'], ['ChatGPT Plus', '$200.00'], ['100 Credits', '$4.00']]
    app = {'name': 'ChatGPT', 'offers': {'price': 0, 'priceCurrency': currency}, 'author': {'url': f'https://apps.apple.com/{code}/developer/openai-opco-llc/id1684349733'}}
    annotation = {'$kind': 'Annotation', 'title': 'In-App Purchases', 'items': [{'$kind': 'AnnotationItem', 'textPairs': pairs}], 'items_V3': [{'$kind': 'textPair', 'leadingText': a, 'trailingText': b} for a,b in pairs]}
    return f'<link rel="canonical" href="{p.url_for(code)}"><script id=software-application type="application/ld+json">{json.dumps(app)}</script><div>' + ''.join(f'<div class="text-pair svelte-fixture"><span>{a}</span> <span>{b}</span></div>' for a,b in pairs) + f'</div><script type="application/json" id="serialized-server-data">{json.dumps({"data": [annotation]})}</script>'


def good_market():
    return p.observe({'code':'us', 'name':'美国'}, None, NOW, lambda *a,**kw: fixture())


def data_fixture():
    m = good_market()
    m['offers'].append({'label':'ChatGPT Pro 20x','amounts':[{'amount':'200','display':'$200.00'}]})
    m['offers'] = sorted(m['offers'], key=lambda offer: offer['label'])
    m['fingerprint'] = p.digest(p.semantic(m))
    rates = {'USD': '1', 'CNY': '7', 'JPY': '150'}
    fx = {'source_url': p.FX_URL, 'updated_at': p.stamp(NOW), 'rates': rates, 'fallback': False}
    for o in m['offers']:
        for a in o['amounts']:
            a['cny'] = p.converted(m, a['amount'], fx, NOW)
    d = {'schema':1, 'channel':'ios-app-store', 'billing_period':'not_disclosed', 'purchase_eligibility':'not_verified', 'generated_at':p.stamp(NOW), 'markets':[m], 'fx':fx, 'changes':[]}
    d['revision'] = p.digest(d)
    return d


def revise(d):
    d['revision'] = p.digest({k:v for k,v in d.items() if k != 'revision'})
    return d


class AmountTests(unittest.TestCase):
    def test_real_locales(self):
        cases = [('S/ 74.90','PEN','74.9'),('$19.99','USD','19.99'),('¥3,000','JPY','3000'),('₺5.299,99','TRY','5299.99'),('22,99\u00a0€','EUR','22.99'),('₹\u00a019,900','INR','19900'),('₹1,00,000','INR','100000'),('£88.90','GBP','88.9'),('CHF 19.00','CHF','19'),('KWD 6.990','KWD','6.99'),('19\u202f900 ₫','VND','19900'),('₩29,000','KRW','29000'),("CHF 1’999.00",'CHF','1999'),('RM 99.90','MYR','99.9'),('R$ 99,90','BRL','99.9')]
        for text, currency, expected in cases:
            with self.subTest(text=text): self.assertEqual(p.parse_amount(text, currency), expected)

    def test_reject_bad_or_ambiguous_prices(self):
        for text, currency in [('$0','USD'),('-$20','USD'),('$19.99/month','USD'),('$19.99 $200','USD'),('Free','USD'),('19,9 €','EUR'),('19.99,','USD'),('USD 20','JPY'),('€20','USD'),('$1.234,56.78','USD'),('$NaN','USD'),('10%','USD')]:
            with self.subTest(text=text), self.assertRaises((ValueError, p.InvalidOperation)): p.parse_amount(text, currency)


class ParsingTests(unittest.TestCase):
    def test_free_app_is_not_subscription_price(self):
        result = p.parse_store(fixture(), 'us')
        self.assertEqual(result['currency'], 'USD')
        self.assertEqual([o['label'] for o in result['offers']], ['ChatGPT Go','ChatGPT Plus'])
        self.assertEqual([a['amount'] for a in result['offers'][1]['amounts']], ['19.99','200'])
        self.assertEqual(result['unclassified_labels'], ['100 Credits'])
        self.assertNotIn('period', json.dumps(result))

    def test_new_plan_label_is_preserved(self):
        for label in ['ChatGPT New Tier', 'ChatGPT Pro ×5', 'ChatGPT Team & Business', 'ChatGPT Pro: Max']:
            with self.subTest(label=label):
                result = p.parse_store(fixture(pairs=[[label, '$44.00']]), 'us')
                self.assertEqual(result['offers'][0]['label'], label)

    def test_country_identity(self):
        with self.assertRaises(ValueError): p.parse_store(fixture('jp','JPY',[['ChatGPT Plus','¥3,000']]), 'us')

    def test_canonical_slug_can_change_when_storefront_and_app_id_match(self):
        changed = fixture().replace(
            p.url_for('us'),
            'https://apps.apple.com/us/app/chatgpt-ai/id6448311069'
        )
        self.assertEqual(p.parse_store(changed, 'us')['currency'], 'USD')

    def test_fake_developer(self):
        with self.assertRaises(ValueError): p.parse_store(fixture().replace('1684349733','9999999999'), 'us')

    def test_visible_disagreement(self):
        with self.assertRaises(ValueError): p.parse_store(fixture().replace('<span>$19.99</span>', '<span>$99.99</span>'), 'us')

    def test_missing_visible(self):
        with self.assertRaises(ValueError): p.parse_store(fixture().replace('class="text-pair', 'class="changed-pair'), 'us')

    def test_structured_disagreement(self):
        with self.assertRaises(ValueError): p.parse_store(fixture().replace('"trailingText": "$19.99"', '"trailingText": "$99.99"'), 'us')

    def test_duplicate_script(self):
        with self.assertRaises(ValueError): p.parse_store(fixture() + '<script id=software-application>{}</script>', 'us')

    def test_currency_semantic_identity(self):
        us = p.parse_store(fixture(), 'us')
        self.assertEqual(us['fingerprint'], p.digest(p.semantic(us)))

    def test_script_content_is_not_dom_price(self):
        source = fixture().replace('<span>$19.99</span>', '<span>unavailable</span>')
        with self.assertRaises(ValueError): p.parse_store(source, 'us')


class ObservationTests(unittest.TestCase):
    def test_initial_double_fetch(self):
        calls = []
        def getter(*a, **kw): calls.append(kw.get('confirm')); return fixture()
        result = p.observe({'code':'us','name':'美国'}, None, NOW, getter)
        self.assertEqual(result['status'], 'verified')
        self.assertEqual(calls, [None, True])

    def test_failure_preserves_exact_old_price_time(self):
        old = good_market()
        def fail(*a, **kw): raise URLError('offline')
        new = p.observe({'code':'us','name':'美国'}, old, NOW+86400, fail)
        self.assertEqual(new['status'], 'retained')
        self.assertEqual(new['last_verified_at'], old['last_verified_at'])
        self.assertNotEqual(new['last_checked_at'], old['last_checked_at'])
        self.assertEqual(new['offers'], old['offers'])
        self.assertEqual(old['status'], 'verified')

    def test_failure_without_baseline_never_creates_zero(self):
        new = p.observe({'code':'us','name':'美国'}, None, NOW, lambda *a,**kw: '403 forbidden')
        self.assertEqual(new['status'], 'unavailable')
        self.assertEqual(new['offers'], [])

    def test_normal_change_double_confirmed(self):
        old = good_market()
        new = p.observe({'code':'us','name':'美国'}, old, NOW+86400, lambda *a,**kw: fixture().replace('19.99','21.99'))
        self.assertEqual(new['status'], 'verified')
        self.assertNotEqual(new['fingerprint'], old['fingerprint'])

    def test_changed_price_disagreement_keeps_old(self):
        old = good_market()
        new = p.observe({'code':'us','name':'美国'}, old, NOW+86400, lambda *a,**kw: fixture().replace('19.99', '23.99' if kw else '21.99'))
        self.assertEqual(new['status'], 'retained')
        self.assertEqual(new['fingerprint'], old['fingerprint'])

    def test_plan_removal_and_variant_count_change_enter_pending(self):
        old = good_market()
        removed_plan = lambda *a, **kw: fixture(pairs=[
            ['ChatGPT Plus', '$19.99'],
            ['ChatGPT Plus', '$200.00'],
            ['100 Credits', '$4.00'],
        ])
        pending_removed = p.observe({'code':'us','name':'美国'}, old, NOW+86400, removed_plan)
        self.assertEqual(pending_removed['status'], 'pending')
        self.assertEqual(pending_removed['fingerprint'], old['fingerprint'])

        one_plus_variant = lambda *a, **kw: fixture(pairs=[
            ['ChatGPT Plus', '$19.99'],
            ['ChatGPT Go', '$8.00'],
            ['100 Credits', '$4.00'],
        ])
        pending_variant = p.observe({'code':'us','name':'美国'}, old, NOW+86400, one_plus_variant)
        self.assertEqual(pending_variant['status'], 'pending')
        self.assertEqual(pending_variant['fingerprint'], old['fingerprint'])

    def test_new_plan_addition_is_not_quarantined(self):
        old = good_market()
        getter = lambda *a, **kw: fixture(pairs=[
            ['ChatGPT Plus', '$19.99'],
            ['ChatGPT Go', '$8.00'],
            ['ChatGPT Plus', '$200.00'],
            ['ChatGPT New Tier', '$44.00'],
            ['100 Credits', '$4.00'],
        ])
        result = p.observe({'code':'us','name':'美国'}, old, NOW+86400, getter)
        self.assertEqual(result['status'], 'verified')
        self.assertIn('ChatGPT New Tier', [offer['label'] for offer in result['offers']])

    def test_large_jump_recovers_automatically_after_18_hours(self):
        old = good_market()
        getter = lambda *a,**kw: fixture().replace('19.99','99.99')
        waiting = p.observe({'code':'us','name':'美国'}, old, NOW+86400, getter)
        self.assertEqual(waiting['status'], 'pending')
        self.assertEqual(waiting['last_verified_at'], old['last_verified_at'])
        waiting2 = p.observe({'code':'us','name':'美国'}, waiting, NOW+86400+3600, getter)
        self.assertEqual(waiting2['pending'], waiting['pending'])
        accepted = p.observe({'code':'us','name':'美国'}, waiting2, NOW+2*86400, getter)
        self.assertEqual(accepted['status'], 'verified')
        self.assertNotIn('pending', accepted)

    def test_recovery_to_old_clears_pending(self):
        old = good_market(); old['pending'] = {'fingerprint':'bad','since':p.stamp(NOW)}
        result = p.observe({'code':'us','name':'美国'}, old, NOW+100, lambda *a,**kw: fixture())
        self.assertNotIn('pending', result)

    def test_redirect_country_host_or_app_rejected(self):
        handler = p.RestrictedRedirect()
        for target in [
            p.url_for('jp'),
            'http://apps.apple.com/us/app/chatgpt/id6448311069',
            'https://evil.example/us/app/chatgpt/id6448311069',
            'https://apps.apple.com/us/app/other/id1234567890',
        ]:
            with self.subTest(target=target), self.assertRaises(ValueError):
                handler.redirect_request(Request(p.url_for('us')), None, 302, '', {}, target)

    def test_language_and_slug_redirect_allowed(self):
        handler = p.RestrictedRedirect()
        language = handler.redirect_request(Request(p.url_for('de')+'?l=en-US'), None, 302, '', {}, p.url_for('de')+'?l=en-GB')
        self.assertIn('en-GB', language.full_url)
        slug = handler.redirect_request(
            Request(p.url_for('us')),
            None, 302, '', {},
            'https://apps.apple.com/us/app/chatgpt-ai/id6448311069'
        )
        self.assertIn('/us/app/chatgpt-ai/id6448311069', slug.full_url)

    def test_source_allowlist(self):
        with self.assertRaises(ValueError): p.fetch('https://example.com/')


class ContractTests(unittest.TestCase):
    def test_valid_data(self): p.validate(data_fixture(), NOW)

    def test_corruption(self):
        d=data_fixture(); d['markets'][0]['name']='changed'
        with self.assertRaises(ValueError): p.validate(d,NOW)

    def test_forged_cny(self):
        d=data_fixture(); d['markets'][0]['offers'][0]['amounts'][0]['cny']='1.00'; revise(d)
        with self.assertRaises(ValueError): p.validate(d,NOW)

    def test_duplicate_identity(self):
        d=data_fixture(); d['markets'].append(copy.deepcopy(d['markets'][0])); revise(d)
        with self.assertRaises(ValueError): p.validate(d,NOW)

    def test_no_monthly_inference(self):
        d=data_fixture(); d['billing_period']='month'; revise(d)
        with self.assertRaises(ValueError): p.validate(d,NOW)

    def test_future_timestamp(self):
        d=data_fixture(); d['generated_at']=p.stamp(NOW+10000); revise(d)
        with self.assertRaises(ValueError): p.validate(d,NOW)

    def test_expired_prices_not_converted(self):
        d=data_fixture(); m=d['markets'][0]
        self.assertIsNone(p.converted(m,'20',d['fx'],NOW+8*86400))

    def test_missing_currency_not_converted(self):
        d=data_fixture(); m=d['markets'][0]; m['currency']='AAA'
        self.assertIsNone(p.converted(m,'20',d['fx'],NOW))

    def test_decimal_exact(self):
        d=data_fixture(); m=d['markets'][0]
        self.assertEqual(p.converted(m,'19.99',d['fx'],NOW),'139.93')

    def test_fx_fallback_preserves_source_date(self):
        fx=data_fixture()['fx']
        result=p.collect_fx(NOW+86400,fx,lambda *a,**kw: '{}')
        self.assertEqual(result['updated_at'],fx['updated_at']); self.assertTrue(result['fallback'])
        self.assertIsNone(p.collect_fx(NOW+8*86400,fx,lambda *a,**kw: '{}'))

    def test_fx_wrong_base_and_stale_rejected(self):
        for base, updated in [('EUR',NOW),('USD',NOW+86400),('USD',NOW-3*86400)]:
            result=p.collect_fx(NOW,None,lambda *a,**kw: json.dumps({'result':'success','base_code':base,'time_last_update_unix':updated,'rates':{'USD':1,'CNY':7}}))
            self.assertIsNone(result)

    def test_fx_public_payload_keeps_only_required_currencies(self):
        rates = {'USD': 1, 'CNY': 7, 'JPY': 150}
        for first in 'ABCDEFGHIJ':
            for second in 'ABC':
                rates[f'X{first}{second}'] = 2
        payload = {'result':'success','base_code':'USD','time_last_update_unix':NOW,'rates':rates}
        result = p.collect_fx(NOW, None, lambda *a, **kw: json.dumps(payload), {'JPY'})
        self.assertEqual(set(result['rates']), {'USD', 'CNY', 'JPY'})

    def test_plus_display_heuristic_fails_open(self):
        annual_like = {'label':'ChatGPT Plus','amounts':[{'amount':'19.99'},{'amount':'200'}]}
        close_prices = {'label':'ChatGPT Plus','amounts':[{'amount':'19.99'},{'amount':'29.99'}]}
        three_prices = {'label':'ChatGPT Plus','amounts':[{'amount':'9.99'},{'amount':'19.99'},{'amount':'200'}]}
        pro20 = {'label':'ChatGPT Pro 20x','amounts':[{'amount':'200'}]}
        market = {'offers':[annual_like, pro20]}
        self.assertEqual([a['amount'] for a in p.display_amounts(market, annual_like)], ['19.99'])
        self.assertEqual([a['amount'] for a in p.display_amounts({'offers':[annual_like]}, annual_like)], ['19.99','200'])
        self.assertEqual([a['amount'] for a in p.display_amounts({'offers':[close_prices, pro20]}, close_prices)], ['19.99','29.99'])
        self.assertEqual([a['amount'] for a in p.display_amounts({'offers':[three_prices, pro20]}, three_prices)], ['9.99','19.99','200'])
        chile_like = {'label':'ChatGPT Plus','amounts':[{'amount':'19990'},{'amount':'229990'}]}
        chile_pro20 = {'label':'ChatGPT Pro 20x','amounts':[{'amount':'199990'}]}
        self.assertEqual([a['amount'] for a in p.display_amounts({'offers':[chile_like, chile_pro20]}, chile_like)], ['19990'])

    def test_static_projection_and_escape(self):
        d=data_fixture()
        d['markets'][0]['name']='</script><script>alert(1)</script>'; revise(d)
        template=(p.ROOT/'index.template.html').read_text(encoding='utf-8')
        page=p.render(d,template)
        self.assertNotIn('</script><script>alert(1)',page)
        self.assertIn('&lt;/script&gt;',page)
        self.assertEqual(page.count('<tr data-market-id="us">'),1)
        self.assertIn('class="country-history-button" disabled',page)
        self.assertIn('data-plan-header="true" data-plan="ChatGPT Go"',page)
        self.assertIn('data-plan-header="true" data-plan="ChatGPT Plus"',page)
        self.assertIn('class="minimum-card"',page)
        self.assertRegex(page, r'app\.js\?v=[a-f0-9]{12}')
        self.assertRegex(page, r'style\.css\?v=[a-f0-9]{12}')
        self.assertRegex(page, r'lucide-subset\.js\?v=[a-f0-9]{12}')
        self.assertRegex(page, r'<meta name="chatgpt-lucide-version" content="[a-f0-9]{12}">')
        self.assertIn('data-lucide="arrow-up"',page)
        self.assertIn('mobile-rank-sr visually-hidden',page)
        plus_cell = re.search(r'<td class="price-cell[^"]*" data-plan="ChatGPT Plus">([\s\S]*?)</td>', page)
        self.assertIsNotNone(plus_cell)
        self.assertIn('<span class="price-local">$19.99</span>', plus_cell.group(1))
        self.assertNotIn('<span class="price-local">$200.00</span>', plus_cell.group(1))
        self.assertIn('"display":"$200.00"',page)
        self.assertIn('139.93', plus_cell.group(1))
        self.assertNotIn('<span class="price-amount">1,400.00</span>', plus_cell.group(1))
        self.assertNotIn('id="refresh"',page)
        self.assertNotIn('\\n<tr data-market-id=',page)
        self.assertEqual(page,p.render(d,template))

    def test_history_contract_accepts_valid_and_rejects_malformed_entries(self):
        d=data_fixture()
        before=p.semantic(d['markets'][0])
        after=copy.deepcopy(before)
        after['offers'][0]['amounts'][0]='9'
        d['changes']=[{'at':p.stamp(NOW-60),'code':'us','before':before,'after':after}]
        revise(d)
        p.validate(d,NOW)

        bad_cases=[]
        future=copy.deepcopy(d); future['changes'][0]['at']=p.stamp(NOW+1); revise(future); bad_cases.append(future)
        bad_code=copy.deepcopy(d); bad_code['changes'][0]['code']='USA'; revise(bad_code); bad_cases.append(bad_code)
        same=copy.deepcopy(d); same['changes'][0]['after']=copy.deepcopy(same['changes'][0]['before']); revise(same); bad_cases.append(same)
        duplicate=copy.deepcopy(d); duplicate['changes'][0]['after']['offers'][0]['amounts']=['9','9']; revise(duplicate); bad_cases.append(duplicate)
        extra=copy.deepcopy(d); extra['changes'][0]['before']['extra']=True; revise(extra); bad_cases.append(extra)
        for candidate in bad_cases:
            with self.subTest(candidate=candidate['changes'][0]):
                with self.assertRaises(ValueError):
                    p.validate(candidate,NOW)

    def test_static_summary_uses_actual_default_plan_when_plus_is_absent(self):
        d=data_fixture()
        market=d['markets'][0]
        market['offers']=[offer for offer in market['offers'] if offer['label'] != 'ChatGPT Plus']
        market['fingerprint']=p.digest(p.semantic(market))
        revise(d)
        page=p.render(d,(p.ROOT/'index.template.html').read_text(encoding='utf-8'))
        self.assertIn('个地区 · Go 从低到高', page)
        self.assertNotIn('个地区 · Plus 从低到高', page)

    def test_many_tied_minimum_countries_are_compacted(self):
        d=data_fixture()
        base=d['markets'][0]
        d['markets']=[]
        for code,name in [('us','美国'),('gb','英国'),('ca','加拿大'),('au','澳大利亚')]:
            market=copy.deepcopy(base)
            market['code']=code
            market['name']=name
            market['source_url']=p.url_for(code)
            d['markets'].append(market)
        revise(d)
        page=p.render(d,(p.ROOT/'index.template.html').read_text(encoding='utf-8'))
        self.assertIn('4 个地区并列最低',page)
        self.assertNotIn('美国、英国、加拿大等 4 个地区',page)

    def test_committed_index_is_current_deterministic_projection(self):
        data=json.loads((p.ROOT/'data/prices.json').read_text(encoding='utf-8'))
        template=(p.ROOT/'index.template.html').read_text(encoding='utf-8')
        committed=(p.ROOT/'index.html').read_text(encoding='utf-8')
        self.assertEqual(committed, p.render(data, template))

    def test_bad_template_fails(self):
        with self.assertRaises(ValueError): p.render(data_fixture(),'no markers')

    def test_all_failure_does_not_write_output(self):
        config=[{'code':c,'name':c} for c in ['us','jp','de','gb','fr','it','ca','au','kr','in']]
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); (root/'markets.json').write_text(json.dumps(config), encoding='utf-8')
            with patch.object(p,'ROOT',root), patch.object(p,'observe',side_effect=lambda c,old,now,getter: dict(c,offers=[],status='unavailable')):
                with self.assertRaises(ValueError): p.run(root/'output',NOW)
            self.assertFalse((root/'output').exists())


if __name__ == '__main__': unittest.main(verbosity=2)
