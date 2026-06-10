import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MEETING_DETECTION_TRANSIENT_MISS_GRACE_MS,
  hasSleepAssertionFrom,
  shouldHoldDuringTransientMiss,
} from './meetingDetectorService';

// Sample pmset -g assertions output with a Microsoft Teams call in progress.
// Format is taken from real macOS output.
const teamsInCall = `Assertion status system-wide:
   BackgroundTask                 0
   ApplePushServiceTask           0
   UserIsActive                   1
   PreventUserIdleDisplaySleep    1
   NetworkClientActive            0
Listed by owning process:
   pid 523(Microsoft Teams): [0x0009000512d5a2ba] 04:23:50 PreventUserIdleDisplaySleep named: "Microsoft Teams Call in progress"
   pid 102(coreaudiod): [0x0008000112345678] 00:15:10 PreventUserIdleSystemSleep named: "com.apple.audio.context"
No kernel assertions.`;

const teamsIdle = `Assertion status system-wide:
   PreventUserIdleDisplaySleep    0
Listed by owning process:
   pid 523(Microsoft Teams): [0x0000000000000001] 00:00:01 UserIsActive named: "com.microsoft.teams.activity"
No kernel assertions.`;

const webexInCall = `Assertion status system-wide:
   PreventUserIdleDisplaySleep    1
Listed by owning process:
   pid 7891(Webex): [0x0009000512aabbcc] 00:12:34 PreventUserIdleDisplaySleep named: "Webex is using the display"
   pid 102(coreaudiod): [0x0008000112345678] 00:12:34 PreventUserIdleSystemSleep named: "com.apple.audio.context"
No kernel assertions.`;

const webexInCallSystemSleepOnly = `Listed by owning process:
   pid 7891(Cisco Webex Meetings): [0x0009000512aabbcc] 00:12:34 PreventUserIdleSystemSleep named: "Cisco Webex Meetings(Mac)"
No kernel assertions.`;

const webexIdle = `Assertion status system-wide:
   PreventUserIdleDisplaySleep    0
Listed by owning process:
   pid 7891(Webex): [0x0000000000000001] 00:00:01 UserIsActive named: "com.cisco.webex.activity"
No kernel assertions.`;

describe('hasSleepAssertionFrom', () => {
  it('returns false for empty input', () => {
    assert.equal(hasSleepAssertionFrom('', /Microsoft Teams/), false);
  });

  it('detects a Teams call via display-sleep assertion', () => {
    assert.equal(hasSleepAssertionFrom(teamsInCall, /Microsoft Teams/), true);
  });

  it('returns false when Teams is idle (no sleep assertion)', () => {
    assert.equal(hasSleepAssertionFrom(teamsIdle, /Microsoft Teams/), false);
  });

  it('detects a Webex call via display-sleep assertion', () => {
    assert.equal(hasSleepAssertionFrom(webexInCall, /^Webex$|^Cisco Webex/i), true);
  });

  it('detects a Webex call via system-sleep assertion (legacy name)', () => {
    assert.equal(hasSleepAssertionFrom(webexInCallSystemSleepOnly, /^Webex$|^Cisco Webex/i), true);
  });

  it('returns false when Webex is idle', () => {
    assert.equal(hasSleepAssertionFrom(webexIdle, /^Webex$|^Cisco Webex/i), false);
  });

  it('does not leak an assertion from one process to another (coreaudiod has a sleep assertion but the Webex block does not)', () => {
    const isolatedInput = `Listed by owning process:
   pid 102(coreaudiod): [0x0008000112345678] 00:15:10 PreventUserIdleSystemSleep named: "com.apple.audio.context"
   pid 7891(Webex): [0x0000000000000001] 00:00:01 UserIsActive named: "com.cisco.webex.activity"`;
    assert.equal(hasSleepAssertionFrom(isolatedInput, /^Webex$/i), false);
  });

  it('matches against the pattern, not substrings of other process names', () => {
    // "Microsoft Teams Helper" should not match /^Microsoft Teams$/ when we want the strict app process
    const input = `Listed by owning process:
   pid 999(Microsoft Teams Helper): [0x0009] 00:01:00 PreventUserIdleDisplaySleep named: "helper"`;
    assert.equal(hasSleepAssertionFrom(input, /^Microsoft Teams$/), false);
    assert.equal(hasSleepAssertionFrom(input, /Microsoft Teams/), true);
  });

  it('rejects a Teams assertion name held by another process (defensive AND-check)', () => {
    // A hostile or coincidentally-named assertion owned by a non-Teams process
    // must not pass the strict Teams process-ownership check.
    const input = `Listed by owning process:
   pid 555(SomeOtherApp): [0x0009] 00:01:00 PreventUserIdleDisplaySleep named: "Microsoft Teams Call in progress"`;
    assert.equal(hasSleepAssertionFrom(input, /^Microsoft Teams$/), false);
    // But the raw-string check would match, which is why detectMacOS ANDs the two.
    assert.ok(input.includes('Microsoft Teams Call in progress'));
  });
});

describe('shouldHoldDuringTransientMiss', () => {
  it('holds Google Meet active during the transient miss grace window', () => {
    const missingSince = 1_000;
    const now = missingSince + MEETING_DETECTION_TRANSIENT_MISS_GRACE_MS - 1;

    assert.equal(shouldHoldDuringTransientMiss('Google Meet', missingSince, now), true);
  });

  it('lets Google Meet end after the transient miss grace window', () => {
    const missingSince = 1_000;
    const now = missingSince + MEETING_DETECTION_TRANSIENT_MISS_GRACE_MS;

    assert.equal(shouldHoldDuringTransientMiss('Google Meet', missingSince, now), false);
  });

  it('keeps non-window-title detectors on the normal end debounce', () => {
    assert.equal(shouldHoldDuringTransientMiss('Zoom', 1_000, 2_000), false);
    assert.equal(shouldHoldDuringTransientMiss('Microsoft Teams', 1_000, 2_000), false);
    assert.equal(shouldHoldDuringTransientMiss('Google Meet', null, 2_000), false);
  });
});
