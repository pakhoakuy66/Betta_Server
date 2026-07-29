import { describe, expect, it, jest } from '@jest/globals';
import { type ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { ApiExceptionFilter } from './api-exception.filter';

describe('ApiExceptionFilter', () => {
  const createHost = (url = '/api/v1/test?token=secret') => {
    const json = jest.fn();
    const response = {
      status: jest.fn(),
      json,
      setHeader: jest.fn(),
    };

    response.status.mockReturnValue(response);

    const host = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          url,
          originalUrl: url,
        }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;

    return { host, response };
  };

  it('lọc non-string khỏi validation array', () => {
    const { host, response } = createHost();
    const filter = new ApiExceptionFilter();

    filter.catch(
      new HttpException(
        {
          message: ['Tên không hợp lệ', { internal: 'secret' }],
        },
        HttpStatus.BAD_REQUEST,
      ),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'VALIDATION_ERROR',
        message: ['Tên không hợp lệ'],
        path: '/api/v1/test',
      }),
    );
  });

  it('không trả object message ra client', () => {
    const { host, response } = createHost();
    const filter = new ApiExceptionFilter();

    filter.catch(
      new HttpException(
        {
          message: {
            internalQuery: 'secret',
          },
        },
        HttpStatus.CONFLICT,
      ),
      host,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CONFLICT',
        message: 'Yêu cầu không thể xử lý',
      }),
    );
  });

  it('chuẩn hóa rate limit và Retry-After', () => {
    const { host, response } = createHost();
    const filter = new ApiExceptionFilter();

    filter.catch(
      new HttpException(
        {
          message: 'Vui lòng thử lại sau',
          retryAfterSeconds: 59.2,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      ),
      host,
    );

    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'RATE_LIMITED',
        retryAfterSeconds: 60,
      }),
    );
  });

  it('không expose custom internal code', () => {
    const { host, response } = createHost();
    const filter = new ApiExceptionFilter();

    filter.catch(
      new HttpException(
        {
          message: 'Conflict',
          code: 'MONGO_DUPLICATE_KEY',
        },
        HttpStatus.CONFLICT,
      ),
      host,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'CONFLICT',
      }),
    );
  });

  it('không leak lỗi 500', () => {
    const { host, response } = createHost();
    const filter = new ApiExceptionFilter();

    filter.catch(new Error('MongoDB connection secret'), host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Đã xảy ra lỗi hệ thống',
        path: '/api/v1/test',
      }),
    );
  });

  it('không leak query string trong route 404 mặc định', () => {
    const url = '/api/v1/does-not-exist?secret=must-not-appear';

    const { host, response } = createHost(url);
    const filter = new ApiExceptionFilter();

    filter.catch(
      new HttpException(
        {
          statusCode: HttpStatus.NOT_FOUND,
          message: `Cannot GET ${url}`,
          error: 'Not Found',
        },
        HttpStatus.NOT_FOUND,
      ),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        statusCode: 404,
        error: 'NOT_FOUND',
        message: 'Không tìm thấy tài nguyên',
        path: '/api/v1/does-not-exist',
      }),
    );
  });
});
