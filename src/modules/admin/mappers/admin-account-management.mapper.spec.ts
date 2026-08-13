import { describe, expect, it } from '@jest/globals';
import { Types } from 'mongoose';
import {
  AdminAccountDeletionOrigin,
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import { toPublicManagedAdminAccount } from './admin-account-management.mapper';

describe('toPublicManagedAdminAccount', () => {
  it('maps an explicit immutable public contract without ObjectId or credentials', () => {
    const account = {
      _id: new Types.ObjectId(),
      publicId: 'adm_23456789ABCD',
      email: 'admin@betta.test',
      username: 'admin.owner',
      displayName: 'Admin Owner',
      role: AdminRole.ADMIN,
      status: AdminAccountStatus.SOFT_DELETED,
      mfaStatus: AdminMfaStatus.RESET_REQUIRED,
      mustChangePassword: true,
      version: 7,
      lockedAt: new Date('2026-08-10T01:00:00.000Z'),
      deletedAt: new Date('2026-08-10T02:00:00.000Z'),
      deletionOrigin: AdminAccountDeletionOrigin.ADMIN,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-10T02:00:00.000Z'),
      passwordHash: 'must-not-leak',
      encryptedTotpSecret: 'must-not-leak',
      recoveryCodeHashes: ['must-not-leak'],
    };

    const result = toPublicManagedAdminAccount(account, {
      activeCount: 2,
      lastActiveAt: '2026-08-10T00:30:00.000Z',
    });

    expect(result).toEqual({
      id: account.publicId,
      publicId: account.publicId,
      email: account.email,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      status: account.status,
      mfaStatus: account.mfaStatus,
      mustChangePassword: true,
      version: 7,
      sessionSummary: {
        activeCount: 2,
        lastActiveAt: '2026-08-10T00:30:00.000Z',
      },
      lockedAt: '2026-08-10T01:00:00.000Z',
      deletedAt: '2026-08-10T02:00:00.000Z',
      deletionOrigin: AdminAccountDeletionOrigin.ADMIN,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-10T02:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toContain(account._id.toHexString());
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sessionSummary)).toBe(true);
  });
});
