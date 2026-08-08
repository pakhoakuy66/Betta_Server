import { describe, expect, it } from '@jest/globals';
import { model, models, type Model } from 'mongoose';
import { AdminRole } from '../constants/admin-account.constants';
import { AdminPermission } from '../constants/admin-permission.constants';
import {
  ADMIN_AUDIT_SCHEMA_VERSION,
  AdminAuditAction,
  AdminAuditActorType,
  AdminAuditOutcome,
  AdminAuditSource,
  AdminAuditTargetType,
} from '../constants/admin-audit.constants';
import {
  ADMIN_AUDIT_ACTION_INDEX,
  ADMIN_AUDIT_ACTOR_INDEX,
  ADMIN_AUDIT_PUBLIC_ID_INDEX,
  ADMIN_AUDIT_RETENTION_INDEX,
  ADMIN_AUDIT_TARGET_INDEX,
  ADMIN_AUDIT_TIMELINE_INDEX,
  AdminAuditEvent,
  AdminAuditEventSchema,
} from './admin-audit-event.schema';

const MODEL = 'AdminAuditEventSchemaTest';
const TestModel =
  (models[MODEL] as Model<AdminAuditEvent> | undefined) ??
  model<AdminAuditEvent>(MODEL, AdminAuditEventSchema.clone());

const validSource = () => ({
  action: AdminAuditAction.ADMIN_LOCKED,
  outcome: AdminAuditOutcome.SUCCEEDED,
  actor: {
    type: AdminAuditActorType.ADMIN_ACCOUNT,
    publicId: 'adm_23456789ABCD',
    username: 'owner',
    displayName: 'Owner',
    role: AdminRole.SUPER_ADMIN,
    permission: AdminPermission.ADMINS_LOCK,
    permissionVersion: 1,
  },
  target: {
    type: AdminAuditTargetType.ADMIN_ACCOUNT,
    publicId: 'adm_23456789ABCE',
    displayName: 'Target',
  },
  reasonCode: 'security_review',
  source: AdminAuditSource.HTTP,
  expiresAt: new Date(Date.now() + 86_400_000),
});

describe('AdminAuditEventSchema', () => {
  it('applies the versioned strict append-only document contract', () => {
    const document = new TestModel(validSource());

    expect(document.validateSync()).toBeUndefined();
    expect(document.schemaVersion).toBe(ADMIN_AUDIT_SCHEMA_VERSION);
    expect(document.publicId).toMatch(/^aaud_/u);
    expect(AdminAuditEventSchema.get('strict')).toBe('throw');
    expect(AdminAuditEventSchema.get('versionKey')).toBe(false);
  });

  it('rejects unknown and malformed data', () => {
    expect(
      () =>
        new TestModel({
          ...validSource(),
          refreshToken: 'must-not-be-stored',
        }),
    ).toThrow();

    const malformed = new TestModel({
      ...validSource(),
      target: { type: AdminAuditTargetType.ADMIN_ACCOUNT, publicId: 'bad' },
    });
    expect(malformed.validateSync()?.errors['target.publicId']).toBeDefined();
  });

  it('defines only the approved query and retention indexes', () => {
    const indexes = AdminAuditEventSchema.indexes();
    const names = indexes.map(([, options]) => options.name);

    expect(names).toEqual([
      ADMIN_AUDIT_PUBLIC_ID_INDEX,
      ADMIN_AUDIT_RETENTION_INDEX,
      ADMIN_AUDIT_TIMELINE_INDEX,
      ADMIN_AUDIT_ACTOR_INDEX,
      ADMIN_AUDIT_ACTION_INDEX,
      ADMIN_AUDIT_TARGET_INDEX,
    ]);
    expect(indexes[0]?.[1]).toEqual(expect.objectContaining({ unique: true }));
    expect(indexes[1]?.[1]).toEqual(
      expect.objectContaining({ expireAfterSeconds: 0 }),
    );
  });
});
