import { describe, expect, it, jest } from '@jest/globals';
import { AdminRole } from '../constants/admin-account.constants';
import {
  ADMIN_AUDIT_RETENTION_DAYS,
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import { AdminAuditService } from './admin-audit.service';

const input = (reasonNote: string) => ({
  action: AdminAuditAction.USER_SUSPENDED,
  outcome: AdminAuditOutcome.SUCCEEDED,
  actor: {
    type: AdminAuditActorType.ADMIN_ACCOUNT,
    publicId: 'adm_23456789ABCD',
    username: 'moderator',
    displayName: 'Moderator',
    role: AdminRole.ADMIN,
    permission: AdminPermission.USERS_SUSPEND,
    permissionVersion: 1,
  },
  target: {
    type: AdminAuditTargetType.USER,
    publicId: 'usr_23456789AB',
  },
  reasonCode: 'moderation_policy',
  reasonNote,
  metadata: {
    beforeVersion: 1,
    afterVersion: 2,
    beforeState: 'NONE',
    afterState: 'TEMPORARY_SUSPENSION',
    affectedSessionCount: 1,
  },
  correlationId: 'corr_2026083000000001',
  source: AdminAuditSource.HTTP,
  mongoSession: { inTransaction: () => true },
});

const createService = () => {
  const auditModel = {
    insertMany: jest.fn(() =>
      Promise.resolve([{ publicId: 'aaud_23456789ABCDEFGH' }]),
    ),
  };
  const service = new AdminAuditService(
    auditModel as never,
    {
      retention: { adminAuditDays: ADMIN_AUDIT_RETENTION_DAYS },
      pagination: { maximumLimit: 100 },
    } as never,
  );
  return { auditModel, service };
};

describe('AdminAuditService moderation snapshot safety', () => {
  it.each([
    'Liên hệ must-not-store@example.com',
    'Gọi +84901234567 để xác minh',
    'Token eyJabcdefghijk.abcdefghijk.abcdefghijk',
    'API sk-1234567890abcdefghijklmnop',
    'Evidence https://res.cloudinary.com/private/image.jpg',
  ])('rejects raw contact, token or evidence material: %s', async (note) => {
    const fixture = createService();

    await expect(fixture.service.record(input(note) as never)).rejects.toThrow(
      'chứa dữ liệu bị cấm',
    );
    expect(fixture.auditModel.insertMany).not.toHaveBeenCalled();
  });

  it('accepts a bounded policy note without sensitive material', async () => {
    const fixture = createService();

    await expect(
      fixture.service.record(
        input('Vi phạm chính sách cộng đồng lặp lại') as never,
      ),
    ).resolves.toBe('aaud_23456789ABCDEFGH');
    expect(fixture.auditModel.insertMany).toHaveBeenCalledTimes(1);
  });
});
