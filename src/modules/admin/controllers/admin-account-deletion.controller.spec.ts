import { describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { AdminRole } from '../constants/admin-account.constants';
import { AdminAccountDeletionAction } from '../constants/admin-account-deletion.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import { AdminAccountDeletionController } from './admin-account-deletion.controller';

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

describe('AdminAccountDeletionController', () => {
  it('maps delete permission and only allowlisted mutation fields', async () => {
    const deletions = {
      updateDeletion: jest.fn<(input: unknown) => Promise<unknown>>(() =>
        Promise.resolve({ admin: { status: 'SOFT_DELETED' } }),
      ),
    };
    const controller = new AdminAccountDeletionController(deletions as never);
    const httpResponse = response();

    await controller.updateDeletion(
      { publicId: 'adm_3456789ABCDE' },
      {
        action: AdminAccountDeletionAction.SOFT_DELETE,
        expectedVersion: 4,
        reasonCode: 'security_offboarding',
        reasonNote: 'Approved administrative offboarding',
      },
      request as never,
      httpResponse as never,
    );

    expect(deletions.updateDeletion).toHaveBeenCalledWith(
      expect.objectContaining({
        targetPublicId: 'adm_3456789ABCDE',
        expectedVersion: 4,
        actor: expect.objectContaining({
          permission: AdminPermission.ADMINS_DELETE,
        }),
      }),
    );
    expect(httpResponse.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store, max-age=0',
    );
  });

  it('binds SuperAdmin restore re-auth to restore permission and target', async () => {
    const deletions = {
      issueSuperAdminDeletionReauth: jest.fn<
        (input: unknown) => Promise<unknown>
      >(() => Promise.resolve({ grant: 'G'.repeat(43) })),
    };
    const controller = new AdminAccountDeletionController(deletions as never);

    await controller.issueReauth(
      { publicId: 'adm_3456789ABCDE' },
      {
        action: AdminAccountDeletionAction.RESTORE,
        password: 'Password!1',
        totpToken: '123456',
      },
      request as never,
      response() as never,
    );

    expect(deletions.issueSuperAdminDeletionReauth).toHaveBeenCalledWith(
      expect.objectContaining({
        targetPublicId: 'adm_3456789ABCDE',
        action: AdminAccountDeletionAction.RESTORE,
        actor: expect.objectContaining({
          permission: AdminPermission.ADMINS_RESTORE,
        }),
      }),
    );
  });
});
