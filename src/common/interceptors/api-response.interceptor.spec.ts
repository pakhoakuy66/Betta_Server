import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  type CallHandler,
  type ExecutionContext,
  InternalServerErrorException,
  StreamableFile,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { ApiResponseInterceptor } from './api-response.interceptor';

describe('ApiResponseInterceptor', () => {
  let reflector: {
    getAllAndOverride: ReturnType<typeof jest.fn>;
  };
  let interceptor: ApiResponseInterceptor;
  let response: { statusCode: number };
  let context: ExecutionContext;

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    };

    interceptor = new ApiResponseInterceptor(reflector as unknown as Reflector);

    response = { statusCode: 200 };

    context = {
      getType: () => 'http',
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
      switchToHttp: () => ({
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
  });

  const execute = (payload: unknown) => {
    const next: CallHandler = {
      handle: () => of(payload),
    };

    return lastValueFrom(interceptor.intercept(context, next));
  };

  it('giữ message của entity trong data', async () => {
    const entity = {
      id: 'notification_1',
      message: 'Khoa đã thích bài viết',
      isRead: false,
    };

    await expect(execute(entity)).resolves.toEqual({
      success: true,
      data: entity,
    });
  });

  it('chuẩn hóa message-only response', async () => {
    await expect(execute({ message: 'Thành công' })).resolves.toEqual({
      success: true,
      message: 'Thành công',
      data: null,
    });
  });

  it('loại extra top-level field', async () => {
    await expect(
      execute({
        success: true,
        data: { id: 'usr_1' },
        internalDebug: 'secret',
      }),
    ).resolves.toEqual({
      success: true,
      data: { id: 'usr_1' },
    });
  });

  it('chuyển legacy token vào data', async () => {
    await expect(
      execute({
        success: true,
        message: 'Đăng nhập thành công',
        access_token: 'access',
        refresh_token: 'refresh',
      }),
    ).resolves.toEqual({
      success: true,
      message: 'Đăng nhập thành công',
      data: {
        access_token: 'access',
        refresh_token: 'refresh',
      },
    });
  });

  it('giữ meta và pagination', async () => {
    await expect(
      execute({
        success: true,
        data: [],
        meta: { count: 0 },
        pagination: { page: 1 },
      }),
    ).resolves.toEqual({
      success: true,
      data: [],
      meta: { count: 0 },
      pagination: { page: 1 },
    });
  });

  it('bypass opt-out', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const payload = { raw: true };

    await expect(execute(payload)).resolves.toBe(payload);
  });

  it('bypass HTTP 204', async () => {
    response.statusCode = 204;

    await expect(execute(undefined)).resolves.toBeUndefined();
  });

  it('bypass Buffer', async () => {
    const payload = Buffer.from('file');

    await expect(execute(payload)).resolves.toBe(payload);
  });

  it('bypass StreamableFile', async () => {
    const payload = new StreamableFile(Buffer.from('file'));

    await expect(execute(payload)).resolves.toBe(payload);
  });

  it('từ chối success=false với HTTP 2xx', async () => {
    await expect(execute({ success: false })).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
