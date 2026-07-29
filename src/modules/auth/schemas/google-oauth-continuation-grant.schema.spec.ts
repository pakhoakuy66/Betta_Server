import { randomBytes } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { model, Types } from 'mongoose';

import {
  GOOGLE_OAUTH_CONTINUATION_GRANT_DEFAULT_TTL_SECONDS,
  GOOGLE_OAUTH_CONTINUATION_GRANT_MAX_TTL_SECONDS,
  GOOGLE_OAUTH_CONTINUATION_GRANT_MIN_TTL_SECONDS,
  GOOGLE_OAUTH_CONTINUATION_GRANT_RAW_TOKEN_LENGTH,
  GOOGLE_OAUTH_CONTINUATION_GRANT_TOKEN_BYTES,
} from '../constants/google-oauth-continuation-grant.constants';
import {
  GOOGLE_OAUTH_CONTINUATION_AVATAR_MAX_LENGTH,
  GOOGLE_OAUTH_CONTINUATION_EMAIL_MAX_LENGTH,
  GOOGLE_OAUTH_CONTINUATION_FULLNAME_MAX_LENGTH,
  GOOGLE_OAUTH_CONTINUATION_GRANT_COLLECTION,
  GOOGLE_OAUTH_CONTINUATION_GRANT_HASH_LENGTH,
  type GoogleOAuthContinuationGrant,
  GoogleOAuthContinuationGrantPurpose,
  GoogleOAuthContinuationGrantSchema,
} from './google-oauth-continuation-grant.schema';

const GrantModel = model<GoogleOAuthContinuationGrant>(
  'GoogleOAuthContinuationGrantSchemaUnit',
  GoogleOAuthContinuationGrantSchema,
);

const createGrant = (overrides: Record<string, unknown> = {}) =>
  new GrantModel({
    grantHash: 'a'.repeat(GOOGLE_OAUTH_CONTINUATION_GRANT_HASH_LENGTH),
    purpose: GoogleOAuthContinuationGrantPurpose.COMPLETE_REGISTRATION,
    providerAccountId: 'google-subject-123',
    email: ' User@Example.com ',
    targetUserId: null,
    fullname: 'Betta User',
    avatar: 'https://example.com/avatar.jpg',
    expiresAt: new Date(Date.now() + 10 * 60_000),
    ...overrides,
  });

