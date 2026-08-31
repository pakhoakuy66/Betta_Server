import {
  CanonicalModerationReasonCode,
  MODERATION_REASON_TAXONOMY_VERSION,
  ModerationReasonAction,
  ModerationReasonTarget,
  PublicModerationReasonCode,
  REPORT_POST_REASON_CODES,
  REPORT_USER_REASON_CODES,
} from './moderation-reason.constants';
import {
  getCanonicalModerationReason,
  isCanonicalReasonAllowed,
  normalizeModerationReasonDetail,
  resolveReportSubmissionReason,
} from './moderation-reason.policy';

describe('moderation reason policy', () => {
  it('maps the complete SRS report taxonomy by target', () => {
    expect(REPORT_POST_REASON_CODES).toEqual([
      'violence_hate',
      'nudity_sexual',
      'scam_fraud',
      'misinformation',
    ]);
    expect(REPORT_USER_REASON_CODES).toEqual([
      ...REPORT_POST_REASON_CODES,
      'me',
      'followed_person',
      'public_figure',
      'business_organization',
    ]);
    for (const code of REPORT_POST_REASON_CODES) {
      expect(
        isCanonicalReasonAllowed(
          ModerationReasonTarget.REPORT_POST,
          ModerationReasonAction.SUBMIT,
          code,
        ),
      ).toBe(true);

      for (const target of [
        ModerationReasonTarget.REPORT_POST,
        ModerationReasonTarget.REPORT_USER,
      ] as const) {
        expect(
          resolveReportSubmissionReason({ target, reasonCode: code }),
        ).toMatchObject({
          code,
          group: 'inappropriate_content',
          taxonomyVersion: MODERATION_REASON_TAXONOMY_VERSION,
        });
      }
    }
    for (const code of REPORT_USER_REASON_CODES.slice(
      REPORT_POST_REASON_CODES.length,
    )) {
      expect(
        resolveReportSubmissionReason({
          target: ModerationReasonTarget.REPORT_USER,
          reasonCode: code,
        }),
      ).toMatchObject({
        code,
        group: 'impersonation',
        taxonomyVersion: MODERATION_REASON_TAXONOMY_VERSION,
      });
    }
    expect(
      isCanonicalReasonAllowed(
        ModerationReasonTarget.REPORT_POST,
        ModerationReasonAction.SUBMIT,
        CanonicalModerationReasonCode.IMPERSONATION_ME,
      ),
    ).toBe(false);
  });

  it('normalizes exact legacy labels but rejects non-SRS free text', () => {
    expect(
      resolveReportSubmissionReason({
        target: ModerationReasonTarget.REPORT_POST,
        legacyReasonGroup: 'violation_content',
        legacyReasonDetail: '  Bạo lực,   thù ghét  ',
      }),
    ).toEqual({
      code: CanonicalModerationReasonCode.VIOLENCE_HATE,
      group: 'inappropriate_content',
      label: 'Bạo lực hoặc thù ghét',
      taxonomyVersion: MODERATION_REASON_TAXONOMY_VERSION,
    });
    expect(
      resolveReportSubmissionReason({
        target: ModerationReasonTarget.REPORT_POST,
        legacyReasonGroup: 'inappropriate_content',
        legacyReasonDetail: 'Spam',
      }),
    ).toBeNull();
  });

  it('maps restriction, Post action, report decision and audit reason codes', () => {
    expect(
      getCanonicalModerationReason(
        ModerationReasonTarget.USER_RESTRICTION,
        ModerationReasonAction.APPLY_TEMPORARY_SUSPENSION,
        CanonicalModerationReasonCode.MODERATION_POLICY,
      ),
    ).toMatchObject({
      publicReasonCode: PublicModerationReasonCode.COMMUNITY_POLICY_REVIEW,
      taxonomyVersion: MODERATION_REASON_TAXONOMY_VERSION,
    });
    expect(
      getCanonicalModerationReason(
        ModerationReasonTarget.POST,
        ModerationReasonAction.HIDE,
        CanonicalModerationReasonCode.MODERATION_POLICY,
      )?.publicMessage,
    ).toBe('Trạng thái hiển thị nội dung của bạn đã được cập nhật');
    expect(
      isCanonicalReasonAllowed(
        ModerationReasonTarget.REPORT,
        ModerationReasonAction.RESOLVE,
        CanonicalModerationReasonCode.EVIDENCE_CONFIRMED,
      ),
    ).toBe(true);
    expect(
      isCanonicalReasonAllowed(
        ModerationReasonTarget.REPORT,
        ModerationReasonAction.REJECT,
        CanonicalModerationReasonCode.EVIDENCE_CONFIRMED,
      ),
    ).toBe(false);
  });

  it('trims safe detail and rejects stored-XSS/control payloads', () => {
    expect(normalizeModerationReasonDetail('  Đã kiểm tra bằng chứng  ')).toBe(
      'Đã kiểm tra bằng chứng',
    );
    expect(
      normalizeModerationReasonDetail('<img src=x onerror=alert(1)>'),
    ).toBeNull();
    expect(normalizeModerationReasonDetail('javascript:alert(1)')).toBeNull();
    expect(normalizeModerationReasonDetail('valid\u0000hidden')).toBeNull();
  });
});
