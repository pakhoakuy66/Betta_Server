import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SYSTEM_TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SYSTEM_TEST_DIRECTORY, '..', '..');
const isWindows = process.platform === 'win32';
const npmCommand = isWindows ? 'npm.cmd' : 'npm';
const npxCommand = isWindows ? 'npx.cmd' : 'npx';

function printHelp() {
  console.log(`
Chạy quality gate Backend:
  npm run test:gate

Tùy chọn:
  --integration   Chạy thêm toàn bộ MongoDB integration test.
  --install       Chạy npm ci trước quality gate.
  --audit         Chạy npm audit --omit=dev sau quality gate.
  --help          Hiển thị trợ giúp.

--integration yêu cầu MONGODB_INTEGRATION_URI và
RUN_MONGODB_INTEGRATION_TESTS=YES. Không dùng database production.
`);
}

function parseArguments(argumentsList) {
  const options = {
    integration: false,
    install: false,
    audit: false,
    help: false,
  };

  for (const argument of argumentsList) {
    if (argument === '--integration') {
      options.integration = true;
    } else if (argument === '--install') {
      options.install = true;
    } else if (argument === '--audit') {
      options.audit = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`Tham số không hỗ trợ: ${argument}`);
    }
  }

  return options;
}

function requireMongoIntegrationEnvironment() {
  const hasUri = Boolean(process.env.MONGODB_INTEGRATION_URI?.trim());
  const hasConfirmation =
    process.env.RUN_MONGODB_INTEGRATION_TESTS === 'YES';

  if (!hasUri || !hasConfirmation) {
    throw new Error(
      'MongoDB integration cần MONGODB_INTEGRATION_URI và RUN_MONGODB_INTEGRATION_TESTS=YES. Không dùng database production.',
    );
  }
}

function runCommand({ label, command, args }) {
  console.log(`\n=== ${label} ===`);
  console.log(`CWD: ${PROJECT_ROOT}`);
  console.log(`CMD: ${command} ${args.join(' ')}`);

  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: 'inherit',
    shell: isWindows,
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${label} thất bại với exit code ${result.status}.`);
  }

  console.log(`${label} PASS.`);
}

function main() {
  const options = parseArguments(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  if (options.integration) {
    requireMongoIntegrationEnvironment();
  }

  const commands = [];

  if (options.install) {
    commands.push({
      label: 'Backend npm ci',
      command: npmCommand,
      args: ['ci'],
    });
  }

  commands.push(
    {
      label: 'Backend ESLint không tự sửa',
      command: npxCommand,
      args: ['eslint', '{src,apps,libs,test}/**/*.ts'],
    },
    {
      label: 'Backend build',
      command: npmCommand,
      args: ['run', 'build'],
    },
    {
      label: 'Backend TypeScript typecheck',
      command: npxCommand,
      args: [
        'tsc',
        '--noEmit',
        '--incremental',
        'false',
        '--pretty',
        'false',
      ],
    },
    {
      label: 'Backend Jest unit regression',
      command: npmCommand,
      args: ['test', '--', '--runInBand'],
    },
    {
      label: 'Backend E2E cơ bản',
      command: npmCommand,
      args: ['run', 'test:e2e', '--', '--runInBand'],
    },
  );

  if (options.integration) {
    commands.push({
      label: 'Backend MongoDB integration regression',
      command: npmCommand,
      args: ['run', 'test:integration'],
    });
  }

  if (options.audit) {
    commands.push({
      label: 'Backend production dependency audit',
      command: npmCommand,
      args: ['audit', '--omit=dev'],
    });
  }

  for (const command of commands) {
    runCommand(command);
  }

  console.log(`\nBackend quality gate PASS: ${commands.length}/${commands.length}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
