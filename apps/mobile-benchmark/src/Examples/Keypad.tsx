import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

type KeypadButtonProps = {
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly testID: string;
  readonly onPress: () => void;
};

/**
 * Renders one native keypad button with the label the accessibility tree
 * exposes to the runner.
 */
function KeypadButton({ label, accessibilityLabel, testID, onPress }: KeypadButtonProps) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={styles.key}
      onPress={onPress}
    >
      <Text style={styles.keyText}>{label}</Text>
    </Pressable>
  );
}

/**
 * Appends a digit without converting the amount to a number, preserving the
 * exact value the user entered, including zeros after a decimal point.
 */
function appendDigit(amount: string, digit: string): string {
  return amount === "0" ? digit : `${amount}${digit}`;
}

/**
 * Appends one decimal point when the amount does not already contain one.
 */
function appendDecimal(amount: string): string {
  return amount.includes(".") ? amount : `${amount}.`;
}

/**
 * Removes the final character and keeps an empty amount represented as zero.
 */
function deleteLastDigit(amount: string): string {
  if (amount.length <= 1) return "0";
  return amount.slice(0, -1);
}

/**
 * A compact amount keypad with explicit semantic labels for each key. Saving
 * echoes the entered string so an incorrect amount is visible to the caller.
 */
export default function Keypad() {
  const [amount, setAmount] = useState("0");
  const [savedAmount, setSavedAmount] = useState<string | null>(null);

  /** Adds one numeric digit to the current amount. */
  const handleDigit = (digit: string) => {
    setAmount((current) => appendDigit(current, digit));
  };

  /** Adds the decimal separator once, if it is not already present. */
  const handleDecimal = () => {
    setAmount((current) => appendDecimal(current));
  };

  /** Removes the last entered character from the amount. */
  const handleDelete = () => {
    setAmount((current) => deleteLastDigit(current));
  };

  /** Records the exact amount currently shown on the keypad. */
  const handleSave = () => {
    setSavedAmount(amount);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Enter an amount</Text>
      <Text style={styles.hint}>Use the number pad, then save the amount.</Text>
      <Text
        testID="keypad-amount"
        accessibilityLabel={`Amount ${amount} USD`}
        style={styles.amount}
      >
        {amount} USD
      </Text>

      <View testID="keypad" style={styles.keypad}>
        {DIGITS.map((digit) => (
          <KeypadButton
            key={digit}
            testID={`keypad-${digit}`}
            label={digit}
            onPress={() => handleDigit(digit)}
          />
        ))}
        <KeypadButton
          testID="keypad-decimal"
          label="."
          accessibilityLabel="Decimal point"
          onPress={handleDecimal}
        />
        <KeypadButton testID="keypad-0" label="0" onPress={() => handleDigit("0")} />
        <KeypadButton testID="keypad-delete" label="<" accessibilityLabel="Delete digit" onPress={handleDelete} />
      </View>

      <Pressable
        testID="keypad-save"
        accessibilityRole="button"
        accessibilityLabel="Save"
        style={styles.saveButton}
        onPress={handleSave}
      >
        <Text style={styles.saveButtonText}>Save</Text>
      </Pressable>

      {savedAmount !== null && (
        <Text testID="success-message" style={styles.successText}>
          Saved {savedAmount} USD
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    alignItems: "center",
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
    marginTop: 8,
  },
  hint: {
    color: "#666",
    fontSize: 14,
    marginTop: 4,
    textAlign: "center",
  },
  amount: {
    fontSize: 32,
    fontWeight: "700",
    marginVertical: 16,
  },
  keypad: {
    alignSelf: "stretch",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "center",
  },
  key: {
    alignItems: "center",
    backgroundColor: "#eee",
    borderRadius: 10,
    height: 52,
    justifyContent: "center",
    width: "30%",
  },
  keyText: {
    fontSize: 20,
    fontWeight: "600",
  },
  saveButton: {
    alignItems: "center",
    alignSelf: "stretch",
    backgroundColor: "#111",
    borderRadius: 10,
    justifyContent: "center",
    marginTop: 16,
    minHeight: 48,
  },
  saveButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  successText: {
    color: "#0a0",
    fontSize: 18,
    fontWeight: "600",
    marginTop: 12,
  },
});
