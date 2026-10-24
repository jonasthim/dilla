package announcements

import (
	"testing"
	"time"
)

func TestNextOccurrenceUsesDefaultTimezoneAndDailyRecurrence(t *testing.T) {
	schedule := Schedule{Kind: Daily, Hour: 9, Minute: 30, Revision: 7}
	after := time.Date(2026, time.January, 12, 8, 0, 0, 0, time.UTC)
	got, err := NextOccurrence(schedule, after)
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, time.January, 12, 8, 30, 0, 0, time.UTC) // 09:30 Stockholm
	if !got.At.Equal(want) || got.LocalDate != "2026-01-12" || got.Revision != 7 || got.Key == "" {
		t.Fatalf("NextOccurrence() = %+v, want at %s, local date 2026-01-12, revision 7 and stable key", got, want)
	}
	again, err := NextOccurrence(schedule, after)
	if err != nil || again.Key != got.Key {
		t.Fatalf("occurrence key was not stable: first=%q second=%q err=%v", got.Key, again.Key, err)
	}
}

func TestNextOccurrenceOneOffAndWeekly(t *testing.T) {
	oneOff := Schedule{Kind: OneOff, Timezone: "UTC", Date: "2026-04-03", Hour: 12, Minute: 5}
	got, err := NextOccurrence(oneOff, time.Date(2026, time.April, 3, 12, 4, 0, 0, time.UTC))
	if err != nil || !got.At.Equal(time.Date(2026, time.April, 3, 12, 5, 0, 0, time.UTC)) {
		t.Fatalf("one-off next occurrence = %+v, %v", got, err)
	}
	weekly := Schedule{Kind: Weekly, Timezone: "UTC", Weekday: time.Monday, Hour: 10, Minute: 0}
	got, err = NextOccurrence(weekly, time.Date(2026, time.April, 3, 9, 0, 0, 0, time.UTC))
	if err != nil || got.LocalDate != "2026-04-06" {
		t.Fatalf("weekly next occurrence = %+v, %v; want Monday 2026-04-06", got, err)
	}
}

func TestNextOccurrenceMovesSpringGapToNextValidLocalMinute(t *testing.T) {
	schedule := Schedule{Kind: Daily, Timezone: "Europe/Stockholm", Hour: 2, Minute: 30}
	after := time.Date(2026, time.March, 29, 0, 0, 0, 0, time.UTC)
	got, err := NextOccurrence(schedule, after)
	want := time.Date(2026, time.March, 29, 1, 0, 0, 0, time.UTC) // 03:00 CEST
	if err != nil || !got.At.Equal(want) {
		t.Fatalf("spring-gap occurrence = %+v, %v; want %s", got, err, want)
	}
}

func TestNextOccurrenceChoosesFirstFallFoldInstant(t *testing.T) {
	schedule := Schedule{Kind: Daily, Timezone: "Europe/Stockholm", Hour: 2, Minute: 30}
	after := time.Date(2026, time.October, 24, 23, 0, 0, 0, time.UTC)
	got, err := NextOccurrence(schedule, after)
	want := time.Date(2026, time.October, 25, 0, 30, 0, 0, time.UTC) // first 02:30 CEST
	if err != nil || !got.At.Equal(want) {
		t.Fatalf("fall-fold occurrence = %+v, %v; want first instant %s", got, err, want)
	}
}

func TestMissedOccurrencePolicySendsThroughFifteenMinutesThenSkips(t *testing.T) {
	due := time.Date(2026, time.January, 1, 9, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name string
		now  time.Time
		want MissedDecision
	}{{"on time", due, SendOccurrence}, {"at cutoff", due.Add(15 * time.Minute), SendOccurrence}, {"past cutoff", due.Add(15*time.Minute + time.Second), SkipOccurrence}, {"not due", due.Add(-time.Second), WaitOccurrence}} {
		t.Run(tc.name, func(t *testing.T) {
			if got := DecideMissed(due, tc.now); got != tc.want {
				t.Fatalf("DecideMissed() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestScheduleValidationRejectsInvalidZoneAndFields(t *testing.T) {
	cases := []Schedule{
		{Kind: Daily, Timezone: "Mars/Olympus", Hour: 9},
		{Kind: Daily, Timezone: "Local", Hour: 9},
		{Kind: Daily, Timezone: "UTC", Hour: 24},
		{Kind: Weekly, Timezone: "UTC", Weekday: time.Sunday, Hour: 9, Minute: 60},
		{Kind: OneOff, Timezone: "UTC", Date: "2026-02-30", Hour: 9},
		{Kind: ScheduleKind("monthly"), Timezone: "UTC", Hour: 9},
	}
	for i, schedule := range cases {
		if _, err := NextOccurrence(schedule, time.Now().UTC()); err == nil {
			t.Errorf("case %d accepted invalid schedule %+v", i, schedule)
		}
	}
}

func TestNextOccurrenceRejectsDatesBeyondBoundedSearch(t *testing.T) {
	schedule := Schedule{Kind: OneOff, Timezone: "UTC", Date: "9999-12-31", Hour: 23, Minute: 59}
	if _, err := NextOccurrence(schedule, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)); err == nil {
		t.Fatal("NextOccurrence accepted a date outside its bounded search horizon")
	}
}
