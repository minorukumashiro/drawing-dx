const jh = require('japanese-holidays');

// 平日（月〜金・祝日を除く）かどうか
function isBusinessDay(date) {
  const day = date.getDay(); // 0=日 6=土
  if (day === 0 || day === 6) return false;
  if (jh.isHoliday(date)) return false;
  return true;
}

// 夜間時間帯かどうか（例: nightStartHour=20, nightEndHour=8 → 20時〜翌8時）
function isNightHour(date, cfg) {
  const h = date.getHours();
  const start = cfg.nightStartHour;
  const end = cfg.nightEndHour;
  if (start > end) return h >= start || h < end; // 日をまたぐ範囲
  return h >= start && h < end;
}

// 現在時刻において要求される巡回間隔（分）
// 平日日中: weekdayIntervalMinutes / 平日夜間: nightIntervalMinutes / 土日祝: weekendHolidayIntervalMinutes
function requiredIntervalMinutes(now, cfg) {
  if (!isBusinessDay(now)) return cfg.weekendHolidayIntervalMinutes;
  if (isNightHour(now, cfg)) return cfg.nightIntervalMinutes;
  return cfg.weekdayIntervalMinutes;
}

module.exports = { isBusinessDay, isNightHour, requiredIntervalMinutes };
