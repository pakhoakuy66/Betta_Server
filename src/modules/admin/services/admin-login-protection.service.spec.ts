import { describe, expect, it, jest } from '@jest/globals';
import { type Connection, type Model } from 'mongoose';
import { createAdminPolicy } from '../config/admin-policy.config';
import {
  AdminSecretPurpose,
  type AdminSecrets,
} from '../config/admin-secrets.config';
import { AdminLoginProtection } from '../schemas/admin-login-protection.schema';
import { AdminLoginProtectionService } from './admin-login-protection.service';

const currentKey = Object.freeze({
  id: 'lookup-v2',
  key: Buffer.alloc(32, 2),
});
const previousKey = Object.freeze({
  id: 'lookup-v1',
  key: Buffer.alloc(32, 1),
});

const secrets: AdminSecrets = {
  current: (purpose) => {
    if (purpose !== AdminSecretPurpose.CONTACT_LOOKUP_HMAC) {
      throw new Error('Unexpected secret purpose');
    }
    return currentKey;
  },
  resolve: (_purpose, keyId) => {
    if (keyId === currentKey.id) return currentKey;
    if (keyId === previousKey.id) return previousKey;
    throw new Error('Unknown key');
  },
  candidates: () => [currentKey, previousKey],
  describe: () => [],
  toJSON: () => ({ redacted: true, keyrings: [] }),
};

type QueryMock = {
  select: jest.Mock;
  limit: jest.Mock;
  lean: jest.Mock;
  exec: jest.Mock;
};

const createHarness = (execResult: unknown = []) => {
  const exec = jest.fn<() => Promise<unknown>>().mockResolvedValue(execResult);
  const query = {} as QueryMock;
  query.select = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.lean = jest.fn(() => query);
  query.exec = exec;
  const find = jest.fn<(filter: unknown) => QueryMock>(() => query);
  const deleteMany = jest
    .fn<(filter: unknown) => Promise<unknown>>()
    .mockResolvedValue({ deletedCount: 1 });

  const model = {
    find,
    deleteMany,
  } as unknown as Model<AdminLoginProtection>;

  return {
    deleteMany,
    exec,
    find,
    model,
    service: new AdminLoginProtectionService(
      model,
      {} as Connection,
      secrets,
      createAdminPolicy({ get: () => undefined }),
    ),
  };
};

describe('AdminLoginProtectionService', () => {
  it('queries current and previous HMAC keys without raw account or IP data', async () => {
    const { find, service } = createHarness();

    await service.assertAllowed({
      accountKey: '  Admin@Example.COM ',
      trustedClientIp: '::ffff:203.0.113.7',
    });

    const serializedFilters = JSON.stringify(
      find.mock.calls.map(([filter]) => filter),
    );
    expect(serializedFilters).not.toContain('Admin@Example.COM');
    expect(serializedFilters).not.toContain('admin@example.com');
    expect(serializedFilters).not.toContain('203.0.113.7');
    expect(serializedFilters).toContain(currentKey.id);
    expect(serializedFilters).toContain(previousKey.id);
    expect(serializedFilters).toMatch(/[a-f0-9]{64}/u);
  });

  it('clears only the account counter candidates after full authentication', async () => {
    const { deleteMany, service } = createHarness();

    await service.clearAccountFailures('admin@example.com');

    expect(deleteMany).toHaveBeenCalledTimes(1);
    const serializedFilter = JSON.stringify(deleteMany.mock.calls[0]?.[0]);
    expect(serializedFilter).toContain('account');
    expect(serializedFilter).not.toContain('admin@example.com');
  });

  it('maps MongoDB infrastructure failure to a sanitized 503', async () => {
    const { exec, service } = createHarness();
    exec.mockRejectedValue(
      Object.assign(new Error('mongodb://user:password@internal-host'), {
        name: 'MongoServerSelectionError',
      }),
    );

    await expect(
      service.assertAllowed({
        accountKey: 'admin@example.com',
        trustedClientIp: '203.0.113.7',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        status: 503,
        message: 'Không thể kiểm tra trạng thái đăng nhập',
      }),
    );
  });

  it('rejects malformed identity input before database access', async () => {
    const { find, service } = createHarness();

    await expect(
      service.assertAllowed({
        accountKey: '',
        trustedClientIp: 'not-an-ip',
      }),
    ).rejects.toThrow(TypeError);
    expect(find).not.toHaveBeenCalled();
  });
});
