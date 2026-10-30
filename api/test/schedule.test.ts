import { describe, expect, it } from "vitest";
import { describeSchedule, nextRunAt, weekdayMask, weekdaysFromMask } from "../src/lib/schedule";

const at = (iso: string) => Date.parse(iso);

describe("runner schedules", () => {
  it("keeps the chosen local time across a daylight-saving change", () => {
    const weekly = { frequency: "weekly" as const, weekdays: [0], minute: 9 * 60, timezone: "America/Chicago" };
    // Sunday, November 1, 2026 is the repeated hour. The following Monday stays at 9:00 local.
    expect(new Date(nextRunAt(weekly, at("2026-11-01T12:00:00Z"))).toISOString()).toBe("2026-11-02T15:00:00.000Z");
    expect(new Date(nextRunAt(weekly, at("2026-03-08T12:00:00Z"))).toISOString()).toBe("2026-03-09T14:00:00.000Z");
  });

  it("runs once in a repeated hour and moves a missing time forward", () => {
    const daily = { frequency: "daily" as const, weekdays: [], minute: 1 * 60 + 30, timezone: "America/Chicago" };
    expect(new Date(nextRunAt(daily, at("2026-11-01T05:00:00Z"))).toISOString()).toBe("2026-11-01T06:30:00.000Z");
    expect(new Date(nextRunAt(daily, at("2026-03-08T06:00:00Z"))).toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("describes weekdays and round-trips their mask", () => {
    expect(describeSchedule({ frequency: "weekly", weekdays: [0, 1, 2, 3, 4], minute: 9 * 60, timezone: "UTC" })).toBe("Every weekday at 9:00 AM");
    expect(describeSchedule({ frequency: "daily", weekdays: [], minute: 15 * 60 + 5, timezone: "UTC" })).toBe("Every day at 3:05 PM");
    expect(weekdaysFromMask(weekdayMask([0, 6]))).toEqual([0, 6]);
  });
});
