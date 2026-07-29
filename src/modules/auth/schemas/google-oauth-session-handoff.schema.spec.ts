import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Mongoose, type Model } from 'mongoose';

import {
  GOOGLE_OAUTH_SESSION_HANDOFF_AUTH_TAG_BASE64URL_LENGTH,
  GOOGLE_OAUTH_SESSION_HANDOFF_HASH_BASE64URL_LENGTH,
  GOOGLE_OAUTH_SESSION_HANDOFF_HASH_INDEX,
  GOOGLE_OAUTH_SESSION_HANDOFF_IV_BASE64URL_LENGTH,
  GOOGLE_OAUTH_SESSION_HANDOFF_MAX_CIPHERTEXT_LENGTH,
  GOOGLE_OAUTH_SESSION_HANDOFF_PAYLOAD_VERSION,
  GOOGLE_OAUTH_SESSION_HANDOFF_TTL_INDEX,
} from '../constants/google-oauth-session-handoff.constants';
import {
  GoogleOAuthSessionHandoff,
  GoogleOAuthSessionHandoffSchema,
} from './google-oauth-session-handoff.schema';

describe('GoogleOAuthSessionHandoffSchema', () => {
  let mongoose: Mongoose;
  let model: Model<GoogleOAuthSessionHandoff>;

  const createSource = (overrides: Record<string, unknown> = {}) => ({
    handoffHash: 'h'.repeat(GOOGLE_OAUTH_SESSION_HANDOFF_HASH_BASE64URL_LENGTH),
    payloadVersion: GOOGLE_OAUTH_SESSION_HANDOFF_PAYLOAD_VERSION,
    payloadCiphertext: 'Y2lwaGVydGV4dA',
    payloadIv: 'i'.repeat(GOOGLE_OAUTH_SESSION_HANDOFF_IV_BASE64URL_LENGTH),
    payloadAuthTag: 't'.repeat(
      GOOGLE_OAUTH_SESSION_HANDOFF_AUTH_TAG_BASE64URL_LENGTH,
    ),
    expiresAt: new Date(Date.now() + 120_000),
    ...overrides,
  });

  beforeAll(() => {
    mongoose = new Mongoose();

    model = mongoose.model<GoogleOAuthSessionHandoff>(
      GoogleOAuthSessionHandoff.name,
      GoogleOAuthSessionHandoffSchema,
    );
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('accepts a valid encrypted handoff', async () => {
    const document = new model(createSource());

    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.consumedAt).toBeNull();
  });

  it.each([
    ['handoffHash', `${'a'.repeat(42)}=`],
    ['payloadCiphertext', 'invalid+ciphertext'],
    [
      'payloadCiphertext',
      'a'.repeat(GOOGLE_OAUTH_SESSION_HANDOFF_MAX_CIPHERTEXT_LENGTH + 1),
    ],
    ['payloadIv', `${'a'.repeat(15)}=`],
    ['payloadAuthTag', `${'a'.repeat(21)}=`],
    ['payloadVersion', GOOGLE_OAUTH_SESSION_HANDOFF_PAYLOAD_VERSION + 1],
  ])('rejects invalid %s', async (field, value) => {
    const document = new model(
      createSource({
        [field]: value,
      }),
    );

    await expect(document.validate()).rejects.toMatchObject({
      name: 'ValidationError',
    });
  });

  it('rejects plaintext credential fields', () => {
    expect(
      () =>
        new model({
          ...createSource(),
          access_token: 'access-secret',
          refresh_token: 'refresh-secret',
          rawHandoff: 'raw-secret',
        }),
    ).toThrow();
  });

  it('hides and marks encrypted bindings immutable', () => {
    const fields = [
      'handoffHash',
      'payloadVersion',
      'payloadCiphertext',
      'payloadIv',
      'payloadAuthTag',
    ];

    for (const field of fields) {
      const options = GoogleOAuthSessionHandoffSchema.path(field).options;

      expect(options.select).toBe(false);
      expect(options.immutable).toBe(true);
    }

    expect(
      GoogleOAuthSessionHandoffSchema.path('expiresAt').options.immutable,
    ).toBe(true);
  });

  it('defines only unique-hash and TTL indexes', () => {
    expect(GoogleOAuthSessionHandoffSchema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { handoffHash: 1 },
          expect.objectContaining({
            unique: true,
            name: GOOGLE_OAUTH_SESSION_HANDOFF_HASH_INDEX,
          }),
        ],
        [
          { expiresAt: 1 },
          expect.objectContaining({
            expireAfterSeconds: 0,
            name: GOOGLE_OAUTH_SESSION_HANDOFF_TTL_INDEX,
          }),
        ],
      ]),
    );
  });
});
