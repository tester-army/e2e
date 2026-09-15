import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { presentPaymentSheet } from "../../modules/apple-pay-lab";

type PaymentState = "idle" | "presenting" | "dismissed" | "authorized" | "error";

/**
 * Apple Pay drill: the agent must start the payment and authorize it inside
 * the PassKit sheet, which renders out-of-process and is invisible to the
 * app's own accessibility tree. Dismissing the sheet without paying surfaces
 * a retryable canceled state.
 */
export default function ApplePay() {
  const [state, setState] = useState<PaymentState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  /**
   * Presents the PassKit payment sheet and records the outcome.
   */
  const handlePay = async () => {
    setState("presenting");
    setErrorMessage(null);
    try {
      const result = await presentPaymentSheet();
      setState(result.status);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setState("error");
    }
  };

  if (state === "authorized") {
    return (
      <View style={styles.center}>
        <Text testID="success-message" style={styles.successText}>
          Payment complete: $8.99
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.center}>
      <Text style={styles.title}>Order summary</Text>
      <View style={styles.summary}>
        <Text style={styles.summaryLine}>Trail Mix 500 g — $6.99</Text>
        <Text style={styles.summaryLine}>Rush delivery — $2.00</Text>
        <Text style={styles.summaryTotal}>Total — $8.99</Text>
      </View>
      {state === "dismissed" && (
        <Text testID="payment-canceled" style={styles.warning}>
          Payment canceled — the order was not placed
        </Text>
      )}
      {state === "error" && errorMessage && (
        <Text testID="payment-error" style={styles.warning}>
          {errorMessage}
        </Text>
      )}
      <TouchableOpacity
        testID="apple-pay-button"
        accessibilityLabel="Buy with Apple Pay"
        style={styles.payButton}
        disabled={state === "presenting"}
        onPress={handlePay}
      >
        <Text style={styles.payButtonText}>
          {state === "presenting" ? "Waiting for Apple Pay…" : " Pay"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
  },
  summary: {
    alignSelf: "stretch",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#d0d0d0",
    borderRadius: 8,
    padding: 16,
    gap: 6,
  },
  summaryLine: {
    fontSize: 15,
    color: "#333",
  },
  summaryTotal: {
    fontSize: 16,
    fontWeight: "600",
    marginTop: 4,
  },
  warning: {
    color: "#b00020",
    fontSize: 14,
    textAlign: "center",
  },
  payButton: {
    backgroundColor: "#000",
    borderRadius: 8,
    paddingVertical: 14,
    alignSelf: "stretch",
    alignItems: "center",
  },
  payButtonText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "600",
  },
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
  },
});
