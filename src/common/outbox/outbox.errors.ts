export class OutboxPermanentError extends Error {
  readonly code: string;
  readonly retryable = false as const;

  constructor(code: string, message: string) {
    super(message);
    this.name = OutboxPermanentError.name;
    this.code = code;
  }
}

export class OutboxRetryLaterError extends Error {
  readonly code: string;
  readonly retryable = true as const;
  readonly retryAt: Date;

  constructor(code: string, message: string, retryAt: Date) {
    super(message);
    if (Number.isNaN(retryAt.getTime())) {
      throw new TypeError('Outbox retry time không hợp lệ');
    }
    this.name = OutboxRetryLaterError.name;
    this.code = code;
    this.retryAt = retryAt;
  }
}
