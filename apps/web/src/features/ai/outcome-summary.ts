export interface RunOutcomeSummary {
  run: { run_id: string; project_id: string; state: string; cost_display: string };
  candidate_change_count: number; accepted_change_count: number; accept_journal_count: number;
  revert_journal_count: number; rejected_change_count: number;
  object_observations: { suggestion_set_id: string; change_id: string; object_id: string; accepted_revision_id: string; current_status: string; attribution: 'unknown' }[];
  task_binding: null | { basis: 'exact_decision_revision_submission'; submissions: { task_id: string; review_id: string; annotation_revision_id: string; asset_revision_id: string; ontology_version_id: string; task_state: string; review_state: string; decision_kinds: ('accept' | 'revert')[]; suggestion_set_ids: string[] }[]; truncated: boolean };
  activity_task_bindings: { task_id: string; recorded_work_seconds: number; basis: 'explicit_voluntary_run_task_interval' }[];
  recorded_work_seconds: number | null; work_time_scope: 'current_actor_explicit_run_intervals'; work_time_reason: string; usage: unknown; cost_display: string;
}
