import {
  CanonicalModerationReasonCode,
  MODERATION_REASON_DETAIL_MAX_LENGTH,
  MODERATION_REASON_DETAIL_MIN_LENGTH,
  MODERATION_REASON_TAXONOMY_VERSION,
  MODERATION_REASON_UNSAFE_CONTROL_PATTERN,
  MODERATION_REASON_UNSAFE_MARKUP_PATTERN,
  ModerationReasonAction,
  ModerationReasonTarget,
  PublicModerationReasonCode,
  REPORT_POST_REASON_CODES,
  REPORT_USER_REASON_CODES,
} from './moderation-reason.constants';

export type CanonicalModerationReason = Readonly<{
  code: CanonicalModerationReasonCode;
  target: ModerationReasonTarget;
  action: ModerationReasonAction;
  taxonomyVersion: typeof MODERATION_REASON_TAXONOMY_VERSION;
  labelKey: string;
  publicReasonCode: PublicModerationReasonCode | null;
  publicMessage: string | null;
}>;

export type CanonicalReportSubmissionReason = Readonly<{
  code: CanonicalModerationReasonCode;
  group: 'inappropriate_content' | 'impersonation';
  label: string;
  taxonomyVersion: typeof MODERATION_REASON_TAXONOMY_VERSION;
}>;

type CatalogEntry = Readonly<{
  code: CanonicalModerationReasonCode;
  targets: readonly ModerationReasonTarget[];
  actions: readonly ModerationReasonAction[];
  taxonomyVersion: typeof MODERATION_REASON_TAXONOMY_VERSION;
  labelKey: string;
  publicReasonCode: PublicModerationReasonCode | null;
  publicMessage: string | null;
}>;

const SAFE_ACCOUNT_MESSAGE =
  'Trạng thái truy cập tài khoản của bạn đã được cập nhật';
const SAFE_CONTENT_MESSAGE =
  'Trạng thái hiển thị nội dung của bạn đã được cập nhật';
const SAFE_REPORT_MESSAGE = 'Báo cáo của bạn đã được xem xét';

const entry = (
  code: CanonicalModerationReasonCode,
  targets: readonly ModerationReasonTarget[],
  actions: readonly ModerationReasonAction[],
  publicReasonCode: PublicModerationReasonCode | null = null,
  publicMessage: string | null = null,
): CatalogEntry =>
  Object.freeze({
    code,
    targets,
    actions,
    taxonomyVersion: MODERATION_REASON_TAXONOMY_VERSION,
    labelKey: `moderation.reason.${code}`,
    publicReasonCode,
    publicMessage,
  });

