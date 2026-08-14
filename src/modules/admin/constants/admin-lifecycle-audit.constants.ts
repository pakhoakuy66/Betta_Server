import {
  AdminAuditAction,
  AdminAuditTargetType,
} from './admin-audit.constants';

export const ADMIN_LIFECYCLE_AUDIT_METADATA_KEYS = Object.freeze([
  'beforeVersion',
  'afterVersion',
  'beforeState',
  'afterState',
  'affectedSessionCount',
] as const);

export type AdminLifecycleAuditMetadataKey =
  (typeof ADMIN_LIFECYCLE_AUDIT_METADATA_KEYS)[number];

export type AdminLifecycleAuditAvailability = 'enabled' | 'reserved';

export type AdminLifecycleAuditPolicy = Readonly<{
  targetType: AdminAuditTargetType;
  requiredMetadata: readonly AdminLifecycleAuditMetadataKey[];
  availability: AdminLifecycleAuditAvailability;
}>;

const policy = (
  targetType: AdminAuditTargetType,
  requiredMetadata: readonly AdminLifecycleAuditMetadataKey[],
  availability: AdminLifecycleAuditAvailability = 'enabled',
): AdminLifecycleAuditPolicy =>
  Object.freeze({
    targetType,
    requiredMetadata: Object.freeze([...requiredMetadata]),
    availability,
  });

export const ADMIN_LIFECYCLE_AUDIT_POLICY = Object.freeze({
  [AdminAuditAction.ADMIN_CREATED]: policy(AdminAuditTargetType.ADMIN_ACCOUNT, [
    'afterVersion',
    'afterState',
  ]),
  [AdminAuditAction.ACTIVATION_CONSUMED]: policy(
    AdminAuditTargetType.ADMIN_ACCOUNT,
    ['beforeVersion', 'afterVersion', 'beforeState', 'afterState'],
  ),
  [AdminAuditAction.ADMIN_LOCKED]: policy(AdminAuditTargetType.ADMIN_ACCOUNT, [
    'beforeVersion',
    'afterVersion',
    'beforeState',
    'afterState',
    'affectedSessionCount',
  ]),
  [AdminAuditAction.ADMIN_UNLOCKED]: policy(
    AdminAuditTargetType.ADMIN_ACCOUNT,
    [
      'beforeVersion',
      'afterVersion',
      'beforeState',
      'afterState',
      'affectedSessionCount',
    ],
  ),
  [AdminAuditAction.ADMIN_DELETED]: policy(AdminAuditTargetType.ADMIN_ACCOUNT, [
    'beforeVersion',
    'afterVersion',
    'beforeState',
    'afterState',
    'affectedSessionCount',
  ]),
  [AdminAuditAction.ADMIN_RESTORED]: policy(
    AdminAuditTargetType.ADMIN_ACCOUNT,
    [
      'beforeVersion',
      'afterVersion',
      'beforeState',
      'afterState',
      'affectedSessionCount',
    ],
  ),
  [AdminAuditAction.SESSION_REVOKED]: policy(
    AdminAuditTargetType.ADMIN_SESSION,
    [],
  ),
  [AdminAuditAction.SESSIONS_REVOKED_ALL]: policy(
    AdminAuditTargetType.ADMIN_ACCOUNT,
    ['affectedSessionCount'],
  ),
  [AdminAuditAction.ADMIN_PERMISSIONS_UPDATED]: policy(
    AdminAuditTargetType.ADMIN_ACCOUNT,
    ['beforeVersion', 'afterVersion'],
    'reserved',
  ),
} satisfies Partial<Record<AdminAuditAction, AdminLifecycleAuditPolicy>>);

export type AdminLifecycleAuditAction =
  keyof typeof ADMIN_LIFECYCLE_AUDIT_POLICY;

export const ADMIN_LIFECYCLE_AUDIT_ACTIONS = Object.freeze(
  Object.keys(ADMIN_LIFECYCLE_AUDIT_POLICY) as AdminLifecycleAuditAction[],
);

export const ADMIN_ENABLED_LIFECYCLE_AUDIT_ACTIONS = Object.freeze(
  ADMIN_LIFECYCLE_AUDIT_ACTIONS.filter(
    (action) => ADMIN_LIFECYCLE_AUDIT_POLICY[action].availability === 'enabled',
  ),
);

export const getAdminLifecycleAuditPolicy = (
  action: AdminAuditAction,
): AdminLifecycleAuditPolicy | undefined =>
  ADMIN_LIFECYCLE_AUDIT_POLICY[action as AdminLifecycleAuditAction];
