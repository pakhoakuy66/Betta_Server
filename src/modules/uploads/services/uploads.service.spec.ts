import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { v2 as cloudinary } from 'cloudinary';
import type { UploadApiResponse } from 'cloudinary';
import type { Mock } from 'jest-mock';
import { PassThrough } from 'stream';
import { UploadsService } from './uploads.service';

jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    uploader: {
      upload_stream: jest.fn(),
      destroy: jest.fn(),
    },
  },
}));

type UploadFileMock = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

type UploadCallback = (error?: unknown, result?: UploadApiResponse) => void;

const cloudinaryConfigMock = cloudinary.config as unknown as Mock<
  (...args: unknown[]) => unknown
>;

const uploadStreamMock = cloudinary.uploader.upload_stream as unknown as Mock<
  (...args: unknown[]) => unknown
>;

const destroyMock = cloudinary.uploader.destroy as unknown as Mock<
  (...args: unknown[]) => unknown
>;

const VALID_FILE: UploadFileMock = {
  buffer: Buffer.from('valid-image-buffer'),
  mimetype: 'image/webp',
  size: 1024,
  originalname: 'image.webp',
};

const CLOUDINARY_RESULT = {
  secure_url: 'https://example.com/image.webp',
  public_id: 'betta/betta-dev/posts/image',
  width: 1024,
  height: 768,
  format: 'webp',
  bytes: 12345,
} as UploadApiResponse;

const AVATAR_RESULT = {
  ...CLOUDINARY_RESULT,
  secure_url: 'https://example.com/avatar.webp',
  public_id: 'betta/betta-dev/avatars/avatar',
} as UploadApiResponse;

const SYSTEM_REPORT_RESULT = {
  ...CLOUDINARY_RESULT,
  secure_url: 'https://example.com/evidence.webp',
  public_id: 'betta/betta-dev/system-reports/evidence',
} as UploadApiResponse;

type ConfigOverrides = Partial<Record<string, string | undefined>>;

const createConfig = (overrides: ConfigOverrides = {}): ConfigService => {
  const values: Record<string, string | undefined> = {
    CLOUDINARY_CLOUD_NAME: 'test-cloud',
    CLOUDINARY_API_KEY: 'test-key',
    CLOUDINARY_API_SECRET: 'test-secret',
    CLOUDINARY_ROOT_FOLDER: 'betta/betta-dev',
    ...overrides,
  };

  return {
    getOrThrow: jest.fn((key: string) => {
      const value = values[key];

      if (value === undefined) {
        throw new Error(`Missing config: ${key}`);
      }

      return value;
    }),
  } as unknown as ConfigService;
};

const createUploadImplementation =
  (
    result?: UploadApiResponse,
    error?: unknown,
  ): ((...args: unknown[]) => PassThrough) =>
  (...args: unknown[]) => {
    const callback = args[1] as UploadCallback;
    const stream = new PassThrough();

    stream.on('finish', () => {
      callback(error, result);
    });

    return stream;
  };

const createContext = (configOverrides: ConfigOverrides = {}) => {
  const service = new UploadsService(createConfig(configOverrides));

  return { service };
};

