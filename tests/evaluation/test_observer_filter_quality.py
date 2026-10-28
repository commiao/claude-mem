import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('observer_filter_quality', Path(__file__).parents[2] / 'scripts/observer_filter_quality.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def output(ident, value='valuable', support='supported', ids=None):
    return {'id': ident, 'value': value, 'fact_support': support, 'persisted_ids': ids or []}


def case(ident, value, action, rows=None, tasks=1):
    return {'id': ident, 'input_value': value, 'action': action, 'source_task_count': tasks, 'outputs': rows or []}


class FilterQualityTest(unittest.TestCase):
    def test_noise_rejection_and_output_contamination_have_different_denominators(self):
        data = {'schema_version': 1, 'cases': [
            case('noise-skipped', 'none', 'skip'),
            case('noise-leaked', 'none', 'generated', [output('a', 'none', ids=[101])]),
            case('useful', 'valuable', 'generated', [output('b', ids=[102]), output('c', 'unknown', 'unknown')], tasks=2),
            case('useful-killed', 'valuable', 'skip'),
        ]}
        result = MODULE.aggregate(data)
        self.assertEqual(result['inputs']['no_value_rejection']['rate'], 0.5)
        self.assertEqual(result['inputs']['valuable_explicit_skip_false_rejection']['rate'], 0.5)
        self.assertEqual(result['generated']['no_value_contamination']['lower_bound'], 1 / 3)
        self.assertEqual(result['generated']['no_value_contamination']['upper_bound'], 2 / 3)
        self.assertEqual(result['newly_persisted']['no_value_contamination']['rate'], 0.5)
        self.assertEqual(result['conversion']['new_observations_per_source_task']['denominator'], 5)

    def test_shared_outcome_ids_are_unique_and_disputed_labels_become_unknown(self):
        result = MODULE.aggregate({'schema_version': 1, 'cases': [
            case('one', 'valuable', 'generated', [output('a', ids=[50, 50]), output('b', 'low', 'incorrect', [50])]),
        ]})
        self.assertEqual(result['conversion']['unique_new_observations'], 1)
        self.assertEqual(result['newly_persisted']['value_counts'], {'unknown': 1})
        self.assertEqual(result['newly_persisted']['fact_support_counts'], {'unknown': 1})
        self.assertEqual(result['newly_persisted']['no_value_contamination']['upper_bound'], 1)

    def test_one_new_observation_cannot_be_attributed_to_two_source_cases(self):
        with self.assertRaisesRegex(ValueError, 'multiple source cases'):
            MODULE.aggregate({'schema_version': 1, 'cases': [
                case('one', 'valuable', 'generated', [output('a', ids=[101])]),
                case('two', 'none', 'generated', [output('b', 'none', ids=[101])]),
            ]})

    def test_valuable_no_generation_is_separate_from_deliberate_skipping(self):
        result = MODULE.aggregate({'schema_version': 1, 'cases': [
            case('empty', 'valuable', 'empty'),
            case('unpersisted', 'valuable', 'generated', [output('a')]),
        ]})
        self.assertEqual(result['inputs']['valuable_explicit_skip_false_rejection']['rate'], 0)
        self.assertEqual(result['inputs']['valuable_no_generation']['rate'], 0.5)
        self.assertEqual(result['inputs']['valuable_without_new_observations']['rate'], 1)

    def test_combined_low_and_no_value_rates_exclude_valuable_and_unknown(self):
        result = MODULE.aggregate({'schema_version': 1, 'cases': [
            case('none', 'none', 'skip'),
            case('low', 'low', 'generated', [output('a', 'low', ids=[1])]),
            case('useful', 'valuable', 'generated', [output('b', ids=[2])]),
            case('unknown', 'unknown', 'skip'),
        ]})
        self.assertEqual(result['inputs']['low_or_no_value_rejection']['rate'], 0.5)
        self.assertEqual(result['inputs']['low_or_no_value_generation_leakage']['rate'], 0.5)
        self.assertEqual(result['inputs']['low_or_no_value_persistence_leakage']['rate'], 0.5)

    def test_unknown_is_not_silently_treated_as_success(self):
        result = MODULE.aggregate({'schema_version': 1, 'cases': [
            case('unknown', 'unknown', 'generated', [output('a', 'unknown', 'unknown', [1])])
        ]})
        self.assertIsNone(result['inputs']['no_value_rejection']['rate'])
        self.assertEqual(result['inputs']['value_review_coverage']['rate'], 0)
        self.assertEqual(result['generated']['no_value_contamination']['upper_bound'], 1)
        self.assertFalse(result['production_allowed'])

    def test_no_outputs_is_not_a_successful_noise_skip(self):
        result = MODULE.aggregate({'schema_version': 1, 'cases': [case('empty', 'none', 'empty')]})
        self.assertEqual(result['inputs']['no_value_rejection']['rate'], 0)
        self.assertIsNone(result['generated']['no_value_contamination']['rate'])
        self.assertEqual(result['conversion']['unique_new_observations'], 0)

    def test_duplicate_ids_and_inconsistent_action_are_rejected(self):
        for cases in [
            [case('same', 'none', 'skip'), case('same', 'none', 'skip')],
            [case('a', 'valuable', 'generated', [output('same')]), case('b', 'valuable', 'generated', [output('same')])],
            [case('a', 'none', 'skip', [output('a')])],
            [case('a', 'valuable', 'generated')],
        ]:
            with self.subTest(cases=cases), self.assertRaises(ValueError):
                MODULE.aggregate({'schema_version': 1, 'cases': cases})

    def test_unverified_inputs_and_boolean_ids_cannot_enter_counts(self):
        for bad in [
            case('a', 'none', 'skip', tasks=True),
            case('a', 'guessed', 'skip'),
            case('a', 'valuable', 'generated', [output('a', ids=[True])]),
        ]:
            with self.subTest(case=bad), self.assertRaises(ValueError):
                MODULE.aggregate({'schema_version': 1, 'cases': [bad]})


if __name__ == '__main__':
    unittest.main()
