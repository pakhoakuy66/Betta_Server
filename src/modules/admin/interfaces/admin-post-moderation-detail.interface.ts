import type {
  ReportReasonGroup,
  ReportStatus,
} from '../../reports/schemas/report.schema';

export enum AdminPostModerationTargetState {
  AVAILABLE = 'AVAILABLE',
  HIDDEN = 'HIDDEN',
  EXPIRED = 'EXPIRED',
  DELETED = 'DELETED',
  UNAVAILABLE = 'UNAVAILABLE',
}

export type PublicAdminPostEvidenceMedia = Readonly<{
  url: string | null;
  redacted: boolean;
}>;

export type PublicAdminPostModerationDetail = Readonly<{
  reportPublicId: string;
  reportStatus: ReportStatus;
  reason: Readonly<{
    code: string;
    group: ReportReasonGroup;
    taxonomyVersion: number | null;
  }>;
  target: Readonly<{
    publicId: string | null;
    state: AdminPostModerationTargetState;
  }>;
  evidence: Readonly<{
    authorUsername: string | null;
    content: string;
    media: readonly PublicAdminPostEvidenceMedia[];
    createdAt: string | null;
    expireAt: string | null;
    evidenceUnavailable: boolean;
  }>;
}>;
