# Backend quality gate

Runner này chỉ chạy công cụ đã được cài trong `Betta_Server/node_modules`.
Nó không đọc `.env`, không sửa mã nguồn và không gọi test của Frontend.

## Chạy quality gate

```powershell
cd D:\WebApp\Betta\Betta\Betta_Server
npm.cmd run test:gate
```

Quality gate mặc định gồm:

1. ESLint không tự sửa file.
2. NestJS build.
3. TypeScript typecheck.
4. Toàn bộ Jest unit regression.
5. E2E cơ bản.

## Chạy thêm MongoDB integration

Chỉ sử dụng Atlas hoặc replica set dành cho test:

```powershell
$secureUri = Read-Host "Nhap MongoDB integration URI" -AsSecureString

$env:MONGODB_INTEGRATION_URI = `
  [System.Net.NetworkCredential]::new("", $secureUri).Password

$env:RUN_MONGODB_INTEGRATION_TESTS = "YES"

npm.cmd run test:gate -- --integration
```

## Tùy chọn

```powershell
npm.cmd run test:gate -- --install
npm.cmd run test:gate -- --audit
```

Không chạy `npm audit fix --force` trong quality gate.

## Chạy test tập trung

```powershell
npx.cmd jest --runInBand --runTestsByPath `
  src/modules/auth/services/auth.service.spec.ts
```
