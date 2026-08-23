import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import type { Model } from 'mongoose';
import type { AccessSupportRequestDto } from '../dto/access-support-request.dto';
import type { SystemReport } from '../schemas/system-report.schema';
import type { AccessSupportCryptoService } from './access-support-crypto.service';
import type { AccessSupportDedupeService } from './access-support-dedupe.service';
import type { AccessSupportRateLimitService } from './access-support-rate-limit.service';
import { AccessSupportService } from './access-support.service';

const request: AccessSupportRequestDto = {
  category: 'LOGIN_PROBLEM',
  contactEmail: 'person@example.com',
  description: 'Tôi không thể đăng nhập vào tài khoản từ sáng nay.',
  accountEmailOrUsername: 'person',
};

describe('AccessSupportService', () => {
  const createService = (duplicate: { publicId: string } | null = null) => {
    const exec = jest.fn<() => Promise<{ publicId: string } | null>>();
    exec.mockResolvedValue(duplicate);
    const findOne = jest.fn(() => ({
      select: jest.fn(() => ({
        lean: jest.fn(() => ({ exec })),
      })),
    }));
    const create =
      jest.fn<
        (value: Record<string, unknown>) => Promise<Record<string, unknown>>
      >();
    create.mockImplementation((value) => Promise.resolve(value));
    const model = { findOne, create } as unknown as Model<SystemReport>;
    const hmac = jest.fn((domain: string, value: string) =>
      createHash('sha256').update(`${domain}:${value}`).digest('hex'),
    );
    const crypto = {
      hmac,
      encrypt: jest.fn((value: string) => `encrypted:${value.length}`),
    } as unknown as AccessSupportCryptoService;
    const rateLimit = {
      consumeIp: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      consumeContact: jest
        .fn<() => Promise<void>>()
        .mockResolvedValue(undefined),
    } as unknown as AccessSupportRateLimitService;
    const claim = jest
      .fn<() => Promise<{ reportPublicId: string }>>()
      .mockResolvedValue({ reportPublicId: 'srep_newreport23456' });
    const dedupe = { claim } as unknown as AccessSupportDedupeService;
    return {
      service: new AccessSupportService(model, crypto, rateLimit, dedupe),
      create,
      claim,
      hmac,
    };
  };

  it('returns the same safe acknowledgement for a recent duplicate', async () => {
    const { service, create, claim } = createService({
      publicId: 'srep_duplicate123456',
    });
    await expect(service.submit(request, '127.0.0.1')).resolves.toEqual({
      reportPublicId: 'srep_duplicate123456',
      message:
        'Yêu cầu hỗ trợ đã được ghi nhận. Chúng tôi sẽ xem xét thông tin bạn cung cấp.',
    });
    expect(create).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it('encrypts contact fields and never persists their plaintext', async () => {
    const { service, create } = createService();
    await service.submit(request, '127.0.0.1');
    const persisted = create.mock.calls[0][0];
    expect(persisted.publicId).toBe('srep_newreport23456');
    expect(persisted.reporterId).toBeNull();
    expect(persisted.encryptedContactEmail).toBe('encrypted:18');
    expect(JSON.stringify(persisted)).not.toContain('person@example.com');
    expect(persisted).not.toHaveProperty('password');
  });

  it('excludes correlation id from semantic dedupe but persists it for tracing', async () => {
    const { service, create, hmac } = createService();
    const businessRequest = {
      ...request,
      correlationId: 'corr-semantic-0001',
    };

    await service.submit(businessRequest, '127.0.0.1');
    await service.submit(
      { ...businessRequest, correlationId: 'corr-semantic-0002' },
      '127.0.0.2',
    );

    const dedupeInputs = hmac.mock.calls
      .filter(([domain]) => domain === 'dedupe')
      .map(([, value]) => value);

    expect(dedupeInputs).toHaveLength(2);
    expect(dedupeInputs[0]).toBe(dedupeInputs[1]);
    expect(dedupeInputs[0]).not.toContain('corr-semantic');
    expect(create.mock.calls[0][0].correlationId).toBe('corr-semantic-0001');
  });

  it('rejects credential-like material before persistence', async () => {
    const { service, create } = createService();
    await expect(
      service.submit(
        {
          ...request,
          description: 'Tôi không đăng nhập được, password: secret-value',
        },
        '127.0.0.1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    'Mật khẩu của tôi là secret-value, nhờ hỗ trợ đăng nhập.',
    'My password is secret-value, please help me sign in.',
    'OTP của tôi là 123456, nhưng hệ thống không chấp nhận.',
    'Mã khôi phục của tôi là ABCD-EFGH, nhờ kiểm tra.',
    'Mật\u200B khẩu của tôi là hidden-value, nhờ hỗ trợ.',
  ])('rejects natural-language credential disclosure: %s', async (value) => {
    const { service, create } = createService();

    await expect(
      service.submit({ ...request, description: value }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it('allows a support description that mentions a password without disclosing it', async () => {
    const { service, create } = createService();

    await expect(
      service.submit(
        {
          ...request,
          description: 'Tôi quên mật khẩu và cần hỗ trợ đặt lại tài khoản.',
        },
        '127.0.0.1',
      ),
    ).resolves.toMatchObject({ reportPublicId: 'srep_newreport23456' });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
