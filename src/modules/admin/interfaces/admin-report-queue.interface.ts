import { type ReportQueuePriority } from '../../reports/constants/report-queue.constants';
import {
  type AdminReportQueueSlaFilter,
  type AdminReportQueueSort,
  type AdminReportQueueStatus,
  type AdminReportQueueType,
} from '../constants/admin-report-queue.constants';

export type AdminReportQueueQuery = Readonly<{
  page: number;
  limit: number;
  type?: AdminReportQueueType;
  status?: AdminReportQueueStatus;
  reason?: string;
  priority?: ReportQueuePriority;
  assignee?: string;
  sla?: AdminReportQueueSlaFilter;
  createdFrom?: string;
  createdTo?: string;
  sort: AdminReportQueueSort;
}>;

export enum AdminReportTargetAvailability {
  AVAILABLE = 'AVAILABLE',
  EXPIRED = 'EXPIRED',
  DELETED = 'DELETED',
  UNAVAILABLE = 'UNAVAILABLE',
  NOT_APPLICABLE = 'NOT_APPLICABLE',
}

export type PublicAdminReportQueueItem = Readonly<{
  id: string;
  publicId: string;
  type: AdminReportQueueType;
  status: AdminReportQueueStatus;
  source: 'USER_REPORT' | 'USER_AUTHENTICATED' | 'AUTH_PUBLIC';
  reasonCode: string;
  priority: ReportQueuePriority;
  assignee: Readonly<{
    publicId: string | null;
    assignedAt: string | null;
  }>;
  target: Readonly<{
    publicId: string | null;
    username: string | null;
    availability: AdminReportTargetAvailability;
    expireAt: string | null;
  }>;
  contact?: Readonly<{
    emailMasked: string | null;
  }>;
  sla: Readonly<{
    triageDueAt: string;
    decisionDueAt: string;
    isBreached: boolean;
  }>;
  version: number;
  createdAt: string;
  terminalAt: string | null;
}>;

export type AdminReportQueuePage = Readonly<{
  items: readonly PublicAdminReportQueueItem[];
  pagination: Readonly<{
    page: number;
    limit: number;
    hasMore: boolean;
  }>;
}>;
