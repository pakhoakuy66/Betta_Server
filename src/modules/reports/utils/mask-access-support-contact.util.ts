const INVALID_CONTACT_MESSAGE = 'Access-support contact không hợp lệ';

const maskLabel = (value: string): string => {
  const [first] = Array.from(value);
  if (!first) throw new TypeError(INVALID_CONTACT_MESSAGE);
  return `${first}***`;
};

/**
 * Mask cố định, không làm lộ độ dài local-part/domain label.
 * TLD được giữ để Admin nhận biết lỗi nhập domain phổ biến mà không reveal.
 */
export const maskAccessSupportContactEmail = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  const separator = normalized.lastIndexOf('@');
  if (separator <= 0 || separator === normalized.length - 1) {
    throw new TypeError(INVALID_CONTACT_MESSAGE);
  }

  const localPart = normalized.slice(0, separator);
  const domainLabels = normalized.slice(separator + 1).split('.');
  if (
    domainLabels.length < 2 ||
    domainLabels.some((label) => label.length === 0)
  ) {
    throw new TypeError(INVALID_CONTACT_MESSAGE);
  }

  const topLevelDomain = domainLabels.pop();
  if (!topLevelDomain) throw new TypeError(INVALID_CONTACT_MESSAGE);

  return `${maskLabel(localPart)}@${domainLabels
    .map(maskLabel)
    .join('.')}.${topLevelDomain}`;
};
