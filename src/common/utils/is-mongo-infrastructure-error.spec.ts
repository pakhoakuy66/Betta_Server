import { describe, expect, it } from '@jest/globals';

import { isMongoInfrastructureError } from './is-mongo-infrastructure-error';

describe('isMongoInfrastructureError', () => {
  it.each([
    'MongoNetworkError',
    'MongoNetworkTimeoutError',
    'MongoServerSelectionError',
    'MongooseServerSelectionError',
  ])('accepts infrastructure error %s', (name) => {
    expect(
      isMongoInfrastructureError(
        Object.assign(new Error('database unavailable'), { name }),
      ),
    ).toBe(true);
  });

  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENETUNREACH',
    'EHOSTUNREACH',
  ])('accepts network error code %s', (code) => {
    expect(isMongoInfrastructureError({ code })).toBe(true);
  });

  it.each([
    'TransientTransactionError',
    'UnknownTransactionCommitResult',
    'RetryableWriteError',
  ])('accepts transaction error label %s', (label) => {
    expect(isMongoInfrastructureError({ errorLabels: [label] })).toBe(true);
  });

  it.each([
    null,
    undefined,
    new Error('application error'),
    { name: 'ValidationError' },
    { code: 112 },
    { name: 'MongoServerError', code: 11000 },
    { errorLabels: ['custom-application-label'] },
  ])('rejects non-infrastructure error %#', (error) => {
    expect(isMongoInfrastructureError(error)).toBe(false);
  });
});
