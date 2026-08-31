import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  getConnectionToken,
  getModelToken,
  MongooseModule,
} from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { type Connection, type Model, Types } from 'mongoose';
import { OutboxEvent } from '../../src/common/outbox/outbox-event.schema';
import { OutboxModule } from '../../src/common/outbox/outbox.module';
import {
  CanonicalModerationReasonCode,
  MODERATION_REASON_TAXONOMY_VERSION,
  PublicModerationReasonCode,
} from '../../src/common/moderation/moderation-reason.constants';
import { AdminModule } from '../../src/modules/admin/admin.module';
import { AccessSupportSecretsConfig } from '../../src/modules/reports/config/access-support-secrets.config';
import {
  ADMIN_SECRETS,
  ADMIN_SECRET_ENV_KEYS,
  AdminSecretPurpose,
  createAdminSecrets,
} from '../../src/modules/admin/config/admin-secrets.config';
import { createAuthSecretMaterialBoundary } from '../../src/modules/admin/config/auth-secret-material-boundary.config';
import {
  AdminAccountStatus,
  AdminMfaStatus,
  AdminRole,
} from '../../src/modules/admin/constants/admin-account.constants';
import { AdminAuditActorType } from '../../src/modules/admin/constants/admin-audit.constants';
import { AdminPermission } from '../../src/modules/admin/constants/admin-permission.constants';
import {
  ADMIN_REPORT_DECISION_FAILURE_INJECTOR,
  AdminReportDecision,
  AdminReportDecisionFailureStep,
  AdminReportDecisionOutcome,
  AdminReportTargetAction,
} from '../../src/modules/admin/constants/admin-report-decision.constants';
import {
  AdminReportDecisionConflictException,
  AdminReportDecisionIdempotencyConflictException,
} from '../../src/modules/admin/exceptions/admin-report-decision-conflict.exception';
import type {
  AdminReportDecisionActor,
  AdminReportDecisionFailureInjector,
  UpdateAdminReportDecisionInput,
} from '../../src/modules/admin/interfaces/admin-report-decision.interface';
import { AdminAccount } from '../../src/modules/admin/schemas/admin-account.schema';
import { AdminAuditEvent } from '../../src/modules/admin/schemas/admin-audit-event.schema';
import { AdminReportDecisionRequest } from '../../src/modules/admin/schemas/admin-report-decision-request.schema';
import { AdminSession } from '../../src/modules/admin/schemas/admin-session.schema';
import { ModerationDecision } from '../../src/modules/admin/schemas/moderation-decision.schema';
import { AdminReportDecisionService } from '../../src/modules/admin/services/admin-report-decision.service';
import { generateAdminPublicId } from '../../src/modules/admin/utils/generate-admin-public-id';
import {
  generateAdminSessionFamily,
  generateAdminSessionPublicId,
} from '../../src/modules/admin/utils/generate-admin-session-id';
import {
  Post,
  PostModerationState,
} from '../../src/modules/posts/schemas/post.schema';
import { generatePostPublicId } from '../../src/modules/posts/utils/generate-post-public-id';
import {
  AuthSession,
  SessionRevokeReason,
} from '../../src/modules/auth/schemas/auth-session.schema';
import { UserRestrictionType } from '../../src/modules/users/constants/user-moderation.constants';
import { User } from '../../src/modules/users/schemas/user.schema';
import { generateUserPublicId } from '../../src/modules/users/utils/generate-public-id';
import {
  Report,
  ReportReasonGroup,
  ReportStatus,
  ReportTargetType,
} from '../../src/modules/reports/schemas/report.schema';
import { SystemReport } from '../../src/modules/reports/schemas/system-report.schema';
import { ReportEvidenceRetentionService } from '../../src/modules/retention/report-evidence-retention.service';
import { CloudinaryAssetHealthService } from '../../src/modules/uploads/services/cloudinary-asset-health.service';
import { UploadsService } from '../../src/modules/uploads/services/uploads.service';

