import type { ReviewTask, TaskCreateTarget, TaskCreatePreparation, TaskSubmission } from './api';

export type LocalTaskLease = { asset_revision_id: string; ontology_version_id: string; task_id: string; fencing_token: number };
export type TaskOpenPreparation = { token: symbol; isCurrent(): boolean; validateCurrent(): Promise<boolean>; onTaskOpen(task: ReviewTask, lease: LocalTaskLease): void; release(): void };
export function wireSaveLease(lease: LocalTaskLease | null) { return lease ? { task_id: lease.task_id, fencing_token: lease.fencing_token } : null; }
export type TaskContinueInput = { task: ReviewTask; submission: TaskSubmission; isCurrent(): boolean };
export type TaskContinuationProof = { isCurrent(preparationToken: symbol | null): boolean };
export type TaskContinueResult = { task: ReviewTask; proof: TaskContinuationProof };

// Resolution only reads/validates; acquisition uses the existing task-open barrier.
export interface TaskSessionPort {
  onContinueTask?: (input: TaskContinueInput) => Promise<TaskContinueResult | null>;
  onPrepareTaskCreate: (target: TaskCreateTarget) => Promise<TaskCreatePreparation>;
  onPrepareTaskOpen: (task: ReviewTask, proof?: TaskContinuationProof) => Promise<TaskOpenPreparation>;
  onLeaseChange: (lease: LocalTaskLease | null) => void;
  onSubmitTask: (task: ReviewTask, submit: (revisionId: string) => Promise<void>) => Promise<void>;
}
