import { describe, expect, it } from '@jest/globals';
import {
  AdminAuditAction,
  AdminAuditTargetType,
} from './admin-audit.constants';
import {
  ADMIN_ENABLED_LIFECYCLE_AUDIT_ACTIONS,
  ADMIN_LIFECYCLE_AUDIT_ACTIONS,
  ADMIN_LIFECYCLE_AUDIT_METADATA_KEYS,
  ADMIN_LIFECYCLE_AUDIT_POLICY,
} from './admin-lifecycle-audit.constants';

describe('Admin lifecycle audit policy', () => {
  it('covers every enabled Package A lifecycle mutation', () => {
    expect(ADMIN_ENABLED_LIFECYCLE_AUDIT_ACTIONS).toEqual([
      AdminAuditAction.ADMIN_CREATED,
      AdminAuditAction.ACTIVATION_CONSUMED,
      AdminAuditAction.ADMIN_LOCKED,
      AdminAuditAction.ADMIN_UNLOCKED,
      AdminAuditAction.ADMIN_DELETED,
      AdminAuditAction.ADMIN_RESTORED,
      AdminAuditAction.SESSION_REVOKED,
      AdminAuditAction.SESSIONS_REVOKED_ALL,
    ]);
  });

  it('reserves permission audit without enabling runtime permission mutation', () => {
    expect(ADMIN_LIFECYCLE_AUDIT_ACTIONS).toContain(
      AdminAuditAction.ADMIN_PERMISSIONS_UPDATED,
    );
    expect(ADMIN_ENABLED_LIFECYCLE_AUDIT_ACTIONS).not.toContain(
      AdminAuditAction.ADMIN_PERMISSIONS_UPDATED,
    );
    expect(
      ADMIN_LIFECYCLE_AUDIT_POLICY[AdminAuditAction.ADMIN_PERMISSIONS_UPDATED],
    ).toEqual({
      targetType: AdminAuditTargetType.ADMIN_ACCOUNT,
      requiredMetadata: ['beforeVersion', 'afterVersion'],
      availability: 'reserved',
    });
  });

  it('uses only the approved safe-diff keys and freezes the policy', () => {
    const allowed = new Set(ADMIN_LIFECYCLE_AUDIT_METADATA_KEYS);
    expect(Object.isFrozen(ADMIN_LIFECYCLE_AUDIT_POLICY)).toBe(true);

    for (const action of ADMIN_LIFECYCLE_AUDIT_ACTIONS) {
      const entry = ADMIN_LIFECYCLE_AUDIT_POLICY[action];
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.requiredMetadata)).toBe(true);
      expect(new Set(entry.requiredMetadata).size).toBe(
        entry.requiredMetadata.length,
      );
      for (const key of entry.requiredMetadata)
        expect(allowed.has(key)).toBe(true);
    }
  });
});