describe('UploadsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    cloudinaryConfigMock.mockImplementation(() => undefined);

    destroyMock.mockImplementation(() => Promise.resolve({ result: 'ok' }));

    uploadStreamMock.mockImplementation(
      createUploadImplementation(CLOUDINARY_RESULT),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('configuration', () => {
    it('configures Cloudinary using secure mode', () => {
      createContext();

      expect(cloudinaryConfigMock).toHaveBeenCalledWith({
        cloud_name: 'test-cloud',
        api_key: 'test-key',
        api_secret: 'test-secret',
        secure: true,
      });
    });

    it('accepts a valid nested Cloudinary root folder', () => {
      expect(() =>
        createContext({
          CLOUDINARY_ROOT_FOLDER: 'betta/betta-dev',
        }),
      ).not.toThrow();
    });

    it.each([
      '',
      '/Betta/Betta-dev',
      'Betta/Betta-dev/',
      'Betta//Betta-dev',
      'Betta/../Betta-dev',
      'Betta\\Betta-dev',
      'Betta/Betta dev',
    ])('rejects invalid Cloudinary root folder: %s', (folder) => {
      expect(() =>
        createContext({
          CLOUDINARY_ROOT_FOLDER: folder,
        }),
      ).toThrow('CLOUDINARY_ROOT_FOLDER phải là đường dẫn thư mục hợp lệ');
    });
  });

  describe('file validation', () => {
    it('rejects a file without a buffer', async () => {
      const { service } = createContext();

      const invalidFile = {
        ...VALID_FILE,
        buffer: undefined,
      } as unknown as UploadFileMock;

      await expect(service.uploadPostImage(invalidFile)).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(uploadStreamMock).not.toHaveBeenCalled();
    });

    it('rejects an unsupported MIME type', async () => {
      const { service } = createContext();

      await expect(
        service.uploadPostImage({
          ...VALID_FILE,
          mimetype: 'image/gif',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(uploadStreamMock).not.toHaveBeenCalled();
    });

    it('rejects an image larger than 5MB', async () => {
      const { service } = createContext();

      await expect(
        service.uploadPostImage({
          ...VALID_FILE,
          size: 5 * 1024 * 1024 + 1,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(uploadStreamMock).not.toHaveBeenCalled();
    });

    it.each(['image/jpeg', 'image/png', 'image/webp'])(
      'accepts supported MIME type %s',
      async (mimetype) => {
        const { service } = createContext();

        await expect(
          service.uploadPostImage({
            ...VALID_FILE,
            mimetype,
          }),
        ).resolves.toEqual({
          url: CLOUDINARY_RESULT.secure_url,
          publicId: CLOUDINARY_RESULT.public_id,
          width: CLOUDINARY_RESULT.width,
          height: CLOUDINARY_RESULT.height,
          format: CLOUDINARY_RESULT.format,
          bytes: CLOUDINARY_RESULT.bytes,
        });
      },
    );
  });

  describe('upload destinations', () => {
    it('uploads post images using the post folder and safe options', async () => {
      const { service } = createContext();

      const result = await service.uploadPostImage(VALID_FILE);

      expect(uploadStreamMock).toHaveBeenCalledWith(
        {
          asset_folder: 'betta/betta-dev/posts',
          use_asset_folder_as_public_id_prefix: true,
          resource_type: 'image',
          overwrite: false,
          unique_filename: true,
          use_filename: false,
        },
        expect.any(Function),
      );

      expect(result).toEqual({
        url: 'https://example.com/image.webp',
        publicId: CLOUDINARY_RESULT.public_id,
        width: 1024,
        height: 768,
        format: 'webp',
        bytes: 12345,
      });
    });

    it('uploads avatars to the avatar folder', async () => {
      const { service } = createContext();

      uploadStreamMock.mockImplementation(
        createUploadImplementation(AVATAR_RESULT),
      );

      const result = await service.uploadAvatar(VALID_FILE);

      expect(uploadStreamMock).toHaveBeenCalledWith(
        expect.objectContaining({
          asset_folder: 'betta/betta-dev/avatars',
          use_asset_folder_as_public_id_prefix: true,
        }),
        expect.any(Function),
      );

      expect(result.publicId).toBe(AVATAR_RESULT.public_id);
    });

    it('uploads report evidence to the system-report folder', async () => {
      const { service } = createContext();

      uploadStreamMock.mockImplementation(
        createUploadImplementation(SYSTEM_REPORT_RESULT),
      );

      const result = await service.uploadSystemReportImage(VALID_FILE);

      expect(uploadStreamMock).toHaveBeenCalledWith(
        expect.objectContaining({
          asset_folder: 'betta/betta-dev/system-reports',
          use_asset_folder_as_public_id_prefix: true,
        }),
        expect.any(Function),
      );

      expect(result.publicId).toBe(SYSTEM_REPORT_RESULT.public_id);
    });

    it('maps Cloudinary callback failure to a safe server error', async () => {
      const { service } = createContext();

      uploadStreamMock.mockImplementation(
        createUploadImplementation(
          undefined,
          new Error('Cloudinary internal details'),
        ),
      );

      await expect(service.uploadPostImage(VALID_FILE)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('multiple uploads', () => {
    it('rejects more than three post images before uploading', async () => {
      const { service } = createContext();

      await expect(
        service.uploadPostImages([
          VALID_FILE,
          VALID_FILE,
          VALID_FILE,
          VALID_FILE,
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(uploadStreamMock).not.toHaveBeenCalled();
    });

    it('cleans successful post uploads when another upload fails', async () => {
      const { service } = createContext();

      uploadStreamMock
        .mockImplementationOnce(createUploadImplementation(CLOUDINARY_RESULT))
        .mockImplementationOnce(
          createUploadImplementation(
            undefined,
            new Error('Second upload failed'),
          ),
        );

      await expect(
        service.uploadPostImages([
          VALID_FILE,
          {
            ...VALID_FILE,
            originalname: 'second.webp',
          },
        ]),
      ).rejects.toBeInstanceOf(InternalServerErrorException);

      expect(destroyMock).toHaveBeenCalledWith(CLOUDINARY_RESULT.public_id, {
        resource_type: 'image',
        invalidate: true,
      });
    });

    it('rejects more than three report evidence images', async () => {
      const { service } = createContext();

      await expect(
        service.uploadSystemReportImages([
          VALID_FILE,
          VALID_FILE,
          VALID_FILE,
          VALID_FILE,
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(uploadStreamMock).not.toHaveBeenCalled();
    });

    it('cleans previous report evidence after a partial failure', async () => {
      const { service } = createContext();

      uploadStreamMock
        .mockImplementationOnce(
          createUploadImplementation(SYSTEM_REPORT_RESULT),
        )
        .mockImplementationOnce(
          createUploadImplementation(
            undefined,
            new Error('Second evidence failed'),
          ),
        );

      await expect(
        service.uploadSystemReportImages([
          VALID_FILE,
          {
            ...VALID_FILE,
            originalname: 'second.webp',
          },
        ]),
      ).rejects.toBeInstanceOf(InternalServerErrorException);

      expect(destroyMock).toHaveBeenCalledWith(SYSTEM_REPORT_RESULT.public_id, {
        resource_type: 'image',
        invalidate: true,
      });
    });
  });

  describe('deletion', () => {
    it('does nothing for an empty publicId', async () => {
      const { service } = createContext();

      await service.deleteImage('');

      expect(destroyMock).not.toHaveBeenCalled();
    });

    it.each(['ok', 'not found'])(
      'accepts Cloudinary delete result "%s"',
      async (result) => {
        const { service } = createContext();

        destroyMock.mockImplementation(() => Promise.resolve({ result }));

        await expect(
          service.deleteImage('betta/posts/image'),
        ).resolves.toBeUndefined();
      },
    );

    it('ignores deletion failure by default', async () => {
      const { service } = createContext();

      destroyMock.mockImplementation(() =>
        Promise.reject(new Error('Cloudinary unavailable')),
      );

      await expect(
        service.deleteImage('betta/posts/image'),
      ).resolves.toBeUndefined();
    });

    it('propagates deletion failure when requested', async () => {
      const { service } = createContext();
      const deleteError = new Error('Cloudinary unavailable');

      destroyMock.mockImplementation(() => Promise.reject(deleteError));

      await expect(
        service.deleteImage('betta/posts/image', {
          throwOnError: true,
        }),
      ).rejects.toBe(deleteError);
    });

    it('deduplicates public IDs before deletion', async () => {
      const { service } = createContext();

      await service.deleteImages([
        'betta/posts/a',
        '',
        'betta/posts/a',
        'betta/posts/b',
      ]);

      expect(destroyMock).toHaveBeenCalledTimes(2);

      expect(destroyMock).toHaveBeenCalledWith(
        'betta/posts/a',
        expect.any(Object),
      );

      expect(destroyMock).toHaveBeenCalledWith(
        'betta/posts/b',
        expect.any(Object),
      );
    });

    it('reports aggregate deletion failures in strict mode', async () => {
      const { service } = createContext();

      destroyMock.mockImplementation((...args: unknown[]) => {
        const publicId = args[0];

        return publicId === 'betta/posts/fail'
          ? Promise.reject(new Error('Delete failed'))
          : Promise.resolve({ result: 'ok' });
      });

      await expect(
        service.deleteImages(['betta/posts/ok', 'betta/posts/fail'], {
          throwOnError: true,
        }),
      ).rejects.toThrow('Failed to delete 1/2 Cloudinary images');
    });
  });
});
