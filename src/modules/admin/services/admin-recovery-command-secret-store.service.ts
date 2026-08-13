import { spawn } from 'node:child_process';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ADMIN_BOOTSTRAP_SECRET_ARGS_ENV,
  ADMIN_BOOTSTRAP_SECRET_COMMAND_MAX_OUTPUT_BYTES,
  ADMIN_BOOTSTRAP_SECRET_COMMAND_TIMEOUT_MS,
  ADMIN_BOOTSTRAP_SECRET_EXECUTABLE_ENV,
  ADMIN_BOOTSTRAP_SECRET_REFERENCE_PATTERN,
} from '../constants/admin-bootstrap.constants';
import { AdminRecoveryPurpose } from '../constants/admin-account-recovery.constants';
import {
  type AdminRecoverySecretStore,
  type PutAdminRecoverySecretInput,
} from '../interfaces/admin-account-recovery.interface';
import { isCanonicalAdminSecurityGrant } from '../utils/admin-security-grant';
import { isValidAdminPublicId } from '../utils/generate-admin-public-id';

type CommandConfiguration = Readonly<{
  executable: string;
  args: readonly string[];
}>;

const isCommandArgumentArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 32 &&
  value.every(
    (item: unknown) =>
      typeof item === 'string' &&
      item.length > 0 &&
      item.length <= 2_048 &&
      !item.includes('\0'),
  );

const SECRET_NAME_PATTERN = /^[a-z][a-z0-9/_-]{7,127}$/;

@Injectable()
export class AdminRecoveryCommandSecretStore implements AdminRecoverySecretStore {
  constructor(private readonly config: ConfigService) {}

  assertReady(): void {
    this.readConfiguration();
  }

  async putVersion(input: PutAdminRecoverySecretInput): Promise<string> {
    if (
      !SECRET_NAME_PATTERN.test(input.secretName) ||
      !isCanonicalAdminSecurityGrant(input.rawGrant) ||
      !isValidAdminPublicId(input.targetPublicId) ||
      !Object.values(AdminRecoveryPurpose).includes(input.purpose) ||
      !(input.expiresAt instanceof Date) ||
      input.expiresAt.getTime() <= Date.now()
    ) {
      throw new TypeError('Admin recovery secret input không hợp lệ');
    }

    const output = await this.run({
      operation: 'put-version',
      secretName: input.secretName,
      value: input.rawGrant,
      expiresAt: input.expiresAt.toISOString(),
      metadata: {
        purpose: input.purpose,
        targetPublicId: input.targetPublicId,
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
      throw new TypeError('Admin recovery secret reference không hợp lệ');
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

    let args: unknown = [];
    try {
      args = rawArgs ? (JSON.parse(rawArgs) as unknown) : [];
    } catch {
      throw new Error(`${ADMIN_BOOTSTRAP_SECRET_ARGS_ENV} phải là JSON hợp lệ`);
    }
    if (!isCommandArgumentArray(args)) {
      throw new Error(
        `${ADMIN_BOOTSTRAP_SECRET_ARGS_ENV} phải là JSON array string hợp lệ`,
      );
    }
    return Object.freeze({ executable, args: Object.freeze([...args]) });
  }

  private async run(command: Record<string, unknown>): Promise<string> {
    const configuration = this.readConfiguration();
    const payload = JSON.stringify(command);
    return new Promise<string>((resolve, reject) => {
      const child = spawn(configuration.executable, configuration.args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let bytes = 0;
      let settled = false;
      const finishWithFailure = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(
          new ServiceUnavailableException(
            'Không thể ghi recovery grant vào Secret Manager',
          ),
        );
      };
      const timeout = setTimeout(() => {
        child.kill();
        finishWithFailure();
      }, ADMIN_BOOTSTRAP_SECRET_COMMAND_TIMEOUT_MS);
      timeout.unref();

      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > ADMIN_BOOTSTRAP_SECRET_COMMAND_MAX_OUTPUT_BYTES) {
          child.kill();
          finishWithFailure();
          return;
        }
        stdout += chunk.toString('utf8');
      });
      child.stderr.resume();
      child.once('error', finishWithFailure);
      child.once('close', (code) => {
        if (settled) return;
        clearTimeout(timeout);
        if (code !== 0) return finishWithFailure();
        settled = true;
        resolve(stdout);
      });
      child.stdin.on('error', finishWithFailure);
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
