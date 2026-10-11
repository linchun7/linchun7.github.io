import copy
import unittest

import pipeline as p
from live_candidate import validate_live_candidate
from test_pipeline import NOW, data_fixture, revise


START = p.epoch(p.stamp(NOW)) - 1000


def observed(template, amount, offset, code='us', name='美国'):
    market = copy.deepcopy(template)
    market.pop('history_baseline', None)
    market.update(code=code, name=name, source_url=p.url_for(code),
                  last_checked_at=p.stamp(START + offset),
                  last_verified_at=p.stamp(START + offset), status='verified')
    market['offers'] = [{'label': 'ChatGPT Plus', 'amounts': [{
        'amount': str(amount), 'display': '$' + str(amount) + '.00', 'cny': str(amount * 7) + '.00',
    }]}]
    market['fingerprint'] = p.digest(p.semantic(market))
    return market


def baseline_fixture(count=0, include_unaffected=True):
    data = data_fixture()
    template = data['markets'][0]
    first = observed(template, 20, 0)
    unaffected = observed(template, 80, 0, 'gb', '英国')
    previous = {'us': first, 'gb': unaffected}
    for market in previous.values():
        p.update_country_history({}, [market], [])
    changes = []
    current = first
    for offset in range(1, count + 1):
        following = observed(template, 20 + offset, offset)
        changes.append({'at': following['last_verified_at'], 'code': 'us',
                        'before': p.semantic(current), 'after': p.semantic(following)})
        current = following
    data['markets'] = [current]
    if include_unaffected:
        data['markets'].append(observed(template, 80, count, 'gb', '英国'))
    data['changes'] = p.update_country_history(previous, data['markets'], changes)
    data['generated_at'] = p.stamp(START + count)
    data['fx']['updated_at'] = p.stamp(START)
    revise(data)
    p.validate(data)
    return data


def candidate_fixture(baseline, change_price=True, new_market=False):
    candidate = copy.deepcopy(baseline)
    at = p.epoch(baseline['generated_at']) + 1
    candidate['generated_at'] = p.stamp(at)
    candidate['fx']['updated_at'] = p.stamp(at)
    for market in candidate['markets']:
        market['last_checked_at'] = market['last_verified_at'] = candidate['generated_at']
        market.pop('history_baseline', None)
    if change_price:
        market = candidate['markets'][0]
        amount = int(market['offers'][0]['amounts'][0]['amount']) + 1
        market['offers'][0]['amounts'][0].update(
            amount=str(amount), display='$' + str(amount) + '.00', cny=str(amount * 7) + '.00')
        market['fingerprint'] = p.digest(p.semantic(market))
    if new_market:
        candidate['markets'].append(observed(candidate['markets'][0], 30, at - START, 'ca', '加拿大'))
    previous, changes = p.scope_previous(baseline, {market['code'] for market in candidate['markets']})
    changes = copy.deepcopy(changes)
    for market in candidate['markets']:
        before = previous.get(market['code'])
        if p.should_record_history_change(before, market):
            changes.append({'at': candidate['generated_at'], 'code': market['code'],
                            'before': p.semantic(before), 'after': p.semantic(market)})
    candidate['changes'] = p.update_country_history(previous, candidate['markets'], changes)
    revise(candidate)
    p.validate(candidate)
    return candidate


def configuration(candidate):
    return [{'code': market['code'], 'name': market['name']} for market in candidate['markets']]


