import { describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { type Connection, type Model, Types } from 'mongoose';
import { createAdminPolicy } from '../config/admin-policy.config';
import {
  AdminSecretPurpose,
  type AdminSecretKey,
  type AdminSecrets,
} from '../config/admin-secrets.config';
import { AdminMfaStatus } from '../constants/admin-account.constants';
import { AdminAccount } from '../schemas/admin-account.schema';
import { createAdminTotp } from '../utils/admin-totp';
import { AdminAuditService } from './admin-audit.service';
import { AdminMfaCryptoService } from './admin-mfa-crypto.service';
import { AdminMfaService } from './admin-mfa.service';
import { AdminSessionService } from './admin-session.service';

const createQuery = <T>(value: T) => ({
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockReturnThis(),
  exec: jest.fn<() => Promise<T>>().mockResolvedValue(value),
});

describe('AdminMfaService', () => {
  it('binds the replay CAS to the exact encrypted secret that was verified', async () => {
    const key: AdminSecretKey = Object.freeze({
      id: 'totp-v1',
      key: randomBytes(32),
    });
    const secrets: AdminSecrets = {
      current: (purpose) => {
        expect(purpose).toBe(AdminSecretPurpose.TOTP_ENCRYPTION);
        return key;
      },
      resolve: (_purpose, keyId) => {
        if (keyId !== key.id) throw new Error('unavailable');
        return key;
      },
      candidates: () => [key],
      describe: () => [],
      toJSON: () => ({ redacted: true, keyrings: [] }),
    };
    const crypto = new AdminMfaCryptoService(secrets);
    const secret = crypto.generateTotpSecret();
    const publicId = 'adm_23456789ABCD';
    const envelope = crypto.encryptTotpSecret(secret, publicId);
    const step = Math.floor(Date.now() / 30_000);
    const updateOne = jest
      .fn<
        (filter: unknown, update: unknown) => Promise<{ modifiedCount: number }>
      >()
      .mockResolvedValue({ modifiedCount: 0 });
    const model = {
      findOne: jest.fn().mockReturnValue(
        createQuery({
          encryptedTotpSecret: envelope,
          totpLastUsedStep: step - 1,
        }),
      ),
      updateOne,
    } as unknown as Model<AdminAccount>;
    const service = new AdminMfaService(
      model,
      {} as Connection,
      createAdminPolicy({ get: () => undefined }),
      crypto,
      {} as AdminAuditService,
      {} as AdminSessionService,
    );

    await expect(
      service.verifyTotp(
        new Types.ObjectId(),
        publicId,
        createAdminTotp(secret, step, 6),
      ),
    ).resolves.toBe(false);
    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        mfaStatus: AdminMfaStatus.ACTIVE,
        encryptedTotpSecret: envelope,
      }),
      { $set: { totpLastUsedStep: step } },
    );
  });
});
