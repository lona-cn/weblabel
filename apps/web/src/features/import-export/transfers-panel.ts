import type { TransfersMountContext } from '../workbench/workbench-context';
import { element, lifetime, createAuthorizedReadScope } from './delivery-dom';
import { mountMediaImportView } from './media-import-view';
import { mountAnnotationImportView } from './annotation-import-view';
import { mountRevisionExportView } from './revision-export-view';
export function mountTransfersPanel(root: HTMLElement, context: TransfersMountContext): () => void {
  const life = lifetime(context.signal); const panel = element('section', undefined, 'native-delivery'); panel.setAttribute('aria-label', '媒体与标注导入导出'); panel.dataset.testid = 'transfers-panel';
  const media = element('div'), annotations = element('div'), exports = element('div'); panel.append(media, annotations, exports); root.append(panel);
  const reads = createAuthorizedReadScope(life.signal, context.session, context.projectId, () => {
    const message = element('p', '当前身份或项目权限已变化，读取已停止；原请求与已确认回执保留。'); message.setAttribute('role', 'status'); panel.append(message);
  });
  const child = { ...context, signal: reads.signal, getScope() { reads.current(); return context.getScope(); } };
  life.add(reads.dispose);
  life.add(mountMediaImportView(media, child)); life.add(mountAnnotationImportView(annotations, child)); life.add(mountRevisionExportView(exports, child)); life.add(() => panel.remove()); reads.current(); return life.dispose;
}
