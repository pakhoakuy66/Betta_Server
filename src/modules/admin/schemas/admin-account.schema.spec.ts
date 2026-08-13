import { describe, expect, it } from '@jest/globals';
import { model } from 'mongoose';
import { toPublicAdminAccount } from '../mappers/admin-account-public.mapper';
import {
  generateAdminPublicId,
  isValidAdminPublicId,
} from '../utils/generate-admin-public-id';
import {
  ADMIN_ACCOUNT_EMAIL_INDEX,
  ADMIN_ACCOUNT_GLOBAL_LIST_INDEX,
  ADMIN_ACCOUNT_LIST_INDEX,
  ADMIN_ACCOUNT_PUBLIC_ID_INDEX,
  ADMIN_ACCOUNT_USERNAME_INDEX,
  AdminAccount,
  AdminAccountDeletionOrigin,
  AdminAccountSchema,
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from './admin-account.schema';

const AdminAccountModel = model<AdminAccount>(
  'AdminAccountSchemaUnit',
  AdminAccountSchema,
);

const pendingSource = () => ({
  email: ' ADMIN@BETTA.TEST ',
  username: ' Admin.Owner ',
  displayName: 'Admin Owner',
  role: AdminRole.SUPER_ADMIN,
  activationGrantHash: 'a'.repeat(64),
  activationGrantExpiresAt: new Date(Date.now() + 15 * 60_000),
});

const activeSource = () => ({
  ...pendingSource(),
  status: AdminAccountStatus.ACTIVE,
  passwordHash: 'p'.repeat(60),
  mustChangePassword: false,
  mfaStatus: AdminMfaStatus.ACTIVE,
  encryptedTotpSecret: 'ciphertext',
  activationGrantHash: undefined,
  activationGrantExpiresAt: undefined,
  activationGrantConsumedAt: new Date(),
});

describe('AdminAccountSchema', () => {
  it('creates a secure pending account with normalized identity', () => {
    const account = new AdminAccountModel(pendingSource());

    expect(account.validateSync()).toBeUndefined();
    expect(isValidAdminPublicId(account.publicId)).toBe(true);
    expect(account.email).toBe('admin@betta.test');
    expect(account.username).toBe('admin.owner');
    expect(account.status).toBe(AdminAccountStatus.PENDING_ACTIVATION);
    expect(account.mfaStatus).toBe(AdminMfaStatus.NOT_ENROLLED);
    expect(account.mustChangePassword).toBe(true);
    expect(account.authzVersion).toBe(0);
    expect(account.credentialVersion).toBe(0);
    expect(account.permissionVersion).toBe(1);
  });

  it('only accepts the two approved Package A roles', () => {
    const account = new AdminAccountModel({
      ...pendingSource(),
      role: 'MODERATOR',
    });

    expect(account.validateSync()?.errors.role).toBeDefined();
  });

  it('requires a pending account to have an unconsumed grant', async () => {
    const account = new AdminAccountModel({
      ...pendingSource(),
      activationGrantHash: undefined,
      activationGrantExpiresAt: undefined,
    });

    await expect(account.validate()).rejects.toMatchObject({
      errors: { status: expect.anything() },
    });
  });

  it('requires activation grant hash and expiry to exist together', async () => {
    const account = new AdminAccountModel({
      ...pendingSource(),
      activationGrantExpiresAt: undefined,
    });

    await expect(account.validate()).rejects.toMatchObject({
      errors: { activationGrantHash: expect.anything() },
    });
  });

  it('rejects a consumed grant that still retains hash or expiry', async () => {
    const account = new AdminAccountModel({
      ...pendingSource(),
      activationGrantConsumedAt: new Date(),
    });

    await expect(account.validate()).rejects.toMatchObject({
      errors: {
        activationGrantConsumedAt: expect.anything(),
        status: expect.anything(),
      },
    });
  });

  it('rejects an active account before password and MFA gates complete', async () => {
    const account = new AdminAccountModel({
      ...activeSource(),
      passwordHash: undefined,
      mustChangePassword: true,
      mfaStatus: AdminMfaStatus.NOT_ENROLLED,
      encryptedTotpSecret: undefined,
    });

    await expect(account.validate()).rejects.toMatchObject({
      errors: {
        passwordHash: expect.anything(),
        status: expect.anything(),
      },
    });
  });

  it('accepts active only after grant cleanup, password change and MFA', async () => {
    const account = new AdminAccountModel(activeSource());

    await expect(account.validate()).resolves.toBeUndefined();
  });

  it('requires a locked account to retain activated credentials and lockedAt', async () => {
    const valid = new AdminAccountModel({
      ...activeSource(),
      status: AdminAccountStatus.LOCKED,
      lockedAt: new Date(),
    });
    const missingTimestamp = new AdminAccountModel({
      ...activeSource(),
      status: AdminAccountStatus.LOCKED,
    });
    const missingCredential = new AdminAccountModel({
      ...activeSource(),
      status: AdminAccountStatus.LOCKED,
      lockedAt: new Date(),
      passwordHash: undefined,
    });

    await expect(valid.validate()).resolves.toBeUndefined();
    await expect(missingTimestamp.validate()).rejects.toMatchObject({
      errors: { lockedAt: expect.anything() },
    });
    await expect(missingCredential.validate()).rejects.toMatchObject({
      errors: { passwordHash: expect.anything() },
    });
  });

  it('rejects an active account that retains administrative lock state', async () => {
    const account = new AdminAccountModel({
      ...activeSource(),
      lockedAt: new Date(),
    });

    await expect(account.validate()).rejects.toMatchObject({
      errors: { lockedAt: expect.anything() },
    });
  });

  it('requires bounded Admin deletion metadata and rejects it on active state', async () => {
    const deleted = new AdminAccountModel({
      ...activeSource(),
      status: AdminAccountStatus.SOFT_DELETED,
      deletedAt: new Date(),
      deletionOrigin: AdminAccountDeletionOrigin.ADMIN,
    });
    const missingOrigin = new AdminAccountModel({
      ...activeSource(),
      status: AdminAccountStatus.SOFT_DELETED,
      deletedAt: new Date(),
    });
    const activeWithDeletion = new AdminAccountModel({
      ...activeSource(),
      deletedAt: new Date(),
      deletionOrigin: AdminAccountDeletionOrigin.ADMIN,
    });

    await expect(deleted.validate()).resolves.toBeUndefined();
    await expect(missingOrigin.validate()).rejects.toMatchObject({
      errors: { deletionOrigin: expect.anything() },
    });
    await expect(activeWithDeletion.validate()).rejects.toMatchObject({
      errors: { deletedAt: expect.anything() },
    });
  });

  it('accepts the finite active-account MFA recovery states', async () => {
    const resetRequired = new AdminAccountModel({
      ...activeSource(),
      mfaStatus: AdminMfaStatus.RESET_REQUIRED,
      encryptedTotpSecret: undefined,
      mustChangePassword: true,
    });
    const pendingRecovery = new AdminAccountModel({
      ...activeSource(),
      mfaStatus: AdminMfaStatus.PENDING_ENROLLMENT,
      encryptedTotpSecret: undefined,
      pendingEncryptedTotpSecret: 'pending-ciphertext',
      pendingTotpEnrollmentExpiresAt: new Date(Date.now() + 900_000),
    });

    await expect(resetRequired.validate()).resolves.toBeUndefined();
    await expect(pendingRecovery.validate()).resolves.toBeUndefined();
  });

  it('rejects recovery state that retains an old active TOTP secret', async () => {
    const account = new AdminAccountModel({
      ...activeSource(),
      mfaStatus: AdminMfaStatus.RESET_REQUIRED,
    });

    await expect(account.validate()).rejects.toMatchObject({
      errors: { status: expect.anything() },
    });
  });

  it('hides credentials, MFA, grants and internal versions by default', () => {
    const hiddenFields = [
      'passwordHash',
      'credentialVersion',
      'authzVersion',
      'permissionVersion',
      'version',
      'encryptedTotpSecret',
      'pendingEncryptedTotpSecret',
      'pendingTotpEnrollmentExpiresAt',
      'totpLastUsedStep',
      'recoveryCodeHashes',
      'activationGrantHash',
      'activationGrantExpiresAt',
      'activationGrantConsumedAt',
    ];

    for (const field of hiddenFields) {
      expect(AdminAccountSchema.path(field).options.select).toBe(false);
    }
  });

  it('defines approved indexes without any TTL index', () => {
    const indexes = AdminAccountSchema.indexes();

    for (const name of [
      ADMIN_ACCOUNT_PUBLIC_ID_INDEX,
      ADMIN_ACCOUNT_EMAIL_INDEX,
      ADMIN_ACCOUNT_USERNAME_INDEX,
    ]) {
      expect(
        indexes.some(([, options]) => options.name === name && options.unique),
      ).toBe(true);
    }

    expect(indexes).toContainEqual([
      { status: 1, role: 1, createdAt: -1, publicId: 1 },
      expect.objectContaining({ name: ADMIN_ACCOUNT_LIST_INDEX }),
    ]);
    expect(indexes).toContainEqual([
      { createdAt: -1, publicId: 1 },
      expect.objectContaining({ name: ADMIN_ACCOUNT_GLOBAL_LIST_INDEX }),
    ]);
    expect(
      indexes.every(([, options]) => options.expireAfterSeconds === undefined),
    ).toBe(true);
  });

  it('generates collision-resistant public IDs with adm_ prefix', () => {
    const ids = Array.from({ length: 200 }, generateAdminPublicId);

    expect(ids.every(isValidAdminPublicId)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('maps only explicitly allowed public fields', () => {
    const source = {
      publicId: 'adm_23456789ABCD',
      email: 'admin@betta.test',
      username: 'admin.owner',
      displayName: 'Admin Owner',
      role: AdminRole.ADMIN,
      status: AdminAccountStatus.ACTIVE,
      mfaStatus: AdminMfaStatus.ACTIVE,
      mustChangePassword: false,
      createdAt: new Date('2026-08-03T00:00:00.000Z'),
      updatedAt: new Date('2026-08-03T00:01:00.000Z'),
      passwordHash: 'must-not-leak',
      authzVersion: 99,
    };

    const result = toPublicAdminAccount(source);

    expect(result).toEqual({
      id: source.publicId,
      publicId: source.publicId,
      email: source.email,
      username: source.username,
      displayName: source.displayName,
      role: source.role,
      status: source.status,
      mfaStatus: source.mfaStatus,
      mustChangePassword: false,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    });
    expect(result).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('authzVersion');
  });
});