const URI_ENV = 'MONGODB_INTEGRATION_URI';
const CONFIRM_ENV = 'RUN_MONGODB_INTEGRATION_TESTS';
const PREFIX = 'betta_rpt_dec_it_';
const dbName = `${PREFIX}${process.pid}_${randomUUID().replace(/-/gu, '').slice(0, 6)}`;
const values = Object.fromEntries(
  Object.values(AdminSecretPurpose).map((purpose, index) => [
    ADMIN_SECRET_ENV_KEYS[purpose],
    JSON.stringify({
      current: {
        id: `decision-it-${index}`,
        keyBase64: Buffer.alloc(32, index + 141).toString('base64'),
      },
      previous: [],
    }),
  ]),
) as Readonly<Record<string, string>>;
const secrets = createAdminSecrets({
  source: { get: (key: string): unknown => values[key] },
  forbiddenMaterialBoundary: createAuthSecretMaterialBoundary({
    get: () => undefined,
  }),
});
const accessSupportSecrets = new AccessSupportSecretsConfig(
  new ConfigService({
    ACCESS_SUPPORT_ENCRYPTION_KEYRING_JSON: JSON.stringify({
      current: {
        id: 'decision-it-enc-v1',
        keyBase64: Buffer.alloc(32, 211).toString('base64'),
      },
    }),
    ACCESS_SUPPORT_HMAC_KEYRING_JSON: JSON.stringify({
      current: {
        id: 'decision-it-hmac-v1',
        keyBase64: Buffer.alloc(32, 212).toString('base64'),
      },
    }),
  }),
);

class FailureInjector implements AdminReportDecisionFailureInjector {
  step?: AdminReportDecisionFailureStep;
  hit(step: AdminReportDecisionFailureStep): void {
    if (step === this.step) throw new Error(`Injected failure: ${step}`);
  }
}

jest.setTimeout(180_000);

