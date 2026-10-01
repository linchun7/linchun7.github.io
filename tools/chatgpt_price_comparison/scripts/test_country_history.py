
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

    def test_pruning_advances_only_affected_market_boundaries(self):
        us0,gb0,ca0=market(),market('gb','80'),market('ca','5')
        for m in [us0,gb0,ca0]: p.update_country_history({},[m],[])
        us1,gb1,us2,us3=market(amount='21',offset=1),market('gb','81',offset=2),market(amount='22',offset=3),market(amount='23',offset=4)
        changes=[change(us0,us1,1),change(gb0,gb1,2),change(us1,us2,3),change(us2,us3,4)]
        markets=[us3,gb1,copy.deepcopy(ca0)]
        kept=p.update_country_history({'us':us0,'gb':gb0,'ca':ca0},markets,changes,limit=2)
        self.assertEqual(kept,changes[2:])
        self.assertEqual(us3['history_baseline'],{'at':p.stamp(START+1),'snapshot':p.semantic(us1)})
        self.assertEqual(gb1['history_baseline'],{'at':p.stamp(START+2),'snapshot':p.semantic(gb1)})
        self.assertEqual(markets[2]['history_baseline'],ca0['history_baseline'])
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