describe('GoogleOAuthContinuationGrantSchema', () => {
  it('defines a valid continuation grant policy', () => {
    expect(GOOGLE_OAUTH_CONTINUATION_GRANT_MIN_TTL_SECONDS).toBeLessThan(
      GOOGLE_OAUTH_CONTINUATION_GRANT_DEFAULT_TTL_SECONDS,
    );

    expect(GOOGLE_OAUTH_CONTINUATION_GRANT_DEFAULT_TTL_SECONDS).toBeLessThan(
      GOOGLE_OAUTH_CONTINUATION_GRANT_MAX_TTL_SECONDS,
    );

    expect(
      randomBytes(GOOGLE_OAUTH_CONTINUATION_GRANT_TOKEN_BYTES).toString(
        'base64url',
      ),
    ).toHaveLength(GOOGLE_OAUTH_CONTINUATION_GRANT_RAW_TOKEN_LENGTH);
  });

  it('uses the exact collection and strict options', () => {
    expect(GoogleOAuthContinuationGrantSchema.get('collection')).toBe(
      GOOGLE_OAUTH_CONTINUATION_GRANT_COLLECTION,
    );

    expect(GoogleOAuthContinuationGrantSchema.get('strict')).toBe('throw');

    expect(GoogleOAuthContinuationGrantSchema.get('versionKey')).toBe(false);
  });

  it('declares exactly the required indexes', () => {
    const indexes = GoogleOAuthContinuationGrantSchema.indexes();

    expect(indexes).toHaveLength(2);

    expect(indexes).toEqual(
      expect.arrayContaining([
        [
          { grantHash: 1 },
          expect.objectContaining({
            unique: true,
            name: 'grantHash_1',
          }),
        ],
        [
          { expiresAt: 1 },
          expect.objectContaining({
            expireAfterSeconds: 0,
            name: 'expiresAt_ttl',
          }),
        ],
      ]),
    );
  });

  it.each([
    'grantHash',
    'purpose',
    'providerAccountId',
    'email',
    'targetUserId',
    'fullname',
    'avatar',
  ])('hides %s by default', (field) => {
    expect(GoogleOAuthContinuationGrantSchema.path(field).options.select).toBe(
      false,
    );
  });

  it.each([
    'grantHash',
    'purpose',
    'providerAccountId',
    'email',
    'targetUserId',
    'fullname',
    'avatar',
    'expiresAt',
  ])('marks %s immutable', (field) => {
    expect(
      GoogleOAuthContinuationGrantSchema.path(field).options.immutable,
    ).toBe(true);
  });

  it('keeps consumedAt mutable', () => {
    expect(
      GoogleOAuthContinuationGrantSchema.path('consumedAt').options.immutable,
    ).not.toBe(true);
  });

  it('normalizes email through the shared normalizer', async () => {
    const grant = createGrant();

    await expect(grant.validate()).resolves.toBeUndefined();

    expect(grant.email).toBe('user@example.com');
  });

  it('rejects whitespace-only email', async () => {
    await expect(
      createGrant({
        email: '   ',
      }).validate(),
    ).rejects.toThrow();
  });

  it('requires targetUserId for a link grant', async () => {
    await expect(
      createGrant({
        purpose: GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
        targetUserId: null,
        fullname: null,
        avatar: null,
      }).validate(),
    ).rejects.toThrow('LINK_ACCOUNT grant yêu cầu targetUserId');
  });

  it('accepts a minimal link grant', async () => {
    await expect(
      createGrant({
        purpose: GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
        targetUserId: new Types.ObjectId(),
        fullname: null,
        avatar: null,
      }).validate(),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['fullname', 'Unexpected Name'],
    ['avatar', 'https://example.com/avatar.jpg'],
  ])('rejects %s in a link grant', async (field, value) => {
    await expect(
      createGrant({
        purpose: GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
        targetUserId: new Types.ObjectId(),
        fullname: null,
        avatar: null,
        [field]: value,
      }).validate(),
    ).rejects.toThrow();
  });

  it('rejects targetUserId in a registration grant', async () => {
    await expect(
      createGrant({
        targetUserId: new Types.ObjectId(),
      }).validate(),
    ).rejects.toThrow(
      'COMPLETE_REGISTRATION grant không được chứa targetUserId',
    );
  });

  it('rejects an unknown purpose', async () => {
    await expect(
      createGrant({
        purpose: 'UNKNOWN',
      }).validate(),
    ).rejects.toThrow();
  });

  it('rejects a missing expiration time', async () => {
    await expect(
      createGrant({
        expiresAt: undefined,
      }).validate(),
    ).rejects.toThrow();
  });

  it.each([
    'a'.repeat(42),
    'a'.repeat(44),
    `${'a'.repeat(42)}=`,
    `${'a'.repeat(42)}+`,
    `${'a'.repeat(42)}/`,
  ])('rejects invalid grant hash %s', async (grantHash) => {
    await expect(
      createGrant({
        grantHash,
      }).validate(),
    ).rejects.toThrow();
  });

  it('accepts exact maximum field lengths', async () => {
    const emailSuffix = '@example.com';

    const email = `${'a'.repeat(
      GOOGLE_OAUTH_CONTINUATION_EMAIL_MAX_LENGTH - emailSuffix.length,
    )}${emailSuffix}`;

    const avatarPrefix = 'https://example.com/';

    const avatar = `${avatarPrefix}${'a'.repeat(
      GOOGLE_OAUTH_CONTINUATION_AVATAR_MAX_LENGTH - avatarPrefix.length,
    )}`;

    await expect(
      createGrant({
        email,
        fullname: 'a'.repeat(GOOGLE_OAUTH_CONTINUATION_FULLNAME_MAX_LENGTH),
        avatar,
      }).validate(),
    ).resolves.toBeUndefined();
  });

  it.each([
    [
      'email',
      `${'a'.repeat(GOOGLE_OAUTH_CONTINUATION_EMAIL_MAX_LENGTH)}@example.com`,
    ],
    ['fullname', 'a'.repeat(GOOGLE_OAUTH_CONTINUATION_FULLNAME_MAX_LENGTH + 1)],
    ['avatar', 'a'.repeat(GOOGLE_OAUTH_CONTINUATION_AVATAR_MAX_LENGTH + 1)],
  ])('rejects %s above its maximum length', async (field, value) => {
    await expect(
      createGrant({
        [field]: value,
      }).validate(),
    ).rejects.toThrow();
  });

  it.each([
    'accessToken',
    'refreshToken',
    'idToken',
    'authorizationCode',
    'rawGrantToken',
    'password',
    'otp',
  ])('rejects forbidden field %s synchronously', (field) => {
    expect(() =>
      createGrant({
        [field]: 'secret-value',
      }),
    ).toThrow();
  });
});
