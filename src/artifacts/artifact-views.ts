import type { Artifact } from '../generated/prisma/client.js';

/** docs/api-spec.md §0 ArtifactView (업로드 · 다운로드 API 는 S3 연동 단계에서 추가) */
export interface ArtifactView {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  previewable: boolean;
  createdAt: string;
}

export function toArtifactView(artifact: Artifact): ArtifactView {
  return {
    id: artifact.id,
    fileName: artifact.fileName,
    mimeType: artifact.mimeType,
    sizeBytes: Number(artifact.sizeBytes),
    previewable: artifact.previewable,
    createdAt: artifact.createdAt.toISOString(),
  };
}
