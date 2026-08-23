import { AdminRole } from '../constants/admin-account.constants';
import {
  AdminAuditActorType,
  AdminAuditOutcome,
} from '../constants/admin-audit.constants';
import type { AdminUserModerationHistoryAction } from '../constants/admin-user-moderation-history.constants';

export type AdminUserModerationHistoryQuery = Readonly<{
  targetPublicId: string;
  page: number;
  limit: number;
}>;

export type PublicAdminUserModerationHistoryItem = Readonly<{
  id: string;
  action: AdminUserModerationHistoryAction;
  outcome: AdminAuditOutcome;
  actor:
    | Readonly<{
        publicId: string;
        role: AdminRole;
      }>
    | Readonly<{
        type: AdminAuditActorType.SYSTEM;
        displayName: string;
      }>;
  reason: Readonly<{
    code: string;
    note: string | null;
  }>;
  transition: Readonly<{
    beforeVersion: number | null;
    afterVersion: number | null;
    beforeState: string | null;
    afterState: string | null;
    affectedSessionCount: number | null;
  }>;
  occurredAt: string;
}>;

export type AdminUserModerationHistoryPage = Readonly<{
  items: readonly PublicAdminUserModerationHistoryItem[];
  pagination: Readonly<{
    page: number;
    limit: number;
    hasMore: boolean;
  }>;
}>;
