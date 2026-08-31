import {
  AdminAuditActorType,
  AdminAuditOutcome,
} from '../constants/admin-audit.constants';
import { AdminRole } from '../constants/admin-account.constants';
import {
  type AdminModerationHistoryAction,
  AdminModerationHistoryResource,
  AdminModerationHistoryTargetAvailability,
  AdminModerationHistoryTargetType,
} from '../constants/admin-moderation-history.constants';

export type AdminModerationHistoryQuery = Readonly<{
  resource: AdminModerationHistoryResource;
  targetPublicId: string;
  page: number;
  limit: number;
}>;

export type PublicAdminModerationHistoryItem = Readonly<{
  id: string;
  action: AdminModerationHistoryAction;
  outcome: AdminAuditOutcome;
  actor: Readonly<{
    type: AdminAuditActorType;
    publicId: string | null;
    role: AdminRole | null;
  }>;
  reasonCode: string;
  transition: Readonly<{
    beforeVersion: number | null;
    afterVersion: number | null;
    beforeState: string | null;
    afterState: string | null;
  }>;
  correlationId: string | null;
  occurredAt: string;
}>;

export type AdminModerationHistoryPage = Readonly<{
  target: Readonly<{
    type: AdminModerationHistoryTargetType;
    publicId: string;
    availability: AdminModerationHistoryTargetAvailability;
  }>;
  items: readonly PublicAdminModerationHistoryItem[];
  pagination: Readonly<{
    page: number;
    limit: number;
    hasMore: boolean;
  }>;
}>;
