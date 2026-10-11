
import copy
import json
import subprocess
import unittest
import pipeline as p

START = p.epoch('2026-09-24T02:13:15Z')
def market(code='us', amount='20', label='ChatGPT Plus', offset=0):
    m = {'code':code, 'currency':'USD', 'offers':[{'label':label,'amounts':[{'amount':amount}]}],
         'last_verified_at':p.stamp(START+offset), 'status':'verified'}
    m['fingerprint']=p.digest(p.semantic(m))
    return m
def change(old,new,offset):
    return {'code':new['code'],'at':p.stamp(START+offset),'before':p.semantic(old),'after':p.semantic(new)}
def data(markets,changes):
    return {'generated_at':p.stamp(START+100000),'markets':markets,'changes':changes}

class CountryHistoryTests(unittest.TestCase):
    def test_unchanged_verification_preserves_the_observed_baseline(self):
        old=market()
        p.update_country_history({},[old],[])
        original=copy.deepcopy(old['history_baseline'])
        for offset in [60,3600,86400]:
            current=market(offset=offset)
            self.assertEqual(p.update_country_history({'us':old},[current],[]),[])
            self.assertEqual(current['history_baseline'],original)
            p.validate_country_history_baselines(data([current],[]))
            old=current

    def test_reviewed_rename_preserves_date_and_creates_no_price_event(self):
        old=market(amount='100',label='ChatGPT Pro 5x')
        p.update_country_history({},[old],[])
        current=market(amount='100',label='ChatGPT Pro 100',offset=3600)
        self.assertFalse(p.should_record_history_change(old,current))
        p.update_country_history({'us':old},[current],[])
        self.assertEqual(current['history_baseline'],old['history_baseline'])
        p.validate_country_history_baselines(data([current],[]))

    def test_real_price_change_keeps_both_observation_times(self):
        old=market(); p.update_country_history({},[old],[])
        current=market(amount='22',offset=3600)
        changes=[change(old,current,3600)]
        kept=p.update_country_history({'us':old},[current],changes)
        self.assertEqual(current['history_baseline']['at'],p.stamp(START))
        self.assertEqual(kept[0]['at'],p.stamp(START+3600))
        p.validate_country_history_baselines(data([current],kept))

    def test_200_201_202_changes_keep_original_baselines_across_countries(self):
        us0,gb0,ca0=market(),market('gb','80'),market('ca','5')
        original={'us':us0,'gb':gb0,'ca':ca0}
        for m in original.values(): p.update_country_history({},[m],[])
        us1=market(amount='21',offset=1)
        changes=[change(us0,us1,1)]
        gb=gb0
        for index in range(1,200):
            following=market('gb',str(80+index),offset=index+1)
            changes.append(change(gb,following,index+1))
            gb=following
        markets=[us1,gb,copy.deepcopy(ca0)]
        kept=p.update_country_history(original,markets,changes)
        self.assertEqual(len(kept),200)
        self.assertEqual(kept,changes)
        p.validate_country_history_baselines(data(markets,kept))

        for code,following,offset in [
            ('gb',market('gb','280',offset=201),201),
            ('us',market(amount='22',offset=202),202),
        ]:
            previous={m['code']:m for m in markets}
            changes=kept+[change(previous[code],following,offset)]
            markets=[following if m['code']==code else copy.deepcopy(m) for m in markets]
            kept=p.update_country_history(previous,markets,changes)
            self.assertEqual(len(kept),offset)
            self.assertEqual(kept,changes)
            self.assertEqual(kept[0],change(us0,us1,1), 'other countries cannot evict the earliest US event')
            for m in markets:
                self.assertEqual(m['history_baseline'],original[m['code']]['history_baseline'])
            p.validate_country_history_baselines(data(markets,kept))

    def test_missing_legacy_time_is_unknown_not_current_verification(self):
        old=market(); current=market(amount='22',offset=3600)
        changes=[change(old,current,1800)]
        p.update_country_history({'us':copy.deepcopy(current)},[current],changes)
        self.assertIsNone(current['history_baseline']['at'])
        self.assertEqual(current['history_baseline']['snapshot'],p.semantic(old))
        p.validate_country_history_baselines(data([current],changes))

    def test_corrupt_future_and_discontinuous_baselines_are_rejected(self):
        old=market(); current=market(amount='22',offset=3600)
        changes=[change(old,current,3600)]
        p.update_country_history({'us':old},[current],changes)
        for mutation in ['future','wrong_price','wrong_shape','wrong_time_type']:
            candidate=copy.deepcopy(current)
            if mutation=='future': candidate['history_baseline']['at']=p.stamp(START+7200)
            elif mutation=='wrong_price': candidate['history_baseline']['snapshot']['offers'][0]['amounts']=['999']
            elif mutation=='wrong_shape': candidate['history_baseline']['extra']=True
            else: candidate['history_baseline']['at']=123
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):
                p.validate_country_history_baselines(data([candidate],changes))

    def test_current_seeded_history_is_bound_to_real_earliest_observation(self):
        current=json.loads((p.ROOT/'data/prices.json').read_text())
        self.assertTrue(all('history_baseline' in m for m in current['markets'] if m.get('offers')))
        p.validate_country_history_baselines(current)

    def test_ambiguous_aliases_are_not_silently_collapsed(self):
        one=p.semantic(market(amount='100',label='ChatGPT Pro 100'))
        duplicate=copy.deepcopy(one)
        duplicate['offers'].append({'label':'ChatGPT Pro 5x','amounts':['100']})
        self.assertNotEqual(p.history_snapshot_identity(one),p.history_snapshot_identity(duplicate))

if __name__=='__main__':
    unittest.main()
