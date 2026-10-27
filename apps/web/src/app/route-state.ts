import type { TaskQueue } from '../features/review/workflow';

export interface RouteState {
  projectId: string | null;
  dataset: boolean;
  assetId: string;
  ontologyId: string;
  revisionId: string | null;
  queue: TaskQueue | undefined;
  taskId: string | null;
}

export function readRoute(url: URL): RouteState {
  const query = url.searchParams, queue = query.get('review_queue');
  return { projectId: query.get('project_id'), dataset: query.get('dataset_view') === '1', assetId: query.get('asset_revision_id') ?? '', ontologyId: query.get('ontology_version_id') ?? '', revisionId: query.get('annotation_revision_id'), taskId: query.get('task_id'), queue: queue && ['all','mine','pending','returned','closed'].includes(queue) ? queue as TaskQueue : undefined };
}
