"use client";

import { type CSSProperties, useState } from "react";

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

const CALENDAR_START = { year: 2026, month: 5 };
const TARGET_BIRTH = { year: 1990, month: 2, day: 14 };

const COUNTRIES = [
  "Austria",
  "Czechia",
  "Germany",
  "Poland",
  "Portugal",
  "Slovakia",
  "Spain",
  "Sweden",
];

const OCCUPATIONS = [
  "Accountant",
  "Data analyst",
  "Product designer",
  "Software engineer",
  "Teacher",
  "Nurse",
];

const PLANS = ["Solo", "Studio", "Enterprise"];

const BRIEF_LINES = [
  "Full name: Maria Novak",
  "Email: maria.novak@example.com",
  "Phone: +48 601 222 333",
  "Street: Krucza 12",
  "City: Warsaw",
  "Postal code: 00-585",
  "Country: Poland",
  "Birth date: March 14, 1990",
  "Occupation: Product designer",
  "Experience: 7 years",
  "Notifications: turn on Product updates and Weekly digest, turn off SMS alerts, leave Beta features off",
  "Plan: Studio",
  "Support PIN: 8412",
];

type SelectedDate = { year: number; month: number; day: number };

type Preferences = {
  updates: boolean;
  sms: boolean;
  digest: boolean;
  beta: boolean;
};

const PREFERENCE_ROWS: { key: keyof Preferences; label: string }[] = [
  { key: "updates", label: "Product updates" },
  { key: "sms", label: "SMS alerts" },
  { key: "digest", label: "Weekly digest" },
  { key: "beta", label: "Beta features" },
];

const TARGET_PREFERENCES: Preferences = { updates: true, sms: false, digest: true, beta: false };

/**
 * ADVERSARIAL: a five-step onboarding wizard that gates long-horizon
 * reasoning and very long form filling with deliberately poor accessibility.
 * The full data brief - including a support PIN required on the last step -
 * is only visible on step 1, so the agent must retain it (or navigate Back to
 * reread; entered values survive navigation). Inputs have no labels,
 * placeholders, or aria wiring; dropdowns, steppers, toggles, the date
 * picker, and every button are bare divs with no roles. The date picker
 * starts at June 2026 and must be steered to March 1990 with decade, year,
 * and month arrows. One toggle starts wrong and one is a trap that must stay
 * off. Success is visible only as on-screen text.
 */
