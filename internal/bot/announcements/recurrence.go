// Package announcements contains bounded, deterministic announcement scheduling primitives.
// Persistence, delivery, and permission checks belong to callers.
package announcements

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	DefaultTimezone  = "Europe/Stockholm"
	maxSearchDays    = 366
	maxDayCandidates = 60 * 60
)

var (
	ErrNoOccurrence    = errors.New("no occurrence within bounded search horizon")
	ErrInvalidSchedule = errors.New("invalid announcement schedule")
)

type ScheduleKind string

const (
	OneOff ScheduleKind = "one_off"
	Daily  ScheduleKind = "daily"
	Weekly ScheduleKind = "weekly"
)

// Schedule describes a local wall-clock recurrence. Date is required for OneOff
// and uses YYYY-MM-DD. Timezone defaults to Europe/Stockholm when empty.
type Schedule struct {
	Kind     ScheduleKind
	Timezone string
	Date     string
	Hour     int
	Minute   int
	Weekday  time.Weekday
	Revision uint64
}

type Occurrence struct {
	At        time.Time
	LocalDate string
	Revision  uint64
	Key       string
}

type MissedDecision uint8

const (
	WaitOccurrence MissedDecision = iota
	SendOccurrence
	SkipOccurrence
)

// NextOccurrence returns the first scheduled instant strictly after afterUTC.
// Search is bounded to one year and each local date examines at most 60 hours
// of UTC minute candidates to resolve timezone gaps and folds deterministically.
func NextOccurrence(schedule Schedule, afterUTC time.Time) (Occurrence, error) {
	loc, err := scheduleLocation(schedule)
	if err != nil {
		return Occurrence{}, err
	}
	if err := validate(schedule); err != nil {
		return Occurrence{}, err
	}
	after := afterUTC.UTC()
	var startDate time.Time
	if schedule.Kind == OneOff {
		startDate, _ = time.ParseInLocation("2006-01-02", schedule.Date, loc)
		localAfter := after.In(loc)
		dayDistance := time.Date(startDate.Year(), startDate.Month(), startDate.Day(), 0, 0, 0, 0, time.UTC).Sub(time.Date(localAfter.Year(), localAfter.Month(), localAfter.Day(), 0, 0, 0, 0, time.UTC)) / (24 * time.Hour)
		if dayDistance > maxSearchDays-1 {
			return Occurrence{}, ErrNoOccurrence
		}
	} else {
		local := after.In(loc)
		startDate = time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
	}

	for day := 0; day < maxSearchDays; day++ {
		date := startDate.AddDate(0, 0, day)
		if schedule.Kind == OneOff && day > 0 {
			break
		}
		if schedule.Kind == Weekly && date.Weekday() != schedule.Weekday {
			continue
		}
		at, ok := occurrenceOnDate(date, schedule.Hour, schedule.Minute, loc)
		if ok && at.After(after) {
			localDate := date.Format("2006-01-02")
			return Occurrence{At: at, LocalDate: localDate, Revision: schedule.Revision, Key: occurrenceKey(schedule, localDate)}, nil
		}
	}
	return Occurrence{}, ErrNoOccurrence
}

// DecideMissed applies the send-once window to a due occurrence. A future
// occurrence waits; a due occurrence up to and including fifteen minutes late sends.
func DecideMissed(due, now time.Time) MissedDecision {
	if now.Before(due) {
		return WaitOccurrence
	}
	if now.Sub(due) <= 15*time.Minute {
		return SendOccurrence
	}
	return SkipOccurrence
}

func scheduleLocation(schedule Schedule) (*time.Location, error) {
	name := strings.TrimSpace(schedule.Timezone)
	if name == "" {
		name = DefaultTimezone
	}
	if len(name) > 128 {
		return nil, fmt.Errorf("%w: timezone name exceeds 128 bytes", ErrInvalidSchedule)
	}
	if name == "Local" {
		return nil, fmt.Errorf("%w: timezone %q depends on the host configuration", ErrInvalidSchedule, name)
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		return nil, fmt.Errorf("%w: timezone %q: %v", ErrInvalidSchedule, name, err)
	}
	return loc, nil
}

func validate(schedule Schedule) error {
	if schedule.Hour < 0 || schedule.Hour > 23 || schedule.Minute < 0 || schedule.Minute > 59 {
		return fmt.Errorf("%w: local hour or minute out of range", ErrInvalidSchedule)
	}
	switch schedule.Kind {
	case OneOff:
		if len(schedule.Date) != len("2006-01-02") {
			return fmt.Errorf("%w: date must be a real YYYY-MM-DD date", ErrInvalidSchedule)
		}
		parsed, err := time.Parse("2006-01-02", schedule.Date)
		if err != nil || parsed.Format("2006-01-02") != schedule.Date {
			return fmt.Errorf("%w: date must be a real YYYY-MM-DD date", ErrInvalidSchedule)
		}
	case Daily:
		if schedule.Date != "" || schedule.Weekday != 0 {
			return fmt.Errorf("%w: daily schedule has one-off or weekday fields", ErrInvalidSchedule)
		}
	case Weekly:
		if schedule.Weekday < time.Sunday || schedule.Weekday > time.Saturday || schedule.Date != "" {
			return fmt.Errorf("%w: weekly schedule needs a valid weekday only", ErrInvalidSchedule)
		}
	default:
		return fmt.Errorf("%w: unsupported kind %q", ErrInvalidSchedule, schedule.Kind)
	}
	return nil
}

func occurrenceOnDate(date time.Time, hour, minute int, loc *time.Location) (time.Time, bool) {
	want := hour*60 + minute
	// Use a broad fixed UTC window around local midnight. The scan is capped,
	// and ascending UTC order selects the first instant in a repeated wall time.
	start := time.Date(date.Year(), date.Month(), date.Day(), 0, 0, 0, 0, time.UTC).Add(-18 * time.Hour)
	for candidate := 0; candidate < maxDayCandidates; candidate++ {
		instant := start.Add(time.Duration(candidate) * time.Minute)
		local := instant.In(loc)
		if local.Year() != date.Year() || local.Month() != date.Month() || local.Day() != date.Day() {
			continue
		}
		wallMinute := local.Hour()*60 + local.Minute()
		if wallMinute >= want {
			return instant, true
		}
	}
	return time.Time{}, false
}

func occurrenceKey(schedule Schedule, localDate string) string {
	zone := strings.TrimSpace(schedule.Timezone)
	if zone == "" {
		zone = DefaultTimezone
	}
	identity := fmt.Sprintf("%s\x00%s\x00%s\x00%02d:%02d\x00%d\x00%d", schedule.Kind, zone, localDate, schedule.Hour, schedule.Minute, schedule.Weekday, schedule.Revision)
	digest := sha256.Sum256([]byte(identity))
	return hex.EncodeToString(digest[:])
}
