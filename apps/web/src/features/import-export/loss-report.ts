import { ApiFailure } from '../../lib/t15/api';
export type LossReport = { losses: { field: string; reason: string }[] };
export function readLossReport(value: unknown): LossReport | null {
  if (!value || typeof value !== 'object' || !('losses' in value) || !Array.isArray(value.losses) || Object.keys(value).some(key => key !== 'losses')) return null;
  const losses: LossReport['losses'] = [];
  for (const item of value.losses) {
    if (!item || typeof item !== 'object' || typeof item.field !== 'string' || !item.field || typeof item.reason !== 'string' || !item.reason || Object.keys(item).some(key => key !== 'field' && key !== 'reason')) return null;
    losses.push({ field: item.field, reason: item.reason });
  }
  return { losses };
}
export const explanations: Record<string, string> = {
  'annotation.attributes': '目标格式的标签文件不包含对象属性；详情以服务端报告为准。',
  'annotation.object_ids': '目标格式的标签文件不包含稳定对象 ID；详情以服务端报告为准。',
  'annotation.provenance': '目标格式的标签文件不包含对象来源；详情以服务端报告为准。',
  attributes: '对象属性无法完整表示，目标格式可能不保留属性。',
  attribute_defaults: '规范默认属性：这些值并非来源标注，仅按固定目标规范的默认值填入，不代表还原来源属性；请核对后明确决定是否接受。',
  origin: '对象来源及追溯引用将发生变化或无法保留。',
  provenance: '来源与追溯信息无法完整保留。',
  completion: '完成状态无法完整表示；空对象不表示已确认负样本。',
  revision_history: '版本身份与历史不会随这次转换完整保留。',
  object_ids: '对象身份会按目标格式重新编号，原对象ID不再保留。',
  other_images: '只导入明确选中的来源图，文件中的其他图片及其标注不会写入当前图片。',
  segmentation: '分割信息不属于本轮检测框支持范围。',
  iscrowd: '群体标记无法完整转换为本地检测框。',
};
export function failureText(error: unknown): string {
  if (!(error instanceof ApiFailure)) return '请求结果未知。请先核对当前状态，不要重复创建新的操作。';
  const messages: Record<string, string> = {
    REVISION_CONFLICT: '服务端标注基线已变化，本次请求存在版本冲突。',
    TASK_LEASE_REQUIRED: '该请求缺少当前任务所需的有效租约。',
    TASK_LEASE_LOST: '服务端核验的当前任务租约已失效。',
    TASK_ONTOLOGY_MISMATCH: '请求的标注规范与任务固定规范不一致。',
    PROJECT_WRITE_REQUIRED: '当前账户没有标注写入权限。',
    SOURCE_IMAGE_ID_REQUIRED: '多图 COCO 必须明确选择来源图。',
    INVALID_CLASS_MAPPING: '类别映射无效，请选择固定规范中的合法类别。',
    IMPORT_ALREADY_COMMITTED: '此预览已提交。请核对实际版本，不要创建新操作重复导入。',
    IDEMPOTENCY_CONFLICT: '操作标识已关联不同请求。请核对当前结果，不能改变原请求重放。',
    LOSS_ACK_REQUIRED: '服务端要求针对实际信息损失明确授权。',
  };
  return `${messages[error.code] ?? '服务端拒绝请求，请检查输入或权限后再操作。'} [${error.code}]${error.request_id ? ` 请求 ${error.request_id}` : ''}`;
}
export function diagnosticText(error: unknown): string {
  return error instanceof Error && !(error instanceof ApiFailure) ? error.message : failureText(error);
}
export function isAmbiguous(error: unknown): boolean { return !(error instanceof ApiFailure) || error.status >= 500; }
export function fileText(file: Blob, signal?: AbortSignal): Promise<string> {
  // ES2022 is the product runtime contract; Promise.withResolvers is unavailable.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    function cleanup() { signal?.removeEventListener('abort', abort); reader.onload = reader.onerror = reader.onabort = null; }
    function abort() { cleanup(); reader.abort(); reject(new DOMException('文件读取已取消', 'AbortError')); }
    reader.onload = () => { const text = String(reader.result); cleanup(); resolve(text); };
    reader.onerror = () => { const error = reader.error; cleanup(); reject(error); };
    reader.onabort = abort;
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true }); reader.readAsText(file);
  });
}
