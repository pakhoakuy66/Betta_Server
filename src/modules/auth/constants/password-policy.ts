export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;

export const PASSWORD_COMPLEXITY_PATTERN =
  /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9\s])/;

export const PASSWORD_POLICY_MESSAGE =
  'Mật khẩu phải tối thiểu 8 ký tự, bao gồm chữ, số và ít nhất một ký tự đặc biệt';
