import copy
import json
import os
from pathlib import Path
import subprocess
import time
import minimum_history
import pipeline as p
from test_pipeline import data_fixture, revise
MODES = ('verified','pending','mixed','aliases','stale_fx','expired_fx','retired_plan')
def fixture_data(mode):
    if mode not in MODES: raise ValueError(mode)
    now = int(time.time())
    data = data_fixture()
    data['generated_at'] = p.stamp(now)
    data['fx']['updated_at'] = p.stamp(now - 86400)
    base = data['markets'][0]
    base['offers'].extend([
        {'label':'ChatGPT Pro 5x','amounts':[{'amount':'100','display':'$100.00'}]},
        {'label':'ChatGPT Pro 500','amounts':[{'amount':'500','display':'$500.00'}]},
    ])
    base['offers'].sort(key=lambda offer: offer['label'])
    configured = json.loads((p.ROOT/'markets.json').read_text(encoding='utf-8'))
    selected = configured if mode == 'pending' else configured[:6]
    data['markets'] = []
    for index, config in enumerate(selected):
        market = copy.deepcopy(base)
        market.update(code=config['code'],name=config['name'],source_url=p.url_for(config['code']),last_checked_at=p.stamp(now),last_verified_at=p.stamp(now),status='verified')
        market.pop('pending',None)
        market.pop('error',None)
        market.pop('error_detail',None)
        if mode == 'aliases':
            high = ('ChatGPT Pro 20x','ChatGPT Pro 200','ChatGPT Pro $200')
            low = ('ChatGPT Pro 5x','ChatGPT Pro 100','ChatGPT Pro $100')
            for offer in market['offers']:
                if offer['label'] == 'ChatGPT Pro 20x': offer['label'] = high[index % 3]
                elif offer['label'] == 'ChatGPT Pro 5x': offer['label'] = low[index % 3]
            market['offers'].sort(key=lambda offer: offer['label'])
        if mode == 'pending' or (mode == 'mixed' and index == 2):
            market['status'] = 'pending'
            market['last_verified_at'] = p.stamp(now-120)
            market['pending'] = {'fingerprint':'a'*64,'since':p.stamp(now-60),'reason':'plan_added'}
        elif mode == 'mixed' and index == 1:
            market['status'] = 'retained'
            market['last_verified_at'] = p.stamp(now-120)
            market['error'] = 'source_unverified'
            market['error_detail'] = 'Fixture: source request failed'
        elif mode == 'mixed' and index == 3:
            market = {'code':config['code'],'name':config['name'],'source_url':p.url_for(config['code']),'last_checked_at':p.stamp(now),'status':'unavailable','offers':[],'error':'source_unverified','error_detail':'Fixture: no verified baseline'}
        elif mode == 'mixed' and index == 4:
            market['last_verified_at'] = p.stamp(now-p.FRESH-60)
        elif mode == 'mixed' and index == 5:
            market['currency'] = 'EUR'
            for offer in market['offers']:
                for amount in offer['amounts']: amount['display'] = 'EUR '+amount['amount']
        if market['offers']: market['fingerprint'] = p.digest(p.semantic(market))
        data['markets'].append(market)
    if mode == 'stale_fx':
        data['fx']['updated_at'] = p.stamp(now-p.FRESH-60)
        data['fx']['fallback'] = True
    elif mode == 'expired_fx':
        data['fx']['updated_at'] = p.stamp(now-p.EXPIRE-60)
        data['fx']['fallback'] = True
    for market in data['markets']:
        for offer in market['offers']:
            for amount in offer['amounts']: amount['cny'] = p.converted(market,amount['amount'],data['fx'],now)
    if mode == 'retired_plan':
        market = data['markets'][0]
        after = p.semantic(market)
        before = copy.deepcopy(after)
        before['offers'].append({'label':'ChatGPT Retired Fixture','amounts':['42']})
        before['offers'].sort(key=lambda offer: offer['label'])
        data['changes'] = [{'at':p.stamp(now-60),'code':market['code'],'before':before,'after':after}]
    revise(data)
    p.validate(data,now)
    return data
def main():
    paths = [p.ROOT/'data/prices.json',p.ROOT/'data/minimum-history.json',p.ROOT/'index.html']
    original = {path:path.read_bytes() for path in paths}
    try:
        for mode in MODES:
            data = fixture_data(mode)
            history = minimum_history.advance_history(minimum_history.empty_history(),data)
            minimum_history.assert_matches(history,data)
            paths[0].write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
            paths[1].write_text(json.dumps(history,ensure_ascii=False),encoding='utf-8')
            paths[2].write_text(p.render(data,(p.ROOT/'index.template.html').read_text(encoding='utf-8')),encoding='utf-8')
            print('Browser state fixture:',mode,flush=True)
            subprocess.run(['node',str(p.ROOT/'scripts/browser-test.mjs')],cwd=p.ROOT.parents[1],env={**os.environ,'REQUIRE_FUTURE_PLAN':'1','BROWSER_STATE_FIXTURE':mode},check=True)
    finally:
        for path,content in original.items(): path.write_bytes(content)
if __name__ == '__main__': main()