export const MODERATION_REASON_CATALOG: readonly CatalogEntry[] = Object.freeze(
  [
    ...REPORT_POST_REASON_CODES.map((code) =>
      entry(
        code,
        [
          ModerationReasonTarget.REPORT_POST,
          ModerationReasonTarget.REPORT_USER,
        ],
        [ModerationReasonAction.SUBMIT],
      ),
    ),
    ...[
      CanonicalModerationReasonCode.IMPERSONATION_ME,
      CanonicalModerationReasonCode.IMPERSONATION_FOLLOWED_PERSON,
      CanonicalModerationReasonCode.IMPERSONATION_PUBLIC_FIGURE,
      CanonicalModerationReasonCode.IMPERSONATION_BUSINESS_ORGANIZATION,
    ].map((code) =>
      entry(
        code,
        [ModerationReasonTarget.REPORT_USER],
        [ModerationReasonAction.SUBMIT],
      ),
    ),
    entry(
      CanonicalModerationReasonCode.MODERATION_POLICY,
      [ModerationReasonTarget.USER_RESTRICTION, ModerationReasonTarget.POST],
      [
        ModerationReasonAction.APPLY_TEMPORARY_SUSPENSION,
        ModerationReasonAction.HIDE,
      ],
      PublicModerationReasonCode.COMMUNITY_POLICY_REVIEW,
      SAFE_ACCOUNT_MESSAGE,
    ),
    entry(
      CanonicalModerationReasonCode.SEVERE_POLICY_VIOLATION,
      [ModerationReasonTarget.USER_RESTRICTION, ModerationReasonTarget.POST],
      [
        ModerationReasonAction.APPLY_INDEFINITE_BAN,
        ModerationReasonAction.TERMINAL_DELETE,
      ],
      PublicModerationReasonCode.SEVERE_POLICY_VIOLATION,
      SAFE_ACCOUNT_MESSAGE,
    ),
    entry(
      CanonicalModerationReasonCode.MODERATION_REVIEW_COMPLETED,
      [ModerationReasonTarget.USER_RESTRICTION],
      [
        ModerationReasonAction.REMOVE_TEMPORARY_SUSPENSION,
        ModerationReasonAction.REMOVE_INDEFINITE_BAN,
      ],
      PublicModerationReasonCode.ACCOUNT_ACCESS_RESTORED,
      SAFE_ACCOUNT_MESSAGE,
    ),
    entry(
      CanonicalModerationReasonCode.MODERATION_REVIEW_COMPLETED,
      [ModerationReasonTarget.POST],
      [ModerationReasonAction.RESTORE],
      PublicModerationReasonCode.CONTENT_VISIBILITY_UPDATED,
      SAFE_CONTENT_MESSAGE,
    ),
    entry(
      CanonicalModerationReasonCode.RESTRICTION_EXPIRED,
      [ModerationReasonTarget.USER_RESTRICTION],
      [ModerationReasonAction.EXPIRE_TEMPORARY_SUSPENSION],
      PublicModerationReasonCode.ACCOUNT_ACCESS_RESTORED,
      SAFE_ACCOUNT_MESSAGE,
    ),
    entry(
      CanonicalModerationReasonCode.EVIDENCE_CONFIRMED,
      [ModerationReasonTarget.REPORT],
      [ModerationReasonAction.RESOLVE],
      PublicModerationReasonCode.REPORT_REVIEW_COMPLETED,
      SAFE_REPORT_MESSAGE,
    ),
    entry(
      CanonicalModerationReasonCode.INSUFFICIENT_EVIDENCE,
      [ModerationReasonTarget.REPORT],
      [ModerationReasonAction.REJECT],
      PublicModerationReasonCode.REPORT_REVIEW_COMPLETED,
      SAFE_REPORT_MESSAGE,
    ),
    ...[
      CanonicalModerationReasonCode.TARGET_EXPIRED_NO_ACTION,
      CanonicalModerationReasonCode.TARGET_DELETED_NO_ACTION,
      CanonicalModerationReasonCode.TARGET_MISSING_NO_ACTION,
    ].map((code) =>
      entry(
        code,
        [ModerationReasonTarget.REPORT],
        [ModerationReasonAction.CLOSE_NO_ACTION],
        PublicModerationReasonCode.REPORT_REVIEW_COMPLETED,
        SAFE_REPORT_MESSAGE,
      ),
    ),
  ],
);

const REPORT_REASON_METADATA = {
  violence_hate: {
    group: 'inappropriate_content',
    label: 'Bạo lực hoặc thù ghét',
  },
  nudity_sexual: {
    group: 'inappropriate_content',
    label: 'Khỏa thân hoặc hoạt động tình dục',
  },
  scam_fraud: {
    group: 'inappropriate_content',
    label: 'Lừa đảo hoặc gian lận',
  },
  misinformation: {
    group: 'inappropriate_content',
    label: 'Thông tin sai lệch',
  },
  me: { group: 'impersonation', label: 'Tôi' },
  followed_person: { group: 'impersonation', label: 'Người mà tôi theo dõi' },
  public_figure: {
    group: 'impersonation',
    label: 'Người nổi tiếng hoặc người của công chúng',
  },
  business_organization: {
    group: 'impersonation',
    label: 'Một doanh nghiệp hoặc tổ chức',
  },
} as const;

const LEGACY_ALIASES = new Map<string, CanonicalModerationReasonCode>([
  [
    'violation_content|bạo lực, thù ghét',
    CanonicalModerationReasonCode.VIOLENCE_HATE,
  ],
  [
    'violation_content|bạo lực hoặc thù ghét',
    CanonicalModerationReasonCode.VIOLENCE_HATE,
  ],
  [
    'inappropriate_content|bạo lực, thù ghét',
    CanonicalModerationReasonCode.VIOLENCE_HATE,
  ],
  [
    'inappropriate_content|ảnh khỏa thân hoặc hoạt động tình dục',
    CanonicalModerationReasonCode.NUDITY_SEXUAL,
  ],
  [
    'inappropriate_content|khỏa thân hoặc hoạt động tình dục',
    CanonicalModerationReasonCode.NUDITY_SEXUAL,
  ],
  [
    'violation_content|lừa đảo, gian lận',
    CanonicalModerationReasonCode.SCAM_FRAUD,
  ],
  [
    'violation_content|lừa đảo hoặc gian lận',
    CanonicalModerationReasonCode.SCAM_FRAUD,
  ],
  [
    'inappropriate_content|lừa đảo, gian lận',
    CanonicalModerationReasonCode.SCAM_FRAUD,
  ],
  [
    'violation_content|thông tin sai sự thật',
    CanonicalModerationReasonCode.MISINFORMATION,
  ],
  [
    'violation_content|thông tin sai lệch',
    CanonicalModerationReasonCode.MISINFORMATION,
  ],
  [
    'inappropriate_content|thông tin sai sự thật',
    CanonicalModerationReasonCode.MISINFORMATION,
  ],
  ['impersonation|tôi', CanonicalModerationReasonCode.IMPERSONATION_ME],
  [
    'impersonation|người mà tôi theo dõi',
    CanonicalModerationReasonCode.IMPERSONATION_FOLLOWED_PERSON,
  ],
  [
    'impersonation|người nổi tiếng hoặc người của công chúng',
    CanonicalModerationReasonCode.IMPERSONATION_PUBLIC_FIGURE,
  ],
  [
    'impersonation|một doanh nghiệp hoặc tổ chức',
    CanonicalModerationReasonCode.IMPERSONATION_BUSINESS_ORGANIZATION,
  ],
]);

