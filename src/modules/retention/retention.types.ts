export type CleanupMode = 'retention' | 'test-marker';

export type CollectionCleanupResult = {
  collection: string;
  /** Observed count capped at the current budget plus one. */
  eligible: number;
  planned: number;
  processed: number;
  updated: number;
  deleted: number;
  skipped: number;
  failed: number;
  lostOwnership: number;
  manualReview: number;
  truncated: boolean;
  durationMs: number;
};

export type DataRetentionResult = {
  success: boolean;
  mode: CleanupMode;
  execute: boolean;
  database: string;
  maxDocuments: number;
  processed: number;
  updated: number;
  deleted: number;
  failed: number;
  lostOwnership: number;
  manualReview: number;
  requiresIntervention: boolean;
  hasMore: boolean;
  invalidEngagementEvents: number;
  backupReferenceAccepted: boolean;
  results: CollectionCleanupResult[];
};

export type RunDataRetentionOptions = {
  mode?: CleanupMode;
  execute?: boolean;
  maxDocuments?: number;
  confirmation?: string;
  backupReference?: string;
  now?: Date;
};
