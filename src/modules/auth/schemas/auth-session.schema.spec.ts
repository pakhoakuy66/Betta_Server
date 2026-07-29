import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { model, models, Types, type Model } from 'mongoose';
import { AuthSession, AuthSessionSchema } from './auth-session.schema';

const MODEL_NAME = 'AuthSessionSchemaTest';

const TestModel =
  (models[MODEL_NAME] as Model<AuthSession> | undefined) ??
  model<AuthSession>(MODEL_NAME, AuthSessionSchema.clone());

const createSession = (tokenVersion = 0) =>
  new TestModel({
    userId: new Types.ObjectId(),
    publicId: `ses_${randomUUID()}`,
    tokenFamily: randomUUID(),
    tokenVersion,
    refreshTokenHash: 'sha256-bcrypt-v1:test',
    deviceLabel: 'Chrome trên Windows',
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });

describe('AuthSessionSchema', () => {
  it('hides refresh-token hash by default', () => {
    expect(AuthSessionSchema.path('refreshTokenHash').options.select).toBe(
      false,
    );
  });

  it('applies secure defaults', () => {
    const session = createSession();

    expect(session.tokenVersion).toBe(0);
    expect(session.revokedAt).toBeNull();
    expect(session.revokeReason).toBeNull();
    expect(session.validateSync()).toBeUndefined();
  });

  it.each([-1, 1.5])('rejects tokenVersion=%s', (version) => {
    expect(
      createSession(version).validateSync()?.errors.tokenVersion,
    ).toBeDefined();
  });

  it('locks security identifier constraints', () => {
    const userId = AuthSessionSchema.path('userId').options;
    const publicId = AuthSessionSchema.path('publicId').options;
    const family = AuthSessionSchema.path('tokenFamily').options;
    const device = AuthSessionSchema.path('deviceLabel').options;

    expect(userId.immutable).toBe(true);

    expect(publicId.immutable).toBe(true);
    expect(publicId.unique).toBe(true);
    expect(publicId.trim).toBe(true);
    expect(publicId.minlength).toBe(20);
    expect(publicId.maxlength).toBe(64);

    expect(family.immutable).toBe(true);
    expect(family.trim).toBe(true);
    expect(family.minlength).toBe(20);
    expect(family.maxlength).toBe(64);

    expect(device.trim).toBe(true);
    expect(device.maxlength).toBe(80);
  });

  it('defines exactly the required indexes', () => {
    expect(AuthSessionSchema.indexes()).toEqual(
      expect.arrayContaining([
        [{ publicId: 1 }, expect.objectContaining({ unique: true })],
        [{ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
        [
          { userId: 1, revokedAt: 1, lastUsedAt: -1 },
          expect.objectContaining({
            name: 'userId_1_revokedAt_1_lastUsedAt_-1',
          }),
        ],
      ]),
    );

    expect(AuthSessionSchema.indexes()).toHaveLength(3);
  });
});
