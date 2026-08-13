import { describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import {
  AdminAccountStatus,
  AdminRole,
} from '../constants/admin-account.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import { AdminAccountStatusController } from './admin-account-status.controller';

const request = {
  user: {
    adminAccountId: new Types.ObjectId().toHexString(),
    id: 'adm_23456789ABCD',
    publicId: 'adm_23456789ABCD',
    username: 'root.admin',
    displayName: 'Root Admin',
    role: AdminRole.SUPER_ADMIN,
    sessionId: 'ases_23456789ABCDEFGHJKLMNPQR',
    credentialVersion: 2,
    authzVersion: 3,
    permissionVersion: 4,
  },
  get: jest.fn(() => 'test-agent'),
  socket: { remoteAddress: '127.0.0.1' },
};

const response = () => ({ setHeader: jest.fn() });

describe('AdminAccountStatusController', () => {
  it('maps lock permission and only allowlisted mutation fields', async () => {
    const statuses = {
      updateStatus: jest.fn<(input: unknown) => Promise<unknown>>(() =>
        Promise.resolve({ admin: { status: AdminAccountStatus.LOCKED } }),
      ),
    };
    const controller = new AdminAccountStatusController(statuses as never);
    const httpResponse = response();

    await controller.updateStatus(
      { publicId: 'adm_3456789ABCDE' },
      {
        status: AdminAccountStatus.LOCKED,
        expectedVersion: 4,
        reasonCode: 'security_review',
        reasonNote: 'Approved security response',
      },
      request as never,
      httpResponse as never,
    );

    expect(statuses.updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        targetPublicId: 'adm_3456789ABCDE',
        expectedVersion: 4,
        actor: expect.objectContaining({
          permission: AdminPermission.ADMINS_LOCK,
        }),
      }),
    );
    expect(httpResponse.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store, max-age=0',
    );
  });

  it('binds SuperAdmin unlock re-auth to unlock permission and target', async () => {
    const statuses = {
      issueSuperAdminStatusReauth: jest.fn<
        (input: unknown) => Promise<unknown>
      >(() => Promise.resolve({ grant: 'G'.repeat(43) })),
    };
    const controller = new AdminAccountStatusController(statuses as never);

    await controller.issueSuperAdminStatusReauth(
      { publicId: 'adm_3456789ABCDE' },
      {
        status: AdminAccountStatus.ACTIVE,
        password: 'Password!1',
        totpToken: '123456',
      },
      request as never,
      response() as never,
    );

    expect(statuses.issueSuperAdminStatusReauth).toHaveBeenCalledWith(
      expect.objectContaining({
        targetPublicId: 'adm_3456789ABCDE',
        status: AdminAccountStatus.ACTIVE,
        actor: expect.objectContaining({
          permission: AdminPermission.ADMINS_UNLOCK,
        }),
      }),
    );
  });
});
