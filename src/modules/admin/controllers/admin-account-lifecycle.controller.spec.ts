import { describe, expect, it, jest } from '@jest/globals';
import { Types } from 'mongoose';
import { AdminRole } from '../constants/admin-account.constants';
import { AdminAccountLifecycleController } from './admin-account-lifecycle.controller';

const request = {
  user: {
    adminAccountId: new Types.ObjectId().toHexString(),
    id: 'adm_23456789ABCD',
    publicId: 'adm_23456789ABCD',
    username: 'root.admin',
    displayName: 'Root Admin',
    role: AdminRole.SUPER_ADMIN,
    sessionId: 'ases_23456789ABCDEFGHJKLMNPQR',
    credentialVersion: 1,
    authzVersion: 1,
    permissionVersion: 1,
  },
  get: jest.fn(() => 'test-agent'),
  socket: { remoteAddress: '127.0.0.1' },
};

const response = () => ({ setHeader: jest.fn() });

describe('AdminAccountLifecycleController', () => {
  it('maps only allowlisted create fields and applies no-store headers', async () => {
    const lifecycle = {
      createAdmin: jest.fn<(input: unknown) => Promise<unknown>>(() =>
        Promise.resolve({
          admin: { publicId: 'adm_3456789ABCDE' },
          activation: { secretReference: 'sm://ref', expiresAt: 'expiry' },
        }),
      ),
    };
    const controller = new AdminAccountLifecycleController(lifecycle as never);
    const httpResponse = response();

    await controller.create(
      {
        email: 'admin@betta.test',
        username: 'new.admin',
        displayName: 'New Admin',
        reauthGrant: 'A'.repeat(43),
        reasonCode: 'team_capacity',
      },
      'admin-create-request-0001',
      request as never,
      httpResponse as never,
    );

    expect(lifecycle.createAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'admin@betta.test',
        username: 'new.admin',
        displayName: 'New Admin',
      }),
    );
    expect(lifecycle.createAdmin.mock.calls[0]?.[0]).not.toHaveProperty('role');
    expect(lifecycle.createAdmin.mock.calls[0]?.[0]).not.toHaveProperty(
      'permissions',
    );
    expect(httpResponse.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store, max-age=0',
    );
  });
});
