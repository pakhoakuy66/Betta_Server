export const normalizeAuthEmail = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new TypeError('Email must be a string');
  }

  return value.trim().toLowerCase();
};
