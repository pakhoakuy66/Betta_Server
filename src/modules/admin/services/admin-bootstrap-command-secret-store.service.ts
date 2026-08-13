import { spawn } from 'node:child_process';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ADMIN_BOOTSTRAP_SECRET_ARGS_ENV,
  ADMIN_BOOTSTRAP_SECRET_COMMAND_MAX_OUTPUT_BYTES,
  ADMIN_BOOTSTRAP_SECRET_COMMAND_TIMEOUT_MS,
  ADMIN_BOOTSTRAP_SECRET_EXECUTABLE_ENV,
  ADMIN_BOOTSTRAP_SECRET_REFERENCE_PATTERN,
  AdminActivationGrantPurpose,
  AdminBootstrapEnvironment,
} from '../constants/admin-bootstrap.constants';
import {
  type AdminBootstrapSecretStore,
  type PutAdminBootstrapSecretInput,
} from '../interfaces/admin-bootstrap.interface';
import { isCanonicalAdminActivationGrant } from '../utils/admin-activation-grant';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';

type CommandConfiguration = Readonly<{
  executable: string;
  args: readonly string[];
}>;

type SecretCommand =
  | Readonly<{
      operation: 'put-version';
      secretName: string;
      value: string;
      expiresAt: string;
      metadata: Readonly<{
        purpose: string;
        targetPublicId: string;
        environment: string;
      }>;
    }>
  | Readonly<{
      operation: 'revoke-version';
      reference: string;
    }>;

const SECRET_NAME_PATTERN = /^[a-z][a-z0-9/_-]{7,127}$/;

const isValidArgumentArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 32 &&
  value.every(
    (argument: unknown) =>
      typeof argument === 'string' &&
      argument.length > 0 &&
      argument.length <= 2_048 &&
      !argument.includes('\0'),
  );

@Injectable()
export class AdminBootstrapCommandSecretStore implements AdminBootstrapSecretStore {
  constructor(private readonly config: ConfigService) {}

  assertReady(): void {
    this.readConfiguration();
  }

  async putVersion(input: PutAdminBootstrapSecretInput): Promise<string> {
    if (
      !SECRET_NAME_PATTERN.test(input.secretName) ||
      !isCanonicalAdminActivationGrant(input.rawGrant) ||
      !(input.expiresAt instanceof Date) ||
      Number.isNaN(input.expiresAt.getTime()) ||
      input.expiresAt.getTime() <= Date.now() ||
      !Object.values(AdminActivationGrantPurpose).includes(
        input.context.purpose,
      ) ||
      !Object.values(AdminBootstrapEnvironment).includes(
        input.context.environment,
      ) ||
      !isValidAdminPublicId(input.context.targetPublicId)
    ) {
      throw new TypeError('Admin bootstrap secret input không hợp lệ');
    }

    const output = await this.run({
      operation: 'put-version',
      secretName: input.secretName,
      value: input.rawGrant,
      expiresAt: input.expiresAt.toISOString(),
      metadata: {
        purpose: input.context.purpose,
        targetPublicId: input.context.targetPublicId,
        environment: input.context.environment,
      },
    });
    const reference = this.readReference(output);
    if (reference === input.rawGrant) {
      throw new ServiceUnavailableException(
        'Secret Manager trả về reference không hợp lệ',
      );
    }
    return reference;
  }

  async revokeVersion(secretReference: string): Promise<void> {
    if (!ADMIN_BOOTSTRAP_SECRET_REFERENCE_PATTERN.test(secretReference)) {
      throw new TypeError('Admin bootstrap secret reference không hợp lệ');
    }
    await this.run({ operation: 'revoke-version', reference: secretReference });
  }

  private readConfiguration(): CommandConfiguration {
    const executable = this.config
      .get<string>(ADMIN_BOOTSTRAP_SECRET_EXECUTABLE_ENV)
      ?.trim();
    const rawArgs = this.config
      .get<string>(ADMIN_BOOTSTRAP_SECRET_ARGS_ENV)
      ?.trim();

    if (!executable || executable.length > 512) {
      throw new Error(
        `${ADMIN_BOOTSTRAP_SECRET_EXECUTABLE_ENV} chưa được cấu hình hợp lệ`,
      );
    }

    let parsed: unknown = [];
    if (rawArgs) {
      try {
        parsed = JSON.parse(rawArgs) as unknown;
      } catch {
        throw new Error(
          `${ADMIN_BOOTSTRAP_SECRET_ARGS_ENV} phải là JSON hợp lệ`,
        );
      }
    }

    if (!isValidArgumentArray(parsed)) {
      throw new Error(
        `${ADMIN_BOOTSTRAP_SECRET_ARGS_ENV} phải là JSON array string hợp lệ`,
      );
    }

    return Object.freeze({ executable, args: Object.freeze([...parsed]) });
  }

  private async run(command: SecretCommand): Promise<string> {
    const configuration = this.readConfiguration();
    const payload = JSON.stringify(command);

    return new Promise<string>((resolve, reject) => {
      const child = spawn(configuration.executable, configuration.args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let outputBytes = 0;
      let settled = false;

      const fail = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(
          new ServiceUnavailableException(
            'Không thể ghi activation grant vào Secret Manager',
          ),
        );
      };

      const timeout = setTimeout(() => {
        child.kill();
        fail();
      }, ADMIN_BOOTSTRAP_SECRET_COMMAND_TIMEOUT_MS);
      timeout.unref();

      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > ADMIN_BOOTSTRAP_SECRET_COMMAND_MAX_OUTPUT_BYTES) {
          child.kill();
          fail();
          return;
        }
        stdout += chunk.toString('utf8');
      });
      child.stderr.resume();
      child.once('error', fail);
      child.once('close', (exitCode) => {
        if (settled) return;
        clearTimeout(timeout);
        if (exitCode !== 0) {
          fail();
          return;
        }
        settled = true;
        resolve(stdout);
      });

      child.stdin.on('error', fail);
      child.stdin.end(payload, 'utf8');
    });
  }

  private readReference(output: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output) as unknown;
    } catch {
      throw new ServiceUnavailableException(
        'Secret Manager trả về response không hợp lệ',
      );
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 ||
      !('reference' in parsed) ||
      typeof parsed.reference !== 'string' ||
      !ADMIN_BOOTSTRAP_SECRET_REFERENCE_PATTERN.test(parsed.reference)
    ) {
      throw new ServiceUnavailableException(
        'Secret Manager trả về response không hợp lệ',
      );
    }
    return parsed.reference;
  }
}