describe('Admin report decision MongoDB integration', () => {
  let moduleRef: TestingModule;
  let connection: Connection;
  let accounts: Model<AdminAccount>;
  let adminSessions: Model<AdminSession>;
  let reports: Model<Report>;
  let systemReports: Model<SystemReport>;
  let posts: Model<Post>;
  let users: Model<User>;
  let userSessions: Model<AuthSession>;
  let audits: Model<AdminAuditEvent>;
  let outbox: Model<OutboxEvent>;
  let histories: Model<ModerationDecision>;
  let requests: Model<AdminReportDecisionRequest>;
  let service: AdminReportDecisionService;
  let retention: ReportEvidenceRetentionService;
  const failure = new FailureInjector();

  beforeAll(async () => {
    const uri = process.env[URI_ENV]?.trim();
    if (!uri) throw new Error(`${URI_ENV} chua duoc cau hinh`);
    if (process.env[CONFIRM_ENV] !== 'YES')
      throw new Error(`${CONFIRM_ENV}=YES la bat buoc`);
    if (
      [process.env.DATABASE_URL, process.env.MONGODB_URI]
        .filter(Boolean)
        .map(String)
        .map((v) => v.trim())
        .includes(uri)
    ) {
      throw new Error('Integration URI khong duoc trung runtime URI');
    }
    if (!dbName.startsWith(PREFIX) || dbName.length > 38)
      throw new Error('Ten database khong an toan');

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        MongooseModule.forRoot(uri, {
          dbName,
          autoIndex: false,
          serverSelectionTimeoutMS: 15_000,
        }),
        OutboxModule,
        AdminModule,
      ],
    })
      .overrideProvider(ADMIN_SECRETS)
      .useValue(secrets)
      .overrideProvider(AccessSupportSecretsConfig)
      .useValue(accessSupportSecrets)
      .overrideProvider(ADMIN_REPORT_DECISION_FAILURE_INJECTOR)
      .useValue(failure)
      .compile();

    connection = moduleRef.get(getConnectionToken());
    accounts = moduleRef.get(getModelToken(AdminAccount.name));
    adminSessions = moduleRef.get(getModelToken(AdminSession.name));
    reports = moduleRef.get(getModelToken(Report.name));
    systemReports = moduleRef.get(getModelToken(SystemReport.name));
    posts = moduleRef.get(getModelToken(Post.name));
    users = moduleRef.get(getModelToken(User.name));
    userSessions = moduleRef.get(getModelToken(AuthSession.name));
    audits = moduleRef.get(getModelToken(AdminAuditEvent.name));
    outbox = moduleRef.get(getModelToken(OutboxEvent.name));
    histories = moduleRef.get(getModelToken(ModerationDecision.name));
    requests = moduleRef.get(getModelToken(AdminReportDecisionRequest.name));
    service = moduleRef.get(AdminReportDecisionService);
    retention = new ReportEvidenceRetentionService(
      reports,
      systemReports,
      posts,
      { deleteImages: jest.fn() } as unknown as UploadsService,
      {
        findMissingImagePublicIds: jest.fn(),
      } as unknown as CloudinaryAssetHealthService,
    );
    await Promise.all(
      [
        accounts,
        adminSessions,
        reports,
        systemReports,
        posts,
        audits,
        outbox,
        histories,
        requests,
      ].map((model) => model.syncIndexes()),
    );
  });

  beforeEach(async () => {
    failure.step = undefined;
    await Promise.all([
      accounts.deleteMany({}),
      adminSessions.deleteMany({}),
      reports.deleteMany({}),
      systemReports.deleteMany({}),
      posts.deleteMany({}),
      users.deleteMany({}),
      userSessions.deleteMany({}),
      audits.collection.deleteMany({}),
      outbox.deleteMany({}),
      histories.deleteMany({}),
      requests.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    if (!moduleRef || !connection) return;
    try {
      if (!connection.name.startsWith(PREFIX))
        throw new Error(`Tu choi xoa: ${connection.name}`);
      await connection.dropDatabase();
    } finally {
      await moduleRef.close();
    }
  });

  const actor = async (): Promise<AdminReportDecisionActor> => {
    const account = await accounts.create({
      publicId: generateAdminPublicId(),
      email: `${randomUUID()}@betta.test`,
      username: `adm_${randomUUID().replace(/-/gu, '').slice(0, 12)}`,
      displayName: 'Report Decision Operator',
      role: AdminRole.ADMIN,
      status: AdminAccountStatus.ACTIVE,
      passwordHash: `$2b$12$${'a'.repeat(53)}`,
      mustChangePassword: false,
      mfaStatus: AdminMfaStatus.ACTIVE,
      encryptedTotpSecret: 'atotp_v1.integration.report-decision',
      activationGrantConsumedAt: new Date(),
      credentialVersion: 1,
      authzVersion: 1,
      permissionVersion: 1,
      version: 0,
      lockedAt: null,
      deletedAt: null,
    });
    const session = await adminSessions.create({
      adminAccountId: account._id,
      adminPublicId: account.publicId,
      publicId: generateAdminSessionPublicId(),
      tokenFamily: generateAdminSessionFamily(),
      refreshTokenHash: 'sha256-v1:' + 'a'.repeat(64),
      deviceLabel: 'Integration',
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + 180_000),
      revokedAt: null,
      revokeReason: null,
    });
    return Object.freeze({
      type: AdminAuditActorType.ADMIN_ACCOUNT,
      adminAccountId: account._id,
      publicId: account.publicId,
      username: account.username,
      displayName: account.displayName,
      role: AdminRole.ADMIN,
      permission: AdminPermission.REPORTS_RESOLVE,
      permissionVersion: 1,
      sessionPublicId: session.publicId,
      credentialVersion: 1,
      authzVersion: 1,
    });
  };

  const fixture = async (admin: AdminReportDecisionActor, expired = false) => {
    const post = await posts.create({
      publicId: generatePostPublicId(),
      authorId: new Types.ObjectId(),
      content: 'Report decision integration target',
      expireAt: new Date(Date.now() + (expired ? -60_000 : 86_400_000)),
      isDeletedByAdmin: false,
    });
    const report = await reports.create({
      reporterId: new Types.ObjectId(),
      targetType: ReportTargetType.POST,
      targetId: post._id,
      reasonGroup: ReportReasonGroup.INAPPROPRIATE_CONTENT,
      reasonCode: 'violence_hate',
      reasonTaxonomyVersion: MODERATION_REASON_TAXONOMY_VERSION,
      reasonDetail: 'Violence or hate',
      description: 'Report decision integration fixture',
      targetSnapshot: {
        publicId: post.publicId,
        content: post.content,
        expireAt: post.expireAt,
      },
      status: ReportStatus.REVIEWING,
      assigneePublicId: admin.publicId,
      assignedAt: new Date(),
      version: 1,
      terminalAt: null,
    });
    return { post, report };
  };

  const hide = (
    admin: AdminReportDecisionActor,
    reportPublicId: string,
    idempotencyKey: string,
  ): UpdateAdminReportDecisionInput => ({
    actor: admin,
    reportPublicId,
    decision: AdminReportDecision.RESOLVE,
    targetAction: AdminReportTargetAction.POST_HIDE,
    expectedReportVersion: 1,
    expectedTargetVersion: 0,
    reasonCode: CanonicalModerationReasonCode.EVIDENCE_CONFIRMED,
    actionReasonCode: CanonicalModerationReasonCode.MODERATION_POLICY,
    publicReasonCode: PublicModerationReasonCode.CONTENT_VISIBILITY_UPDATED,
    reasonNote: 'Evidence confirms a policy violation',
    idempotencyKey,
  });

  it('commits atomically and replays exactly once', async () => {
    const admin = await actor();
    const { post, report } = await fixture(admin);
    const input = hide(
      admin,
      report.publicId as string,
      'decision-replay-20260825-0001',
    );
    const [result, concurrentReplay] = await Promise.all([
      service.update(input),
      service.update(input),
    ]);
    expect(concurrentReplay).toEqual(result);
    await expect(service.update(input)).resolves.toEqual(result);
    expect(result.decision).toEqual(
      expect.objectContaining({
        outcome: AdminReportDecisionOutcome.ACTION_APPLIED,
        targetVersion: 1,
      }),
    );
    expect(
      await posts
        .findById(post._id)
        .select('+moderationState +moderationVersion')
        .lean()
        .exec(),
    ).toEqual(
      expect.objectContaining({
        isDeletedByAdmin: true,
        moderationState: PostModerationState.HIDDEN,
        moderationVersion: 1,
      }),
    );
    await expect(
      Promise.all([
        reports.countDocuments({
          _id: report._id,
          status: ReportStatus.RESOLVED,
          version: 2,
        }),
        histories.countDocuments({}),
        audits.countDocuments({}),
        outbox.countDocuments({}),
        requests.countDocuments({}),
      ]),
    ).resolves.toEqual([1, 1, 2, 2, 1]);
    await expect(
      service.update({
        ...input,
        reasonNote: 'Different payload is forbidden',
      }),
    ).rejects.toBeInstanceOf(AdminReportDecisionIdempotencyConflictException);
  });

  it('rejects without changing the target', async () => {
    const admin = await actor();
    const { post, report } = await fixture(admin);
    const result = await service.update({
      actor: admin,
      reportPublicId: report.publicId as string,
      decision: AdminReportDecision.REJECT,
      targetAction: AdminReportTargetAction.NONE,
      expectedReportVersion: 1,
      reasonCode: CanonicalModerationReasonCode.INSUFFICIENT_EVIDENCE,
      reasonNote: 'Evidence is insufficient for target action',
      idempotencyKey: 'decision-reject-20260825-0001',
    });
    expect(result.decision.outcome).toBe(
      AdminReportDecisionOutcome.REPORT_REJECTED,
    );
    expect(
      await posts
        .findById(post._id)
        .select('+moderationState +moderationVersion')
        .lean()
        .exec(),
    ).toEqual(
      expect.objectContaining({
        isDeletedByAdmin: false,
        moderationState: PostModerationState.ACTIVE,
        moderationVersion: 0,
      }),
    );
    await expect(
      Promise.all([audits.countDocuments({}), outbox.countDocuments({})]),
    ).resolves.toEqual([1, 1]);
  });

  it('suspends a reported user and revokes sessions in the same commit', async () => {
    const admin = await actor();
    const user = await users.create({
      publicId: generateUserPublicId(),
      username: `decision_user_${randomUUID().slice(0, 8)}`,
      fullname: 'Decision Target User',
      phone: `09${String(Date.now()).slice(-8)}`,
      email: `${randomUUID()}@user.test`,
      status: 'active',
      isDeleted: false,
      restriction: null,
      version: 0,
      authzVersion: 0,
    });
    await userSessions.create([
      {
        userId: user._id,
        publicId: `ses_${randomUUID()}`,
        tokenFamily: randomUUID(),
        tokenVersion: 0,
        refreshTokenHash: `sha256-bcrypt-v1:${'c'.repeat(60)}`,
        deviceLabel: 'Device A',
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + 180_000),
        revokedAt: null,
        revokeReason: null,
      },
      {
        userId: user._id,
        publicId: `ses_${randomUUID()}`,
        tokenFamily: randomUUID(),
        tokenVersion: 0,
        refreshTokenHash: `sha256-bcrypt-v1:${'d'.repeat(60)}`,
        deviceLabel: 'Device B',
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + 180_000),
        revokedAt: null,
        revokeReason: null,
      },
    ]);
    const report = await reports.create({
      reporterId: new Types.ObjectId(),
      targetType: ReportTargetType.USER,
      targetId: user._id,
      reasonGroup: ReportReasonGroup.IMPERSONATION,
      reasonCode: 'public_figure',
      reasonTaxonomyVersion: MODERATION_REASON_TAXONOMY_VERSION,
      reasonDetail: 'Public figure impersonation',
      description: 'Reported user integration fixture',
      targetSnapshot: { publicId: user.publicId, username: user.username },
      status: ReportStatus.REVIEWING,
      assigneePublicId: admin.publicId,
      assignedAt: new Date(),
      version: 1,
      terminalAt: null,
    });
    const expiresAt = new Date(Date.now() + 3_600_000);

    const result = await service.update({
      actor: admin,
      reportPublicId: report.publicId as string,
      decision: AdminReportDecision.RESOLVE,
      targetAction: AdminReportTargetAction.USER_TEMPORARY_SUSPENSION,
      expectedReportVersion: 1,
      expectedTargetVersion: 0,
      reasonCode: CanonicalModerationReasonCode.EVIDENCE_CONFIRMED,
      actionReasonCode: CanonicalModerationReasonCode.MODERATION_POLICY,
      publicReasonCode: PublicModerationReasonCode.COMMUNITY_POLICY_REVIEW,
      expiresAt: expiresAt.toISOString(),
      reasonNote: 'Evidence requires a temporary account restriction',
      idempotencyKey: 'decision-user-suspend-20260825-0001',
    });

    expect(result.decision.targetVersion).toBe(1);
    expect(
      await users
        .findById(user._id)
        .select('+restriction +version')
        .lean()
        .exec(),
    ).toEqual(
      expect.objectContaining({
        version: 1,
        restriction: expect.objectContaining({
          type: UserRestrictionType.TEMPORARY_SUSPENSION,
          publicReasonCode: PublicModerationReasonCode.COMMUNITY_POLICY_REVIEW,
        }),
      }),
    );
    expect(
      await userSessions.countDocuments({
        userId: user._id,
        revokedAt: { $ne: null },
        revokeReason: SessionRevokeReason.ACCOUNT_RESTRICTED,
      }),
    ).toBe(2);
  });
  it('closes an expired target without reviving it', async () => {
    const admin = await actor();
    const { post, report } = await fixture(admin, true);
    const originalExpireAt = post.expireAt.getTime();
    const result = await service.update({
      actor: admin,
      reportPublicId: report.publicId as string,
      decision: AdminReportDecision.RESOLVE,
      targetAction: AdminReportTargetAction.NONE,
      expectedReportVersion: 1,
      reasonCode: CanonicalModerationReasonCode.TARGET_EXPIRED_NO_ACTION,
      reasonNote: 'Target expired before moderation completed',
      idempotencyKey: 'decision-expired-20260825-0001',
    });
    expect(result.decision.outcome).toBe(
      AdminReportDecisionOutcome.TARGET_EXPIRED_NO_ACTION,
    );
    expect(result.decision.targetVersion).toBeNull();
    expect(
      await posts
        .findById(post._id)
        .select('+moderationState +moderationVersion')
        .lean()
        .exec(),
    ).toEqual(
      expect.objectContaining({
        publicId: post.publicId,
        expireAt: new Date(originalExpireAt),
        isDeletedByAdmin: false,
        moderationState: PostModerationState.ACTIVE,
        moderationVersion: 0,
      }),
    );
    expect(
      await histories.findOne({ reportId: report._id }).lean().exec(),
    ).toEqual(
      expect.objectContaining({
        targetPublicId: post.publicId,
        targetBeforeVersion: null,
        targetAfterVersion: null,
      }),
    );
    await expect(
      Promise.all([
        audits.countDocuments({}),
        outbox.countDocuments({}),
        requests.countDocuments({}),
      ]),
    ).resolves.toEqual([1, 1, 1]);
  });

  it('closes a terminal-deleted target without changing or restoring it', async () => {
    const admin = await actor();
    const { post, report } = await fixture(admin);
    await posts.collection.updateOne(
      { _id: post._id },
      {
        $set: {
          isDeletedByAdmin: true,
          moderationState: PostModerationState.TERMINAL_DELETED,
          moderationVersion: 1,
        },
      },
    );

    const result = await service.update({
      actor: admin,
      reportPublicId: report.publicId as string,
      decision: AdminReportDecision.RESOLVE,
      targetAction: AdminReportTargetAction.NONE,
      expectedReportVersion: 1,
      reasonCode: CanonicalModerationReasonCode.TARGET_DELETED_NO_ACTION,
      reasonNote: 'Target was terminal-deleted before review completed',
      idempotencyKey: 'decision-deleted-20260831-0001',
    });

    expect(result.decision).toEqual(
      expect.objectContaining({
        outcome: AdminReportDecisionOutcome.TARGET_DELETED_NO_ACTION,
        targetVersion: null,
      }),
    );
    expect(
      await posts
        .findById(post._id)
        .select('+moderationState +moderationVersion')
        .lean()
        .exec(),
    ).toEqual(
      expect.objectContaining({
        publicId: post.publicId,
        isDeletedByAdmin: true,
        moderationState: PostModerationState.TERMINAL_DELETED,
        moderationVersion: 1,
      }),
    );
    expect(
      await histories.countDocuments({
        reportId: report._id,
        targetPublicId: post.publicId,
      }),
    ).toBe(1);
  });

  it('closes a physically missing target from its immutable snapshot', async () => {
    const admin = await actor();
    const { post, report } = await fixture(admin);
    await posts.collection.deleteOne({ _id: post._id });

    const result = await service.update({
      actor: admin,
      reportPublicId: report.publicId as string,
      decision: AdminReportDecision.RESOLVE,
      targetAction: AdminReportTargetAction.NONE,
      expectedReportVersion: 1,
      reasonCode: CanonicalModerationReasonCode.TARGET_MISSING_NO_ACTION,
      reasonNote: 'Target no longer exists when review completed',
      idempotencyKey: 'decision-missing-20260831-0001',
    });

    expect(result.decision.outcome).toBe(
      AdminReportDecisionOutcome.TARGET_UNAVAILABLE_NO_ACTION,
    );
    expect(await posts.countDocuments({ _id: post._id })).toBe(0);
    expect(
      await histories.findOne({ reportId: report._id }).lean().exec(),
    ).toEqual(expect.objectContaining({ targetPublicId: post.publicId }));
  });

  it('fails closed when an unavailable target has no valid immutable snapshot', async () => {
    const admin = await actor();
    const { post, report } = await fixture(admin);
    await Promise.all([
      posts.collection.deleteOne({ _id: post._id }),
      reports.collection.updateOne(
        { _id: report._id },
        { $unset: { 'targetSnapshot.publicId': '' } },
      ),
    ]);

    await expect(
      service.update({
        actor: admin,
        reportPublicId: report.publicId as string,
        decision: AdminReportDecision.RESOLVE,
        targetAction: AdminReportTargetAction.NONE,
        expectedReportVersion: 1,
        reasonCode: CanonicalModerationReasonCode.TARGET_MISSING_NO_ACTION,
        reasonNote: 'Target is missing but snapshot integrity is invalid',
        idempotencyKey: 'decision-invalid-snapshot-20260831-0001',
      }),
    ).rejects.toBeInstanceOf(AdminReportDecisionConflictException);
    await expect(
      Promise.all([
        reports.countDocuments({
          _id: report._id,
          status: ReportStatus.REVIEWING,
          version: 1,
          terminalAt: null,
        }),
        histories.countDocuments({}),
        audits.countDocuments({}),
        outbox.countDocuments({}),
        requests.countDocuments({}),
      ]),
    ).resolves.toEqual([1, 0, 0, 0, 0]);
  });

  it('fails closed when an expired target disagrees with its snapshot publicId', async () => {
    const admin = await actor();
    const { post, report } = await fixture(admin, true);
    await reports.collection.updateOne(
      { _id: report._id },
      { $set: { 'targetSnapshot.publicId': generatePostPublicId() } },
    );

    await expect(
      service.update({
        actor: admin,
        reportPublicId: report.publicId as string,
        decision: AdminReportDecision.RESOLVE,
        targetAction: AdminReportTargetAction.NONE,
        expectedReportVersion: 1,
        reasonCode: CanonicalModerationReasonCode.TARGET_EXPIRED_NO_ACTION,
        reasonNote: 'Expired target snapshot identifier is inconsistent',
        idempotencyKey: 'decision-mismatch-snapshot-20260831-0001',
      }),
    ).rejects.toBeInstanceOf(AdminReportDecisionConflictException);
    expect(
      await posts
        .findById(post._id)
        .select('+moderationState +moderationVersion')
        .lean()
        .exec(),
    ).toEqual(
      expect.objectContaining({
        publicId: post.publicId,
        isDeletedByAdmin: false,
        moderationState: PostModerationState.ACTIVE,
        moderationVersion: 0,
      }),
    );
  });

  it('keeps no-action close concurrent with one atomic winner', async () => {
    const admin = await actor();
    const { post, report } = await fixture(admin, true);
    const input = (idempotencyKey: string): UpdateAdminReportDecisionInput => ({
      actor: admin,
      reportPublicId: report.publicId as string,
      decision: AdminReportDecision.RESOLVE,
      targetAction: AdminReportTargetAction.NONE,
      expectedReportVersion: 1,
      reasonCode: CanonicalModerationReasonCode.TARGET_EXPIRED_NO_ACTION,
      reasonNote: 'Concurrent close after natural target expiry',
      idempotencyKey,
    });

    const settled = await Promise.allSettled([
      service.update(input('decision-no-action-race-20260831-0001')),
      service.update(input('decision-no-action-race-20260831-0002')),
    ]);

    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(
      1,
    );
    await expect(
      Promise.all([
        histories.countDocuments({}),
        audits.countDocuments({}),
        outbox.countDocuments({}),
        requests.countDocuments({}),
      ]),
    ).resolves.toEqual([1, 1, 1, 1]);
    expect(
      await posts
        .findById(post._id)
        .select('+moderationState +moderationVersion')
        .lean()
        .exec(),
    ).toEqual(
      expect.objectContaining({
        moderationState: PostModerationState.ACTIVE,
        moderationVersion: 0,
      }),
    );
  });

  it('retains immutable evidence for 30 days after no-action closure', async () => {
    const admin = await actor();
    const { report } = await fixture(admin, true);
    const result = await service.update({
      actor: admin,
      reportPublicId: report.publicId as string,
      decision: AdminReportDecision.RESOLVE,
      targetAction: AdminReportTargetAction.NONE,
      expectedReportVersion: 1,
      reasonCode: CanonicalModerationReasonCode.TARGET_EXPIRED_NO_ACTION,
      reasonNote: 'Retain snapshot evidence after natural target expiry',
      idempotencyKey: 'decision-retention-20260831-0001',
    });
    const terminalAt = new Date(result.report.terminalAt);
    const graceBoundary = new Date(terminalAt.getTime() + 30 * 86_400_000);

    const beforeBoundary = await retention.purgeReportEvidence(
      10,
      true,
      new Date(graceBoundary.getTime() - 1),
    );
    expect(beforeBoundary.updated).toBe(0);
    expect(await reports.findById(report._id).lean().exec()).toEqual(
      expect.objectContaining({
        targetSnapshot: expect.objectContaining({
          content: 'Report decision integration target',
        }),
      }),
    );

    const atBoundary = await retention.purgeReportEvidence(
      10,
      true,
      graceBoundary,
    );
    expect(atBoundary.updated).toBe(1);
    const retained = await reports.findById(report._id).lean().exec();
    expect(retained).toEqual(
      expect.objectContaining({
        status: ReportStatus.RESOLVED,
        evidenceUnavailable: true,
        evidencePurgedAt: graceBoundary,
        targetSnapshot: expect.objectContaining({
          publicId: report.targetSnapshot?.publicId,
        }),
      }),
    );
    expect(retained?.targetSnapshot?.content).toBeUndefined();
    expect(await histories.countDocuments({ reportId: report._id })).toBe(1);
  });

  it('keeps different-key concurrency as one winner and one conflict', async () => {
    const admin = await actor();
    const { report } = await fixture(admin);
    const settled = await Promise.allSettled([
      service.update(
        hide(
          admin,
          report.publicId as string,
          'decision-different-key-20260825-0001',
        ),
      ),
      service.update(
        hide(
          admin,
          report.publicId as string,
          'decision-different-key-20260825-0002',
        ),
      ),
    ]);

    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(
      1,
    );
    await expect(
      Promise.all([
        histories.countDocuments({}),
        audits.countDocuments({}),
        outbox.countDocuments({}),
        requests.countDocuments({}),
      ]),
    ).resolves.toEqual([1, 2, 2, 1]);
  });
  it.each(Object.values(AdminReportDecisionFailureStep))(
    'rolls back every effect after %s',
    async (step) => {
      const admin = await actor();
      const { post, report } = await fixture(admin);
      failure.step = step;
      await expect(
        service.update(
          hide(
            admin,
            report.publicId as string,
            `decision-rollback-${step.toLowerCase()}-20260825`,
          ),
        ),
      ).rejects.toThrow(`Injected failure: ${step}`);
      expect(
        await posts
          .findById(post._id)
          .select('+moderationState +moderationVersion')
          .lean()
          .exec(),
      ).toEqual(
        expect.objectContaining({
          isDeletedByAdmin: false,
          moderationState: PostModerationState.ACTIVE,
          moderationVersion: 0,
        }),
      );
      await expect(
        Promise.all([
          reports.countDocuments({
            _id: report._id,
            status: ReportStatus.REVIEWING,
            version: 1,
            terminalAt: null,
          }),
          histories.countDocuments({}),
          audits.countDocuments({}),
          outbox.countDocuments({}),
          requests.countDocuments({}),
        ]),
      ).resolves.toEqual([1, 0, 0, 0, 0]);
    },
  );
});
