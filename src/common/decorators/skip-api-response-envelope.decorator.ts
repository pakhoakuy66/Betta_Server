import { SetMetadata } from '@nestjs/common';

export const SKIP_API_RESPONSE_ENVELOPE = 'skipApiResponseEnvelope';

export const SkipApiResponseEnvelope = () =>
  SetMetadata(SKIP_API_RESPONSE_ENVELOPE, true);
