const INFRASTRUCTURE_ERROR_NAMES = new Set([
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoServerSelectionError',
  'MongooseServerSelectionError',
]);

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

const TRANSACTION_ERROR_LABELS = new Set([
  'TransientTransactionError',
  'UnknownTransactionCommitResult',
  'RetryableWriteError',
]);

export const isMongoInfrastructureError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const source = error as Record<string, unknown>;

  if (
    typeof source.name === 'string' &&
    INFRASTRUCTURE_ERROR_NAMES.has(source.name)
  ) {
    return true;
  }

  if (typeof source.code === 'string' && NETWORK_ERROR_CODES.has(source.code)) {
    return true;
  }

  return (
    Array.isArray(source.errorLabels) &&
    source.errorLabels.some(
      (label) =>
        typeof label === 'string' && TRANSACTION_ERROR_LABELS.has(label),
    )
  );
};
