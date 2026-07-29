import { ConfigService } from '@nestjs/config';

export type AppEnvironment = 'developer' | 'test' | 'production';

const APP_ENVIRONMENTS = new Set<AppEnvironment>([
  'developer',
  'test',
  'production',
]);

const DEFAULT_DEVELOPER_ORIGIN = 'http://localhost:5173';

export const parseExactOrigins = (
  rawValue: string,
  environment: AppEnvironment,
): readonly string[] => {
  const candidates = rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (candidates.length === 0) {
    throw new Error('CORS_ALLOWED_ORIGINS phải có ít nhất một origin');
  }

  const origins = candidates.map((candidate) => {
    if (candidate === '*') {
      throw new Error('CORS_ALLOWED_ORIGINS không được chứa wildcard');
    }

    let url: URL;

    try {
      url = new URL(candidate);
    } catch {
      throw new Error('CORS_ALLOWED_ORIGINS phải chứa exact origins');
    }

    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error('CORS_ALLOWED_ORIGINS phải chứa exact origins');
    }

    if (environment === 'production' && url.protocol !== 'https:') {
      throw new Error('Production CORS origins phải dùng HTTPS');
    }

    return url.origin;
  });

  return [...new Set(origins)];
};

export const readExactCorsOrigins = (
  configService: ConfigService,
): readonly string[] => {
  const rawEnvironment =
    configService.get<string>('NODE_ENV')?.trim() ?? 'developer';

  if (!APP_ENVIRONMENTS.has(rawEnvironment as AppEnvironment)) {
    throw new Error('NODE_ENV phải là developer, test hoặc production');
  }

  const environment = rawEnvironment as AppEnvironment;

  const configuredOrigins = configService
    .get<string>('CORS_ALLOWED_ORIGINS')
    ?.trim();

  if (environment === 'production' && !configuredOrigins) {
    throw new Error('CORS_ALLOWED_ORIGINS là bắt buộc trong production');
  }

  return parseExactOrigins(
    configuredOrigins || DEFAULT_DEVELOPER_ORIGIN,
    environment,
  );
};