export default function OnboardingWizard() {
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [postal, setPostal] = useState("");
  const [country, setCountry] = useState<string | null>(null);
  const [countryOpen, setCountryOpen] = useState(false);

  const [calendarYear, setCalendarYear] = useState(CALENDAR_START.year);
  const [calendarMonth, setCalendarMonth] = useState(CALENDAR_START.month);
  const [birth, setBirth] = useState<SelectedDate | null>(null);
  const [occupation, setOccupation] = useState<string | null>(null);
  const [occupationOpen, setOccupationOpen] = useState(false);
  const [experience, setExperience] = useState(0);

  const [preferences, setPreferences] = useState<Preferences>({
    updates: false,
    sms: true,
    digest: false,
    beta: false,
  });
  const [plan, setPlan] = useState<string | null>(null);

  const [pin, setPin] = useState("");
  const [consent, setConsent] = useState(false);

  /**
   * Validates the current step against the brief and either surfaces the
   * first mismatch or advances the wizard (finishing on the review step).
   */
  const handleNext = () => {
    const mismatch = validateStep();
    if (mismatch) {
      setError(mismatch);
      return;
    }
    setError(null);
    if (step === 5) {
      setDone(true);
      return;
    }
    setStep(step + 1);
  };

  /**
   * Returns the first field on the current step that does not match the
   * brief, or null when the step is complete.
   */
  const validateStep = (): string | null => {
    if (step === 1) {
      if (collapse(fullName) !== "Maria Novak") {
        return "Full name does not match the brief";
      }
      if (email.trim().toLowerCase() !== "maria.novak@example.com") {
        return "Email does not match the brief";
      }
      if (stripSpaces(phone) !== "+48601222333") {
        return "Phone does not match the brief";
      }
      return null;
    }
    if (step === 2) {
      if (collapse(street) !== "Krucza 12") {
        return "Street does not match the brief";
      }
      if (collapse(city) !== "Warsaw") {
        return "City does not match the brief";
      }
      if (stripSpaces(postal) !== "00-585") {
        return "Postal code does not match the brief";
      }
      if (country !== "Poland") {
        return "Country does not match the brief";
      }
      return null;
    }
    if (step === 3) {
      if (
        !birth ||
        birth.year !== TARGET_BIRTH.year ||
        birth.month !== TARGET_BIRTH.month ||
        birth.day !== TARGET_BIRTH.day
      ) {
        return "Birth date does not match the brief";
      }
      if (occupation !== "Product designer") {
        return "Occupation does not match the brief";
      }
      if (experience !== 7) {
        return "Experience does not match the brief";
      }
      return null;
    }
    if (step === 4) {
      const matches = PREFERENCE_ROWS.every(
        ({ key }) => preferences[key] === TARGET_PREFERENCES[key],
      );
      if (!matches) {
        return "Notification toggles do not match the brief";
      }
      if (plan !== "Studio") {
        return "Plan does not match the brief";
      }
      return null;
    }
    if (pin.trim() !== "8412") {
      return "Support PIN is wrong";
    }
    if (!consent) {
      return "Confirm the details first";
    }
    return null;
  };

  /**
   * Moves the calendar by the given number of months, clamping day selection
   * to the visible month only when a day is clicked.
   */
  const shiftCalendar = (months: number, years: number) => {
    const total = calendarYear * 12 + calendarMonth + months + years * 12;
    setCalendarYear(Math.floor(total / 12));
    setCalendarMonth(((total % 12) + 12) % 12);
  };

  if (done) {
    return (
      <div style={styles.container}>
        <p style={styles.successText}>Onboarding complete</p>
        <p style={styles.successSubline}>Welcome aboard, Maria Novak</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <p style={styles.hint}>
        Complete every wizard step exactly as the brief on step 1 says. The brief is only visible on
        step 1; Back preserves what you typed.
      </p>
      <div style={styles.wizard}>
        <div style={styles.progress}>Step {step} of 5</div>
        {step === 1 ? (
          <>
            <div style={styles.brief}>
              <div style={styles.briefTitle}>Onboarding brief - memorize before continuing</div>
              {BRIEF_LINES.map((line) => (
                <div key={line} style={styles.briefLine}>
                  {line}
                </div>
              ))}
            </div>
            <div style={styles.sectionTitle}>Account</div>
            <div style={styles.fieldLabel}>Full name</div>
            <input
              style={styles.input}
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
            />
            <div style={styles.fieldLabel}>Email</div>
            <input
              style={styles.input}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <div style={styles.fieldLabel}>Phone</div>
            <input
              style={styles.input}
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          </>
        ) : null}
        {step === 2 ? (
          <>
            <div style={styles.sectionTitle}>Address</div>
            <div style={styles.fieldLabel}>Street</div>
            <input
              style={styles.input}
              value={street}
              onChange={(event) => setStreet(event.target.value)}
            />
            <div style={styles.fieldLabel}>City</div>
            <input
              style={styles.input}
              value={city}
              onChange={(event) => setCity(event.target.value)}
            />
            <div style={styles.fieldLabel}>Postal code</div>
            <input
              style={styles.input}
              value={postal}
              onChange={(event) => setPostal(event.target.value)}
            />
            <div style={styles.fieldLabel}>Country</div>
            <div
              style={styles.dropdown}
              onClick={() => {
                setCountryOpen(!countryOpen);
              }}
            >
              {country ?? "Choose"}
            </div>
            {countryOpen ? (
              <div style={styles.dropdownList}>
                {COUNTRIES.map((name) => (
                  <div
                    key={name}
                    style={styles.dropdownOption}
                    onClick={() => {
                      setCountry(name);
                      setCountryOpen(false);
                    }}
                  >
                    {name}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
        {step === 3 ? (
          <>
            <div style={styles.sectionTitle}>Profile</div>
            <div style={styles.fieldLabel}>Birth date</div>
            <div style={styles.calendar}>
              <div style={styles.calendarHeader}>
                <div style={styles.calendarArrow} onClick={() => shiftCalendar(0, -10)}>
                  «
                </div>
                <div style={styles.calendarArrow} onClick={() => shiftCalendar(0, -1)}>
                  ‹
                </div>
                <div style={styles.calendarTitle}>
                  {MONTH_NAMES[calendarMonth]} {calendarYear}
                </div>
                <div style={styles.calendarArrow} onClick={() => shiftCalendar(0, 1)}>
                  ›
                </div>
                <div style={styles.calendarArrow} onClick={() => shiftCalendar(0, 10)}>
                  »
                </div>
              </div>
              <div style={styles.calendarMonthRow}>
                <div style={styles.calendarArrow} onClick={() => shiftCalendar(-1, 0)}>
                  ‹ month
                </div>
                <div style={styles.calendarArrow} onClick={() => shiftCalendar(1, 0)}>
                  month ›
                </div>
              </div>
              <div style={styles.calendarGrid}>
                {buildCalendarCells(calendarYear, calendarMonth).map((day, cellIndex) => {
                  if (day === null) {
                    return <div key={`blank-${cellIndex}`} />;
                  }
                  const selected =
                    birth !== null &&
                    birth.year === calendarYear &&
                    birth.month === calendarMonth &&
                    birth.day === day;
                  return (
                    <div
                      key={`day-${day}`}
                      style={selected ? styles.calendarDaySelected : styles.calendarDay}
                      onClick={() => setBirth({ year: calendarYear, month: calendarMonth, day })}
                    >
                      {day}
                    </div>
                  );
                })}
              </div>
              <div style={styles.calendarValue}>
                {birth
                  ? `Selected: ${MONTH_NAMES[birth.month]} ${birth.day}, ${birth.year}`
                  : "Nothing selected"}
              </div>
            </div>
            <div style={styles.fieldLabel}>Occupation</div>
            <div
              style={styles.dropdown}
              onClick={() => {
                setOccupationOpen(!occupationOpen);
              }}
            >
              {occupation ?? "Choose"}
            </div>
            {occupationOpen ? (
              <div style={styles.dropdownList}>
                {OCCUPATIONS.map((name) => (
                  <div
                    key={name}
                    style={styles.dropdownOption}
                    onClick={() => {
                      setOccupation(name);
                      setOccupationOpen(false);
                    }}
                  >
                    {name}
                  </div>
                ))}
              </div>
            ) : null}
            <div style={styles.fieldLabel}>Years of experience</div>
            <div style={styles.stepper}>
              <div
                style={styles.stepperButton}
                onClick={() => setExperience(Math.max(0, experience - 1))}
              >
                -
              </div>
              <div style={styles.stepperValue}>{experience}</div>
              <div style={styles.stepperButton} onClick={() => setExperience(experience + 1)}>
                +
              </div>
            </div>
          </>
        ) : null}
        {step === 4 ? (
          <>
            <div style={styles.sectionTitle}>Preferences</div>
            {PREFERENCE_ROWS.map(({ key, label }) => (
              <div key={key} style={styles.toggleRow}>
                <div style={styles.toggleLabel}>{label}</div>
                <div
                  style={preferences[key] ? styles.toggleOn : styles.toggleOff}
                  onClick={() => setPreferences({ ...preferences, [key]: !preferences[key] })}
                >
                  {preferences[key] ? "On" : "Off"}
                </div>
              </div>
            ))}
            <div style={styles.fieldLabel}>Plan</div>
            <div style={styles.planRow}>
              {PLANS.map((name) => (
                <div
                  key={name}
                  style={plan === name ? styles.planCardSelected : styles.planCard}
                  onClick={() => setPlan(name)}
                >
                  {name}
                </div>
              ))}
            </div>
          </>
        ) : null}
        {step === 5 ? (
          <>
            <div style={styles.sectionTitle}>Review</div>
            <div style={styles.summary}>
              <div style={styles.summaryLine}>{`${fullName} · ${email} · ${phone}`}</div>
              <div style={styles.summaryLine}>
                {`${street}, ${postal} ${city}, ${country ?? "?"}`}
              </div>
              <div style={styles.summaryLine}>
                {birth
                  ? `Born ${MONTH_NAMES[birth.month]} ${birth.day}, ${birth.year} · ${occupation ?? "?"} · ${experience} years`
                  : "No birth date"}
              </div>
              <div style={styles.summaryLine}>{`Plan: ${plan ?? "?"}`}</div>
            </div>
            <div style={styles.fieldLabel}>Support PIN from the brief</div>
            <input
              style={styles.input}
              value={pin}
              onChange={(event) => setPin(event.target.value)}
            />
            <div style={styles.toggleRow}>
              <div style={styles.toggleLabel}>I confirm the details are correct</div>
              <div
                style={consent ? styles.toggleOn : styles.toggleOff}
                onClick={() => setConsent(!consent)}
              >
                {consent ? "On" : "Off"}
              </div>
            </div>
          </>
        ) : null}
        {error ? <p style={styles.errorText}>{error}</p> : null}
        <div style={styles.navRow}>
          {step > 1 ? (
            <div
              style={styles.backButton}
              onClick={() => {
                setError(null);
                setStep(step - 1);
              }}
            >
              Back
            </div>
          ) : null}
          <div style={styles.nextButton} onClick={handleNext}>
            {step === 5 ? "Finish" : "Next"}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Builds the day cells for a month: leading nulls for blank cells (weeks
 * start on Monday) followed by the day numbers.
 */
function buildCalendarCells(year: number, month: number): (number | null)[] {
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
  const dayCount = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let blank = 0; blank < firstWeekday; blank += 1) {
    cells.push(null);
  }
  for (let day = 1; day <= dayCount; day += 1) {
    cells.push(day);
  }
  return cells;
}

/**
 * Collapses runs of whitespace and trims, so spacing typos do not fail the
 * exact-match validation.
 */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Removes all whitespace for fields where grouping spaces are cosmetic.
 */
function stripSpaces(value: string): string {
  return value.replace(/\s+/g, "");
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
  wizard: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: 16,
  },
  progress: {
    fontSize: 13,
    fontWeight: 700,
    color: "#666",
  },
  brief: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    border: "1px solid #e0d5a8",
    borderRadius: 8,
    padding: 12,
    backgroundColor: "#fdf8e3",
  },
  briefTitle: {
    fontSize: 13,
    fontWeight: 700,
  },
  briefLine: {
    fontSize: 13,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 700,
  },
  fieldLabel: {
    fontSize: 13,
    color: "#444",
  },
  input: {
    border: "1px solid #ccc",
    borderRadius: 6,
    padding: "8px 10px",
    fontSize: 14,
  },
  dropdown: {
    border: "1px solid #ccc",
    borderRadius: 6,
    padding: "8px 10px",
    fontSize: 14,
    cursor: "pointer",
    userSelect: "none",
    backgroundColor: "#fff",
  },
  dropdownList: {
    border: "1px solid #ccc",
    borderRadius: 6,
    overflow: "hidden",
  },
  dropdownOption: {
    padding: "8px 10px",
    fontSize: 14,
    cursor: "pointer",
    userSelect: "none",
    borderBottom: "1px solid #eee",
  },
  calendar: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: 12,
  },
  calendarHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  calendarMonthRow: {
    display: "flex",
    justifyContent: "center",
    gap: 8,
  },
  calendarArrow: {
    border: "1px solid #ccc",
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 13,
    cursor: "pointer",
    userSelect: "none",
  },
  calendarTitle: {
    fontSize: 14,
    fontWeight: 700,
    minWidth: 140,
    textAlign: "center",
  },
  calendarGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(7, 1fr)",
    gap: 4,
  },
  calendarDay: {
    textAlign: "center",
    padding: "6px 0",
    fontSize: 13,
    borderRadius: 6,
    cursor: "pointer",
    userSelect: "none",
    backgroundColor: "#f4f4f4",
  },
  calendarDaySelected: {
    textAlign: "center",
    padding: "6px 0",
    fontSize: 13,
    borderRadius: 6,
    cursor: "pointer",
    userSelect: "none",
    backgroundColor: "#2563eb",
    color: "#fff",
  },
  calendarValue: {
    fontSize: 13,
    color: "#444",
    textAlign: "center",
  },
  stepper: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  stepperButton: {
    border: "1px solid #ccc",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
    userSelect: "none",
  },
  stepperValue: {
    fontSize: 16,
    fontWeight: 700,
    minWidth: 24,
    textAlign: "center",
  },
  toggleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  toggleLabel: {
    fontSize: 14,
  },
  toggleOn: {
    border: "1px solid #2563eb",
    borderRadius: 999,
    padding: "4px 14px",
    fontSize: 13,
    fontWeight: 700,
    color: "#fff",
    backgroundColor: "#2563eb",
    cursor: "pointer",
    userSelect: "none",
  },
  toggleOff: {
    border: "1px solid #ccc",
    borderRadius: 999,
    padding: "4px 14px",
    fontSize: 13,
    fontWeight: 700,
    color: "#666",
    backgroundColor: "#f4f4f4",
    cursor: "pointer",
    userSelect: "none",
  },
  planRow: {
    display: "flex",
    gap: 10,
  },
  planCard: {
    flex: 1,
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: "14px 0",
    fontSize: 14,
    fontWeight: 700,
    textAlign: "center",
    cursor: "pointer",
    userSelect: "none",
  },
  planCardSelected: {
    flex: 1,
    border: "2px solid #2563eb",
    borderRadius: 8,
    padding: "14px 0",
    fontSize: 14,
    fontWeight: 700,
    textAlign: "center",
    cursor: "pointer",
    userSelect: "none",
    backgroundColor: "#eff4ff",
  },
  summary: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    border: "1px solid #eee",
    borderRadius: 8,
    padding: 12,
    backgroundColor: "#fafafa",
  },
  summaryLine: {
    fontSize: 13,
  },
  errorText: {
    color: "#c00",
    fontSize: 14,
    margin: 0,
  },
  navRow: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
  },
  backButton: {
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: "10px 20px",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    userSelect: "none",
  },
  nextButton: {
    border: "1px solid #333",
    borderRadius: 8,
    padding: "10px 20px",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    userSelect: "none",
    backgroundColor: "#111",
    color: "#fff",
  },
  successText: {
    fontSize: 20,
    fontWeight: 600,
    color: "#0a0",
    textAlign: "center",
    margin: 0,
  },
  successSubline: {
    fontSize: 14,
    color: "#444",
    textAlign: "center",
    margin: 0,
  },
} satisfies Record<string, CSSProperties>;
