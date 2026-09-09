"use client";

import { type CSSProperties, useState } from "react";

const PLANS = ["Basic", "Pro", "Max"] as const;
const TARGET_PLAN = "Pro";
const PLAN_PRICES: Record<Plan, string> = { Basic: "$9", Pro: "$29", Max: "$99" };

type Plan = (typeof PLANS)[number];

/**
 * Deliberately hostile accessibility: the entire flow is wrapped in a single
 * `aria-hidden="true"` container, so the accessibility tree for this screen
 * is completely empty - snapshots based on it see nothing at all. Every
 * element is a bare div with no role, label, or test id, yet everything stays
 * fully visible and clickable. The agent must read the on-screen instructions
 * and operate from vision and raw coordinates.
 */
export default function AriaHiddenFlow() {
  const [step, setStep] = useState<"pick" | "confirm" | "done">("pick");
  const [error, setError] = useState<string | null>(null);

  /**
   * Advances to the confirm step only for the target plan; any other card
   * shows a recoverable error and keeps the picker on screen.
   */
  const handlePick = (plan: Plan) => {
    if (plan !== TARGET_PLAN) {
      setError(`That is not the ${TARGET_PLAN} plan`);
      return;
    }
    setError(null);
    setStep("confirm");
  };

  return (
    <div aria-hidden="true" style={styles.container}>
      {step === "pick" ? (
        <>
          <div style={styles.hint}>Choose the {TARGET_PLAN} plan</div>
          <div style={styles.cardRow}>
            {PLANS.map((plan) => (
              <div key={plan} style={styles.card} onClick={() => handlePick(plan)}>
                <div style={styles.cardTitle}>{plan}</div>
                <div style={styles.cardPrice}>{PLAN_PRICES[plan]}/mo</div>
              </div>
            ))}
          </div>
          {error ? <div style={styles.errorText}>{error}</div> : null}
        </>
      ) : null}
      {step === "confirm" ? (
        <>
          <div style={styles.hint}>Confirm your selection</div>
          <div style={styles.summary}>{TARGET_PLAN} plan - $29/mo</div>
          <div style={styles.button} onClick={() => setStep("done")}>
            Confirm {TARGET_PLAN} plan
          </div>
        </>
      ) : null}
      {step === "done" ? <div style={styles.successText}>Plan activated</div> : null}
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
  },
  cardRow: {
    display: "flex",
    gap: 12,
  },
  card: {
    flex: 1,
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: 16,
    textAlign: "center",
    cursor: "default",
    userSelect: "none",
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: 600,
  },
  cardPrice: {
    fontSize: 13,
    color: "#666",
    marginTop: 4,
  },
  summary: {
    fontSize: 16,
    textAlign: "center",
  },
  button: {
    backgroundColor: "#111",
    color: "#fff",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 16,
    fontWeight: 600,
    textAlign: "center",
    cursor: "default",
    userSelect: "none",
  },
  errorText: {
    color: "#c00",
    fontSize: 14,
    textAlign: "center",
  },
  successText: {
    fontSize: 20,
    fontWeight: 600,
    color: "#0a0",
    textAlign: "center",
  },
} satisfies Record<string, CSSProperties>;
