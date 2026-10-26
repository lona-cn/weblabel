import type { SaveLease } from '../../../../../packages/contracts/generated/SaveLease';

export type AnnotationImportContext = {
  asset_revision_id: string;
  ontology_version_id: string;
  base_revision_id: string | null;
  lease: SaveLease | null;
};
