import { describe, expect, it } from '@jest/globals';
import { model, models, type Model, Types } from 'mongoose';
import {
  ADMIN_SESSION_FAMILY_INDEX,
  ADMIN_SESSION_OWNER_LIST_INDEX,
  ADMIN_SESSION_PUBLIC_ID_INDEX,
  ADMIN_SESSION_TTL_INDEX,
} from '../constants/admin-session.constants';
import { AdminSession, AdminSessionSchema } from './admin-session.schema';

const MODEL = 'AdminSessionSchemaTest';
const TestModel =
  (models[MODEL] as Model<AdminSession> | undefined) ??
  model<AdminSession>(MODEL, AdminSessionSchema.clone());

const source = () => ({
  adminAccountId: new Types.ObjectId(),
  adminPublicId: 'adm_23456789ABCD',
  publicId: 'ases_23456789ABCDEFGH',
  tokenFamily: 'afam_23456789ABCDEFGH',
  tokenVersion: 0,
  refreshTokenHash: `sha256-v1:${'a'.repeat(64)}`,
  deviceLabel: 'Chrome trên Windows',
  lastUsedAt: new Date(),
  expiresAt: new Date(Date.now() + 86_400_000),
  revokedAt: null,
  revokeReason: null,
});

describe('AdminSessionSchema', () => {
  it('accepts the strict Admin session contract', () => {
    const document = new TestModel(source());
    expect(document.validateSync()).toBeUndefined();
    expect(AdminSessionSchema.get('strict')).toBe('throw');
    expect(AdminSessionSchema.get('versionKey')).toBe(false);
  });

  it('keeps refresh, family and version fields select:false', () => {
    expect(AdminSessionSchema.path('refreshTokenHash').options.select).toBe(
      false,
    );
    expect(AdminSessionSchema.path('tokenFamily').options.select).toBe(false);
    expect(AdminSessionSchema.path('tokenVersion').options.select).toBe(false);
  });

  it('rejects malformed identifiers, hashes and unknown fields', () => {
    const malformed = new TestModel({
      ...source(),
      publicId: 'ses_user_namespace',
      refreshTokenHash: 'raw-token',
    });
    expect(malformed.validateSync()?.errors.publicId).toBeDefined();
    expect(malformed.validateSync()?.errors.refreshTokenHash).toBeDefined();
    expect(() => new TestModel({ ...source(), rawToken: 'secret' })).toThrow();
  });

  it('defines unique, TTL and owner-list indexes', () => {
    const indexes = AdminSessionSchema.indexes();
    const names = indexes.map(([, options]) => options.name);
    expect(names).toEqual([
      ADMIN_SESSION_PUBLIC_ID_INDEX,
      ADMIN_SESSION_FAMILY_INDEX,
      ADMIN_SESSION_TTL_INDEX,
      ADMIN_SESSION_OWNER_LIST_INDEX,
    ]);
    expect(indexes[0]?.[1].unique).toBe(true);
    expect(indexes[1]?.[1].unique).toBe(true);
    expect(indexes[2]?.[1].expireAfterSeconds).toBe(0);
  });
});
