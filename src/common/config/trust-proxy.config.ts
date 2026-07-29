import { ConfigService } from '@nestjs/config';

export type TrustProxyApplication = {
  set(setting: 'trust proxy', value: boolean | number): unknown;
};

export const readTrustProxyHops = (configService: ConfigService): number => {
  const rawValue = configService.get<string | number>('TRUST_PROXY_HOPS') ?? 0;

  if (typeof rawValue === 'string' && rawValue.trim().length === 0) {
    throw new Error('TRUST_PROXY_HOPS phải là số nguyên không âm');
  }

  const hops = Number(rawValue);

  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error('TRUST_PROXY_HOPS phải là số nguyên không âm');
  }

  return hops;
};

export const applyTrustProxyConfiguration = (
  application: TrustProxyApplication,
  configService: ConfigService,
): number => {
  const hops = readTrustProxyHops(configService);

  application.set('trust proxy', hops === 0 ? false : hops);

  return hops;
};
