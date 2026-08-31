import { describe, expect, it } from '@jest/globals';
import { AdminPermission } from './admin-permission.constants';
import {
  AdminReportTargetAction,
  getAdminReportTargetPermission,
} from './admin-report-decision.constants';

describe('admin report decision constants', () => {
  it.each([
    [AdminReportTargetAction.POST_HIDE, AdminPermission.POSTS_HIDE],
    [
      AdminReportTargetAction.POST_TERMINAL_DELETE,
      AdminPermission.POSTS_DELETE,
    ],
    [
      AdminReportTargetAction.USER_TEMPORARY_SUSPENSION,
      AdminPermission.USERS_SUSPEND,
    ],
    [AdminReportTargetAction.USER_INDEFINITE_BAN, AdminPermission.USERS_BAN],
    [AdminReportTargetAction.NONE, undefined],
  ] as const)('maps %s to its target permission', (action, permission) => {
    expect(getAdminReportTargetPermission(action)).toBe(permission);
  });
});
