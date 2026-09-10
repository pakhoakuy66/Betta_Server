import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateSponsoredPostDto,
  UpdateSponsoredPostDto,
  SponsoredVersionMutationDto,
} from './sponsored-post-mutation.dto';

const body = {
  content: 'Campaign test',
  cta: 'Learn more',
  destinationUrl: 'https://example.com/offer',
  startAt: '2026-09-10T00:00:00Z',
  endAt: '2026-09-12T00:00:00Z',
  reasonCode: 'campaign_review',
};
const options = { whitelist: true, forbidNonWhitelisted: true };
describe('SADM-SPON-08 mutation DTO allowlist', () => {
  it('trims an optional safe correlation ID', async () => {
    const dto = plainToInstance(CreateSponsoredPostDto, {
      ...body,
      correlationId: '  corr_spon_manual_0001  ',
    });
    expect(await validate(dto, options)).toEqual([]);
    expect(dto.correlationId).toBe('corr_spon_manual_0001');
  });
  it.each([
    null,
    '',
    'short',
    'https://secret.example/token',
    'corr_invalid\nline_0001',
  ])('rejects correlation %s', async (correlationId) => {
    expect(
      (
        await validate(
          plainToInstance(CreateSponsoredPostDto, { ...body, correlationId }),
          options,
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  it('accepts JSON content fields and UTC dates', async () => {
    expect(
      await validate(plainToInstance(CreateSponsoredPostDto, body), options),
    ).toEqual([]);
  });
  it.each([
    'images',
    'publicId',
    'ownerPublicId',
    'status',
    'assetHealth',
    'version',
    '$set',
  ])('rejects client-controlled %s', async (field) => {
    const errors = await validate(
      plainToInstance(CreateSponsoredPostDto, { ...body, [field]: 'forged' }),
      options,
    );
    expect(errors.length).toBeGreaterThan(0);
  });
  it.each([null, '0', -1, 100000, 1.5])(
    'rejects invalid version %s',
    async (expectedVersion) => {
      expect(
        (
          await validate(
            plainToInstance(UpdateSponsoredPostDto, {
              ...body,
              expectedVersion,
            }),
            options,
          )
        ).length,
      ).toBeGreaterThan(0);
    },
  );
  it.each([
    '2026-02-30T00:00:00Z',
    '2026-09-10',
    '2026-09-10T00:00:00+07:00',
    null,
  ])('rejects date %s', async (startAt) => {
    expect(
      (
        await validate(
          plainToInstance(CreateSponsoredPostDto, { ...body, startAt }),
          options,
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  it('requires a machine reason and version for delete/restore', async () => {
    expect(
      (
        await validate(
          plainToInstance(SponsoredVersionMutationDto, {}),
          options,
        )
      ).length,
    ).toBe(2);
    expect(
      await validate(
        plainToInstance(SponsoredVersionMutationDto, {
          expectedVersion: 0,
          reasonCode: 'campaign_review',
        }),
        options,
      ),
    ).toEqual([]);
  });
});
