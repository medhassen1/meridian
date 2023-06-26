/**
 * Service calendars: resolving which services run on which dates, and mapping
 * a query time onto the service days that could contain it.
 */

export { type CalendarCoverage, ServiceCalendar } from "./service-calendar.js";

export {
  type ServiceDayScan,
  DEFAULT_MAX_OVERHANG_DAYS,
  scanServiceDays,
  scanServiceDaysForWindow,
  timeOnScan,
  timeOnQueryDate,
  measureOverhangDays,
} from "./window.js";

export {
  type DateRun,
  type ServiceProfile,
  activeRuns,
  profileService,
  profileAllServices,
  blankDates,
  longestBlankRun,
  serviceCountByDate,
  describeWeekdays,
} from "./expander.js";
