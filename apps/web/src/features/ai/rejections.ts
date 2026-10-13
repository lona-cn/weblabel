import { api, ApiFailure } from '../../lib/t15/api';
export interface RejectionOperation { operation_id: string; change_ids: string[]; created_at: string }
export interface RejectionState { suggestion_set_id: string; rejected_change_ids: string[]; operations: RejectionOperation[]; next_cursor: number | null }
export interface RejectionPayload { operation_id: string; change_ids: string[] }
export const rejectionApi = {
  read: (setId: string, operationId?: string, signal?: AbortSignal) => api.request<RejectionState>(`/api/ai/suggestions/${encodeURIComponent(setId)}/rejections${operationId ? `?operation_id=${encodeURIComponent(operationId)}` : ''}`, { signal }),
  reject: (setId: string, payload: RejectionPayload) => api.request<RejectionOperation & { suggestion_set_id: string }>(`/api/ai/suggestions/${encodeURIComponent(setId)}/rejections`, { method: 'POST', body: JSON.stringify(payload) }),
};
export function knownRejectionFailure(error: unknown): boolean { return error instanceof ApiFailure && error.status >= 400 && error.status < 500; }
export function checkedRejectionState(value: RejectionState, setId: string, knownIds: readonly string[]): RejectionState {
  if (value.suggestion_set_id !== setId || !Array.isArray(value.rejected_change_ids) || !value.rejected_change_ids.every(id => typeof id === 'string' && knownIds.includes(id)) || !Array.isArray(value.operations) || !value.operations.every(op => typeof op.operation_id === 'string' && Array.isArray(op.change_ids) && op.change_ids.every(id => knownIds.includes(id)))) throw new Error('拒绝状态与固定建议不匹配，不能采纳。');
  return value;
}