class LiveCandidateTests(unittest.TestCase):
    def test_200_201_202_keep_all_changes_and_original_baselines(self):
        baseline = baseline_fixture(200)
        original_baselines = {market['code']: copy.deepcopy(market['history_baseline'])
                              for market in baseline['markets']}
        for count in [201, 202]:
            candidate = candidate_fixture(baseline)
            before = copy.deepcopy((baseline, candidate))
            summary = validate_live_candidate(baseline, candidate, configuration(candidate))
            self.assertTrue(summary['history_transition_validated'])
            self.assertEqual(summary['pruned_changes'], 0)
            self.assertEqual(summary['retained_changes'], count)
            self.assertEqual(candidate['changes'][:-1], baseline['changes'])
            self.assertEqual(candidate['changes'][0], baseline['changes'][0])
            for market in candidate['markets']:
                self.assertEqual(market['history_baseline'], original_baselines[market['code']])
            self.assertEqual((baseline, candidate), before, 'validation cannot mutate trusted evidence')
            baseline = candidate

    def test_unchanged_full_history_keeps_all_changes_and_baselines(self):
        baseline = baseline_fixture(202)
        candidate = candidate_fixture(baseline, change_price=False)
        summary = validate_live_candidate(baseline, candidate, configuration(candidate))
        self.assertEqual(summary['pruned_changes'], 0)
        self.assertEqual(candidate['changes'], baseline['changes'])
        for old, current in zip(baseline['markets'], candidate['markets']):
            self.assertEqual(current['history_baseline'], old['history_baseline'])

    def test_individually_valid_retiming_of_retained_change_is_rejected(self):
        baseline = baseline_fixture(200)
        candidate = candidate_fixture(baseline)
        candidate['changes'][10]['at'] = candidate['changes'][11]['at']
        revise(candidate)
        p.validate(candidate)  # Same snapshots, continuous chain and legal timestamps.
        with self.assertRaisesRegex(ValueError, 'exact retained history transition'):
            validate_live_candidate(baseline, candidate, configuration(candidate))

    def test_individually_valid_deletion_and_baseline_advance_is_rejected(self):
        baseline = baseline_fixture(200)
        candidate = candidate_fixture(baseline)
        removed = candidate['changes'].pop(0)
        candidate['markets'][0]['history_baseline'] = {'at': removed['at'], 'snapshot': removed['after']}
        revise(candidate)
        p.validate(candidate)
        with self.assertRaisesRegex(ValueError, 'exact retained history transition'):
            validate_live_candidate(baseline, candidate, configuration(candidate))

    def test_unaffected_baseline_retiming_is_rejected_even_when_self_consistent(self):
        baseline = baseline_fixture(200)
        candidate = candidate_fixture(baseline)
        candidate['markets'][1]['history_baseline']['at'] = candidate['generated_at']
        revise(candidate)
        p.validate(candidate)
        with self.assertRaisesRegex(ValueError, 'exact history transition: gb'):
            validate_live_candidate(baseline, candidate, configuration(candidate))

    def test_unchanged_history_cannot_be_deleted_without_new_events(self):
        baseline = baseline_fixture(200)
        candidate = candidate_fixture(baseline, change_price=False)
        removed = candidate['changes'].pop(0)
        candidate['markets'][0]['history_baseline'] = {'at': removed['at'], 'snapshot': removed['after']}
        revise(candidate)
        p.validate(candidate)
        with self.assertRaisesRegex(ValueError, 'exact retained history transition'):
            validate_live_candidate(baseline, candidate, configuration(candidate))

    def test_current_revision_cannot_hide_tampered_history_snapshot(self):
        baseline = baseline_fixture(200)
        candidate = candidate_fixture(baseline)
        candidate['changes'][10]['before']['offers'][0]['amounts'] = ['999']
        revise(candidate)
        with self.assertRaisesRegex(ValueError, 'discontinuous'):
            validate_live_candidate(baseline, candidate, configuration(candidate))

    def test_self_consistent_tampered_old_snapshot_is_rejected(self):
        baseline = baseline_fixture(202)
        candidate = candidate_fixture(baseline)
        altered = candidate['changes'][10]['after']
        altered['offers'][0]['amounts'] = ['999']
        candidate['changes'][11]['before'] = copy.deepcopy(altered)
        revise(candidate)
        p.validate(candidate)  # Revision and chain alone cannot authenticate old evidence.
        with self.assertRaisesRegex(ValueError, 'exact retained history transition'):
            validate_live_candidate(baseline, candidate, configuration(candidate))

    def test_missing_country_baseline_is_not_accepted_as_legacy_candidate(self):
        baseline = baseline_fixture()
        candidate = candidate_fixture(baseline)
        candidate['markets'][0].pop('history_baseline')
        revise(candidate)
        p.validate(candidate)  # Schema-1 reads allow legacy baselines; new live output must not.
        with self.assertRaisesRegex(ValueError, 'exact history transition: us'):
            validate_live_candidate(baseline, candidate, configuration(candidate))

    def test_new_configured_market_has_its_own_first_observation_not_prior_lookup(self):
        baseline = baseline_fixture(include_unaffected=False)
        candidate = candidate_fixture(baseline, new_market=True)
        summary = validate_live_candidate(baseline, candidate, configuration(candidate))
        self.assertEqual(summary['verified_markets'], 2, 'coverage comes from config, not a fixed 59')
        self.assertEqual(summary['new_markets'], ['ca'])
        added = candidate['markets'][-1]
        self.assertEqual(added['history_baseline'], {'at': candidate['generated_at'], 'snapshot': p.semantic(added)})
        self.assertFalse(any(change['code'] == 'ca' for change in candidate['changes']))

    def test_new_market_cannot_claim_an_earlier_observation(self):
        baseline = baseline_fixture(include_unaffected=False)
        candidate = candidate_fixture(baseline, new_market=True)
        candidate['markets'][-1]['history_baseline']['at'] = baseline['generated_at']
        revise(candidate)
        p.validate(candidate)
        with self.assertRaisesRegex(ValueError, 'exact history transition: ca'):
            validate_live_candidate(baseline, candidate, configuration(candidate))

    def test_reviewed_alias_rename_preserves_original_baseline_without_new_event(self):
        baseline = baseline_fixture(include_unaffected=False)
        market = baseline['markets'][0]
        market['offers'][0]['label'] = 'ChatGPT Pro 20x'
        market['fingerprint'] = p.digest(p.semantic(market))
        market['history_baseline']['snapshot'] = p.semantic(market)
        revise(baseline)
        p.validate(baseline)
        candidate = candidate_fixture(baseline, change_price=False)
        current = candidate['markets'][0]
        current['offers'][0]['label'] = 'ChatGPT Pro $200'
        current['fingerprint'] = p.digest(p.semantic(current))
        revise(candidate)
        p.validate(candidate)
        summary = validate_live_candidate(baseline, candidate, configuration(candidate))
        self.assertEqual(summary['retained_changes'], 0)
        self.assertEqual(current['history_baseline'], market['history_baseline'])

    def test_two_markets_append_without_evicting_each_others_earliest_events(self):
        baseline = baseline_fixture()
        template = baseline['markets'][0]
        previous = {market['code']: copy.deepcopy(market) for market in baseline['markets']}
        current = copy.deepcopy(previous)
        changes = []
        for offset in range(1, 201):
            code, name = ('us', '美国') if offset % 2 else ('gb', '英国')
            following = observed(template, 100 + offset, offset, code, name)
            changes.append({'at': following['last_verified_at'], 'code': code,
                            'before': p.semantic(current[code]), 'after': p.semantic(following)})
            current[code] = following
        baseline['markets'] = [current['us'], current['gb']]
        baseline['changes'] = p.update_country_history(previous, baseline['markets'], changes)
        baseline['generated_at'] = p.stamp(START + 200)
        revise(baseline)
        p.validate(baseline)
        candidate = candidate_fixture(baseline)
        gb = candidate['markets'][1]
        price = gb['offers'][0]['amounts'][0]
        amount = int(price['amount']) + 1
        price.update(amount=str(amount), display='$' + str(amount) + '.00', cny=str(amount * 7) + '.00')
        gb['fingerprint'] = p.digest(p.semantic(gb))
        candidate['changes'].append({'at': candidate['generated_at'], 'code': 'gb',
                                     'before': p.semantic(baseline['markets'][1]), 'after': p.semantic(gb)})
        prior = {market['code']: market for market in baseline['markets']}
        candidate['changes'] = p.update_country_history(prior, candidate['markets'], candidate['changes'])
        revise(candidate)
        p.validate(candidate)
        summary = validate_live_candidate(baseline, candidate, configuration(candidate))
        self.assertEqual(summary['pruned_changes'], 0)
        self.assertEqual(summary['retained_changes'], 202)
        self.assertEqual(candidate['changes'][:200], baseline['changes'])
        for market in candidate['markets']:
            self.assertEqual(market['history_baseline'], previous[market['code']]['history_baseline'])
            first = next(change for change in candidate['changes'] if change['code'] == market['code'])
            self.assertEqual(first, next(change for change in baseline['changes'] if change['code'] == market['code']))

    def test_configured_removal_is_the_only_allowed_history_scope_reduction(self):
        baseline = baseline_fixture(2)
        old_gb = copy.deepcopy(baseline['markets'][1])
        current_gb = observed(old_gb, 81, 3, 'gb', '英国')
        baseline['markets'][1] = current_gb
        baseline['changes'].append({'at': current_gb['last_verified_at'], 'code': 'gb',
                                    'before': p.semantic(old_gb), 'after': p.semantic(current_gb)})
        baseline['changes'] = p.update_country_history({'gb': old_gb}, baseline['markets'], baseline['changes'])
        baseline['generated_at'] = p.stamp(START + 3)
        revise(baseline)
        p.validate(baseline)
        candidate = candidate_fixture(baseline)
        candidate['markets'] = candidate['markets'][:1]
        candidate['changes'] = [change for change in candidate['changes'] if change['code'] == 'us']
        revise(candidate)
        p.validate(candidate)
        self.assertEqual(validate_live_candidate(baseline, candidate, configuration(candidate))['verified_markets'], 1)
        self.assertTrue(any(change['code'] == 'gb' for change in baseline['changes']))
        self.assertFalse(any(change['code'] == 'gb' for change in candidate['changes']))

    def test_duplicate_missing_and_unconfigured_markets_fail_closed(self):
        baseline = baseline_fixture(include_unaffected=False)
        candidate = candidate_fixture(baseline)
        config = configuration(candidate)
        for malformed in [config + config, config + [{'code': 'ca', 'name': '加拿大'}],
                          [{'code': 'ca', 'name': '加拿大'}], []]:
            with self.subTest(config=malformed), self.assertRaises(ValueError):
                validate_live_candidate(baseline, candidate, malformed)

    def test_market_presentation_order_does_not_expand_the_configuration_contract(self):
        baseline = baseline_fixture(200)
        candidate = candidate_fixture(baseline)
        config = configuration(candidate)
        candidate['markets'].reverse()
        revise(candidate)
        p.validate(candidate)
        self.assertEqual(validate_live_candidate(baseline, candidate, config)['pruned_changes'], 0)

    def test_degraded_source_old_verification_and_fallback_fx_still_fail(self):
        baseline = baseline_fixture()
        candidate = candidate_fixture(baseline)
        for mutation in ['retained', 'old-verification', 'fallback-fx']:
            bad = copy.deepcopy(candidate)
            if mutation == 'retained':
                bad['markets'][0]['status'] = 'retained'
            elif mutation == 'old-verification':
                bad['markets'][0]['last_verified_at'] = baseline['generated_at']
            else:
                bad['fx']['fallback'] = True
            revise(bad)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                validate_live_candidate(baseline, bad, configuration(bad))


if __name__ == '__main__':
    unittest.main()