const isCanonicalModerationReasonCode = (
  code: unknown,
): code is CanonicalModerationReasonCode =>
  typeof code === 'string' &&
  Object.values(CanonicalModerationReasonCode).includes(
    code as CanonicalModerationReasonCode,
  );

export const isCanonicalReasonAllowed = (
  target: ModerationReasonTarget,
  action: ModerationReasonAction,
  code: unknown,
): code is CanonicalModerationReasonCode =>
  isCanonicalModerationReasonCode(code) &&
  MODERATION_REASON_CATALOG.some(
    (item) =>
      item.code === code &&
      item.targets.includes(target) &&
      item.actions.includes(action),
  );

export const getCanonicalModerationReason = (
  target: ModerationReasonTarget,
  action: ModerationReasonAction,
  code: unknown,
): CanonicalModerationReason | null => {
  const item = MODERATION_REASON_CATALOG.find(
    (candidate) =>
      candidate.code === code &&
      candidate.targets.includes(target) &&
      candidate.actions.includes(action),
  );
  if (!item) return null;
  return Object.freeze({
    code: item.code,
    target,
    action,
    taxonomyVersion: item.taxonomyVersion,
    labelKey: item.labelKey,
    publicReasonCode: item.publicReasonCode,
    publicMessage:
      target === ModerationReasonTarget.POST
        ? SAFE_CONTENT_MESSAGE
        : item.publicMessage,
  });
};

export const resolveReportSubmissionReason = (
  input: Readonly<{
    target:
      | ModerationReasonTarget.REPORT_POST
      | ModerationReasonTarget.REPORT_USER;
    reasonCode?: unknown;
    legacyReasonGroup?: unknown;
    legacyReasonDetail?: unknown;
  }>,
): CanonicalReportSubmissionReason | null => {
  const allowed =
    input.target === ModerationReasonTarget.REPORT_POST
      ? REPORT_POST_REASON_CODES
      : REPORT_USER_REASON_CODES;
  let code =
    typeof input.reasonCode === 'string'
      ? allowed.find((candidate) => candidate === input.reasonCode)
      : undefined;
  if (
    !code &&
    typeof input.legacyReasonGroup === 'string' &&
    typeof input.legacyReasonDetail === 'string'
  ) {
    const label = input.legacyReasonDetail
      .trim()
      .replace(/\s+/gu, ' ')
      .toLocaleLowerCase('vi-VN');
    code = LEGACY_ALIASES.get(`${input.legacyReasonGroup}|${label}`);
  }
  if (!code || !allowed.includes(code as never)) return null;
  const metadata =
    REPORT_REASON_METADATA[code as keyof typeof REPORT_REASON_METADATA];
  if (!metadata) return null;
  return Object.freeze({
    code,
    group: metadata.group,
    label: metadata.label,
    taxonomyVersion: MODERATION_REASON_TAXONOMY_VERSION,
  });
};

export const normalizeModerationReasonDetail = (
  value: unknown,
  minLength: number = MODERATION_REASON_DETAIL_MIN_LENGTH,
  maxLength: number = MODERATION_REASON_DETAIL_MAX_LENGTH,
): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\r\n?/gu, '\n');
  if (
    normalized.length < minLength ||
    normalized.length > maxLength ||
    MODERATION_REASON_UNSAFE_CONTROL_PATTERN.test(normalized) ||
    MODERATION_REASON_UNSAFE_MARKUP_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
};
