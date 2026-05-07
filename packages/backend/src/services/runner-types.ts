// Shared between runner.ts and the agent adapters so adapters don't have
// to depend on the orchestrator (avoids a circular import).

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface ImageInput {
  mimeType: ImageMediaType;
  base64: string;
}
