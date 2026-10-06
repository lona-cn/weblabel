export interface ShutdownEvidence {
  evidence_kind: string;
  mode: string;
  source_commit: string;
  pre_signal: { model_state: string };
  host_marker: { actual_run_token_context_status: number };
  physical: {
    signal_count: number;
    signal_method: string;
    api_exit_code: number;
    terminal_exit_code: number;
    root_exit_at_api: number;
    descendant_exit_at_api: number;
  };
  cleanup: {
    host_listener_closed: boolean;
    api_listener_closed: boolean;
    runtime_lock_absent: boolean;
    sqlite_integrity: string;
    foreign_key_errors: unknown[];
    backstop_used_before_observation: boolean;
  };
}
export function activeHostShutdown(mode: string, release?: string): Promise<ShutdownEvidence>;
