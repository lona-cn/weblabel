import type { ConsentPreview } from './useRun';
import type { AnnotationDocument } from '../../../../../packages/contracts/generated/AnnotationDocument';
import type { OntologyVersion } from '../../../../../packages/contracts/generated/OntologyVersion';

export function Consent({ preview, confirmed, onChange, disabled = false, document = null, ontology = null }: {
  preview: ConsentPreview;
  confirmed: boolean;
  onChange: (confirmed: boolean) => void;
  disabled?: boolean;
  document?: AnnotationDocument | null;
  ontology?: OntologyVersion | null;
}) {
  const { profile, context, intent, prompt, grants } = preview;
  if (profile.provider_id === 'codex_local') return <section data-testid="ai-consent"><p role="status">此渠道已停用（PROVIDER_RETIRED），历史记录仍保留，不能授权新运行。</p></section>;
  const fixed = document?.asset_revision_id === context.asset_revision_id && document.ontology_version_id === context.ontology_version_id && ontology?.ontology_version_id === context.ontology_version_id && ontology.project_id === context.project_id ? document : null;
  const objects = fixed?.objects.filter(object => context.selected_object_ids.length === 0 || context.selected_object_ids.includes(object.object_id)) ?? [];
  const crop = grants.preview_crop;
  return (
    <section aria-labelledby="ai-consent-heading" data-testid="ai-consent">
      <h3 id="ai-consent-heading">确认本次授权</h3>
      <p>模型费用未知；取消运行不保证退款。</p>
      <p>{{ detector_local: '本地检测：授权图像在本机 worker 与本地权重间处理，不发送外部模型 API。', claude_local: '官方 runtime：本机启动 Claude 官方客户端，授权内容可流向官方远端服务；本地启动不等于模型在本机推理。', openai_api: '外部 API：授权指令、图像范围与对象详情经服务端发送至 OpenAI API。', anthropic_api: '外部 API：授权内容经服务端发送至 Anthropic API。', mimo_api: '外部 API：授权内容经服务端发送至 MiMo API。', mock: '模拟渠道：不是实际模型运行；人工标注不会调用模型。' }[profile.provider_id]}</p>
      <p>本地人工：图像 → 人工编辑 → 原生标注保存。AI 为额外的按次授权数据流，不替代人工流程。</p>
      <section aria-label="实际服务器授权范围">
        <h4>实际 server grants 对照</h4>
        {grants.allow_object_context && fixed ? <ul>{objects.map(object => <li key={object.object_id}>{ontology?.labels.find(label => label.label_id === object.label_id)?.name ?? object.label_id} #{fixed.objects.indexOf(object) + 1}<details><summary>对象版本与详情</summary><code>{object.object_id}</code><pre>{JSON.stringify(object.attributes, null, 2)}</pre><p>{JSON.stringify(object.geometry)}</p></details></li>)}</ul> : <p>{grants.allow_object_context ? '固定版本语义详情不可用；不能将当前对象误认为授权对象。' : '服务器授权不包含对象详情。'}</p>}
        {grants.allow_image && fixed ? <figure><svg role="img" aria-label={crop ? '服务器授权 crop 范围，虚线区域，只读' : '服务器授权整张 canonical 图片，只读'} viewBox={crop ? [crop.x_min, crop.y_min, crop.x_max - crop.x_min, crop.y_max - crop.y_min].join(' ') : '0 0 ' + fixed.coordinate_space.width + ' ' + fixed.coordinate_space.height} style={{ width: '100%', maxHeight: 240 }}>
          <image href={'/api/assets/' + encodeURIComponent(context.asset_revision_id) + '/image'} x={0} y={0} width={fixed.coordinate_space.width} height={fixed.coordinate_space.height} />
          {crop ? <rect x={crop.x_min} y={crop.y_min} width={crop.x_max - crop.x_min} height={crop.y_max - crop.y_min} fill="none" stroke="currentColor" strokeWidth={3} strokeDasharray="5 3" vectorEffect="non-scaling-stroke" /> : null}
        </svg><figcaption>{crop ? '局部 crop；范围为服务端返回的原始 canonical 像素坐标。' : '整图；范围包含此固定版本的完整 canonical 图像。'}</figcaption></figure> : <p>{grants.allow_image ? '图片可视对照不可用；请核对下方实际像素范围。' : '服务器未授权读取图像。'}</p>}
      </section>
      <dl>
        <dt>服务商与模型</dt><dd>{{ claude_local: 'Claude 官方运行', openai_api: 'OpenAI API', anthropic_api: 'Anthropic API', mimo_api: 'MiMo API', detector_local: '本地检测器', mock: '模拟结果（非真实模型）' }[profile.provider_id]} · {profile.model_id}</dd>
        <dt>任务</dt><dd>{{ audit_attributes: '检查属性', find_issues: '查找问题', detect: '检测对象' }[intent]}</dd>
        <dt>对象范围</dt><dd>{!grants.allow_object_context ? '不发送对象详情' : context.selected_object_ids.length ? context.selected_object_ids.join(', ') : '此版本中的全部对象'}</dd>
        <dt>图片访问</dt><dd>{grants.allow_image ? '允许读取图片' : '不允许读取图片'}</dd>
        <dt>对象详情访问</dt><dd>{!grants.allow_object_context ? '不允许读取对象详情' : context.selected_object_ids.length ? '允许读取所选对象' : '允许读取此版本全部对象'}</dd>
        <dt>图片范围</dt><dd>{grants.preview_crop ? `${grants.preview_crop.x_min}, ${grants.preview_crop.y_min} – ${grants.preview_crop.x_max}, ${grants.preview_crop.y_max}` : grants.allow_image ? '整张图片' : '不读取图片'}</dd>
        <dt>授权预览有效期</dt><dd>{preview.expires_at}</dd>
        <dt>指令（授权后才会发送给服务商）</dt><dd><q>{prompt}</q></dd>
      </dl>
      <details><summary>授权版本详情</summary><dl><dt>项目</dt><dd>{context.project_id}</dd><dt>图片版本</dt><dd>{context.asset_revision_id}</dd><dt>标注版本</dt><dd>{context.annotation_revision_id}</dd><dt>类别规范版本</dt><dd>{context.ontology_version_id}</dd></dl></details>
      <label>
        <input type="checkbox" checked={confirmed} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
        我已确认以上范围，同意本次运行。
      </label>
    </section>
  );
}
