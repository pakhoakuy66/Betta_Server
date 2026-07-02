const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const RECAP_TIMEZONE = 'Asia/Ho_Chi_Minh';
export const RECAP_TIMEZONE_OFFSET_MS = 7 * 60 * 60 * 1000;

export type RecapWeekRange = {
  weekStart: Date;
  weekEnd: Date;
};

export type RecapWeekIdentity = {
  year: number;
  weekNumber: number;
  weekKey: string;
};

export const getRecapWeekRange = (date: Date): RecapWeekRange => {
  const localTimestamp = date.getTime() + RECAP_TIMEZONE_OFFSET_MS;
  const localDate = new Date(localTimestamp);

  const localMidnightTimestamp = Date.UTC(
    localDate.getUTCFullYear(),
    localDate.getUTCMonth(),
    localDate.getUTCDate(),
  );

  const dayOfWeek = localDate.getUTCDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const weekStartLocalTimestamp =
    localMidnightTimestamp - daysFromMonday * ONE_DAY_MS;

  const weekStartUtcTimestamp =
    weekStartLocalTimestamp - RECAP_TIMEZONE_OFFSET_MS;

  return {
    weekStart: new Date(weekStartUtcTimestamp),
    weekEnd: new Date(weekStartUtcTimestamp + 7 * ONE_DAY_MS),
  };
};

export const getRecapWeekKey = (weekStart: Date): string => {
  const localTimestamp = weekStart.getTime() + RECAP_TIMEZONE_OFFSET_MS;
  const localDate = new Date(localTimestamp);

  return [
    localDate.getUTCFullYear(),
    String(localDate.getUTCMonth() + 1).padStart(2, '0'),
    String(localDate.getUTCDate()).padStart(2, '0'),
  ].join('-');
};

export const getRecapWeekIdentity = (weekStart: Date): RecapWeekIdentity => {
  const weekKey = getRecapWeekKey(weekStart);
  const localMonday = new Date(weekStart.getTime() + RECAP_TIMEZONE_OFFSET_MS);

  const mondayUtc = Date.UTC(
    localMonday.getUTCFullYear(),
    localMonday.getUTCMonth(),
    localMonday.getUTCDate(),
  );

  const thursdayUtc = mondayUtc + 3 * ONE_DAY_MS;
  const year = new Date(thursdayUtc).getUTCFullYear();

  const jan4Utc = Date.UTC(year, 0, 4);
  const jan4Day = new Date(jan4Utc).getUTCDay();
  const jan4DaysFromMonday = jan4Day === 0 ? 6 : jan4Day - 1;
  const firstWeekStartUtc = jan4Utc - jan4DaysFromMonday * ONE_DAY_MS;

  return {
    year,
    weekNumber:
      Math.floor((mondayUtc - firstWeekStartUtc) / (7 * ONE_DAY_MS)) + 1,
    weekKey,
  };
};
