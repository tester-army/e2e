"use client";

import { type CSSProperties, useState } from "react";

const INITIAL_MONTH = new Date(2026, 5, 1);
const REQUIRED_DATE = new Date(2026, 8, 17);
const REQUIRED_DATE_LABEL = "September 17, 2026";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/**
 * Returns the first day of the month `offset` months away from `month`,
 * relying on Date's own overflow arithmetic to roll years.
 */
function addMonths(month: Date, offset: number): Date {
  return new Date(month.getFullYear(), month.getMonth() + offset, 1);
}

/**
 * Returns the number of days in the given month by asking Date for day 0 of
 * the following month.
 */
function daysInMonth(month: Date): number {
  return new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
}

/**
 * Returns the Monday-first column offset (0-6) of the month's first day, so
 * the day grid can pad leading blanks correctly.
 */
function firstWeekdayOffset(month: Date): number {
  return (new Date(month.getFullYear(), month.getMonth(), 1).getDay() + 6) % 7;
}

/**
 * Formats a date as YYYY-MM-DD without any timezone conversion.
 */
function formatIsoDate(date: Date): string {
  const monthPart = String(date.getMonth() + 1).padStart(2, "0");
  const dayPart = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${monthPart}-${dayPart}`;
}

export default function DatePicker() {
  const [displayedMonth, setDisplayedMonth] = useState(INITIAL_MONTH);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [popupOpen, setPopupOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState(false);

  const handleSelectDay = (day: number) => {
    setSelectedDate(new Date(displayedMonth.getFullYear(), displayedMonth.getMonth(), day));
    setError(null);
    setPopupOpen(false);
  };

  /**
   * Confirms the booking only when the selected date matches REQUIRED_DATE
   * exactly; any other selection (or none) shows a recoverable error.
   */
  const handleConfirm = () => {
    if (selectedDate && formatIsoDate(selectedDate) === formatIsoDate(REQUIRED_DATE)) {
      setError(null);
      setBooked(true);
    } else {
      setError("Pick the exact requested date");
    }
  };

  if (booked) {
    return (
      <div style={styles.container}>
        <p data-testid="success-message" style={styles.successText}>
          Appointment booked for {REQUIRED_DATE_LABEL}
        </p>
      </div>
    );
  }

  const leadingBlanks = firstWeekdayOffset(displayedMonth);
  const totalDays = daysInMonth(displayedMonth);

  return (
    <div style={styles.container}>
      <p style={styles.hint}>Book an appointment for {REQUIRED_DATE_LABEL}.</p>
      <div style={styles.pickerAnchor}>
        <input
          data-testid="date-input"
          style={styles.dateInput}
          placeholder="Select date"
          readOnly
          value={selectedDate ? formatIsoDate(selectedDate) : ""}
          onClick={() => setPopupOpen((open) => !open)}
        />
        {popupOpen ? (
          <div style={styles.popup}>
            <div style={styles.popupHeader}>
              <button
                type="button"
                data-testid="prev-month-button"
                style={styles.navButton}
                onClick={() => setDisplayedMonth((month) => addMonths(month, -1))}
              >
                ‹
              </button>
              <span data-testid="month-label" style={styles.monthLabel}>
                {MONTH_NAMES[displayedMonth.getMonth()]} {displayedMonth.getFullYear()}
              </span>
              <button
                type="button"
                data-testid="next-month-button"
                style={styles.navButton}
                onClick={() => setDisplayedMonth((month) => addMonths(month, 1))}
              >
                ›
              </button>
            </div>
            <div style={styles.dayGrid}>
              {WEEKDAYS.map((weekday) => (
                <span key={weekday} style={styles.weekdayCell}>
                  {weekday}
                </span>
              ))}
              {Array.from({ length: leadingBlanks }, (_, index) => (
                <span key={`blank-${index}`} />
              ))}
              {Array.from({ length: totalDays }, (_, index) => (
                <button
                  key={index + 1}
                  type="button"
                  data-testid={`day-button-${index + 1}`}
                  style={styles.dayButton}
                  onClick={() => handleSelectDay(index + 1)}
                >
                  {index + 1}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {error ? (
        <p data-testid="error-message" style={styles.errorText}>
          {error}
        </p>
      ) : null}
      <button
        type="button"
        data-testid="confirm-button"
        style={styles.button}
        onClick={handleConfirm}
      >
        Confirm booking
      </button>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: "24px 0",
  },
  hint: {
    fontSize: 13,
    color: "#666",
    textAlign: "center",
    margin: 0,
  },
  pickerAnchor: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
  },
  dateInput: {
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 16,
    cursor: "pointer",
    width: "100%",
    boxSizing: "border-box",
  },
  popup: {
    position: "absolute",
    top: "calc(100% + 4px)",
    left: 0,
    zIndex: 10,
    backgroundColor: "#fff",
    border: "1px solid #ccc",
    borderRadius: 8,
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.12)",
    padding: 12,
    width: 280,
  },
  popupHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  navButton: {
    backgroundColor: "#111",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "4px 12px",
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
  },
  monthLabel: {
    fontSize: 14,
    fontWeight: 600,
  },
  dayGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(7, 1fr)",
    gap: 2,
  },
  weekdayCell: {
    fontSize: 12,
    color: "#666",
    textAlign: "center",
    padding: "4px 0",
  },
  dayButton: {
    backgroundColor: "transparent",
    color: "#111",
    border: "none",
    borderRadius: 8,
    padding: "6px 0",
    fontSize: 14,
    cursor: "pointer",
  },
  button: {
    backgroundColor: "#111",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
  },
  errorText: {
    color: "#c00",
    fontSize: 14,
    margin: 0,
  },
  successText: {
    fontSize: 20,
    fontWeight: 600,
    color: "#0a0",
    textAlign: "center",
    margin: 0,
  },
} satisfies Record<string, CSSProperties>;
