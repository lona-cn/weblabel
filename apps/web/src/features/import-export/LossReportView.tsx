import { explanations, type LossReport } from './loss-report';
export function LossReportView({ report }: { report: LossReport }) {
  return <section aria-label="格式损失报告"><h4>实际损失报告</h4>{report.losses.length === 0 ? <p>服务端报告未列出损失。</p> : <ul>{report.losses.map((item, index) => <li key={index}><p>{explanations[item.field] ?? '该字段在目标格式或导入目标中发生变化，请核对技术说明后再决定。'}</p><dl><dt>field</dt><dd>{item.field}</dd><dt>reason</dt><dd>{item.reason}</dd></dl></li>)}</ul>}</section>;
}
