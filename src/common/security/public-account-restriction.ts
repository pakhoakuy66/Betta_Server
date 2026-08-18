export const ACCOUNT_RESTRICTED_ERROR = 'ACCOUNT_RESTRICTED' as const;

export type PublicAccountRestriction = Readonly<{
  type: 'TEMPORARY_SUSPENSION' | 'INDEFINITE_BAN';
  effectiveAt: string;
  expiresAt: string | null;
  supportReference: string;
}>;

const SUPPORT_REFERENCE_PATTERN = /^sup_[A-Za-z0-9_-]{8,64}$/;
const PUBLIC_RESTRICTION_KEYS = new Set([
  'type',
  'effectiveAt',
  'expiresAt',
  'supportReference',
]);

const isCanonicalIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
};

export const normalizePublicAccountRestriction = (
  value: unknown,
): PublicAccountRestriction | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !PUBLIC_RESTRICTION_KEYS.has(key))) {
    return undefined;
  }
  const type = source.type;
  const effectiveAt = source.effectiveAt;
  const expiresAt = source.expiresAt;
  const supportReference = source.supportReference;
  if (
    !isCanonicalIsoDate(effectiveAt) ||
    typeof supportReference !== 'string' ||
    !SUPPORT_REFERENCE_PATTERN.test(supportReference)
  ) {
    return undefined;
  }
  if (type === 'INDEFINITE_BAN') {
    return expiresAt === null
      ? Object.freeze({ type, effectiveAt, expiresAt, supportReference })
      : undefined;
  }
  if (
    type === 'TEMPORARY_SUSPENSION' &&
    isCanonicalIsoDate(expiresAt) &&
    new Date(expiresAt).getTime() > new Date(effectiveAt).getTime()
  ) {
    return Object.freeze({ type, effectiveAt, expiresAt, supportReference });
  }
  return undefined;
};
