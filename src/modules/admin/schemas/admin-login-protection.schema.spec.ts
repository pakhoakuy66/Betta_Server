import { describe, expect, it } from '@jest/globals';
import { model, models, type Model } from 'mongoose';
import {
  ADMIN_LOGIN_PROTECTION_KEY_INDEX,
  ADMIN_LOGIN_PROTECTION_TTL_INDEX,
  AdminLoginProtectionScope,
} from '../constants/admin-login-protection.constants';
import {
  AdminLoginProtection,
  AdminLoginProtectionSchema,
} from './admin-login-protection.schema';

describe('AdminLoginProtectionSchema', () => {
  const modelName = 'AdminLoginProtectionSchemaTest';
  const TestModel =
    (models[modelName] as Model<AdminLoginProtection> | undefined) ??
    model<AdminLoginProtection>(modelName, AdminLoginProtectionSchema.clone());

  it('accepts only the privacy-safe counter contract', async () => {
    const now = new Date();
    const document = new TestModel({
      scope: AdminLoginProtectionScope.ACCOUNT,
      keyLocators: [`test-lookup-v1:${'a'.repeat(64)}`],
      failedAttempts: 1,
      windowStartedAt: now,
      lockedUntil: null,
      expiresAt: new Date(now.getTime() + 60_000),
    });

    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.toObject()).not.toHaveProperty('email');
    expect(document.toObject()).not.toHaveProperty('ip');
    expect(document.toObject()).not.toHaveProperty('credential');
  });

  it('rejects malformed hashes, counters and unknown sensitive fields', async () => {
    const malformed = new TestModel({
      scope: AdminLoginProtectionScope.IP,
      keyLocators: ['raw-ip-address'],
      failedAttempts: -1,
      windowStartedAt: new Date(),
      lockedUntil: null,
      expiresAt: new Date(),
    });

    await expect(malformed.validate()).rejects.toThrow();
    expect(
      () =>
        new TestModel({
          scope: AdminLoginProtectionScope.IP,
          keyLocators: [`test-v1:${'a'.repeat(64)}`],
          failedAttempts: 1,
          windowStartedAt: new Date(),
          lockedUntil: null,
          expiresAt: new Date(),
          email: 'admin@example.com',
        }),
    ).toThrow();
  });

  it('defines a compound unique key and absolute TTL cleanup', () => {
    const indexes = AdminLoginProtectionSchema.indexes();

    expect(indexes).toContainEqual([
      { scope: 1, keyLocators: 1 },
      expect.objectContaining({
        name: ADMIN_LOGIN_PROTECTION_KEY_INDEX,
        unique: true,
      }),
    ]);
    expect(indexes).toContainEqual([
      { expiresAt: 1 },
      expect.objectContaining({
        name: ADMIN_LOGIN_PROTECTION_TTL_INDEX,
        expireAfterSeconds: 0,
      }),
    ]);
  });
});
