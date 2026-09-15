import { useEffect, useState } from "react";
import {
  Keyboard,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

const SIZES = ["Small", "Medium", "Large"] as const;
const TOPPINGS = ["Cheese", "Olives", "Mushrooms", "Onions"] as const;
const REQUIRED_TOPPINGS: readonly string[] = ["Cheese", "Olives"];

/**
 * Non-text form controls behind a gated submit: a radio-style size group, a
 * set of checkboxes, a switch, and a notes field whose keyboard must be
 * dismissed before the submit button becomes reachable. Success requires the
 * exact combination described in the on-screen instructions.
 */
export default function ChoiceControls() {
  const [size, setSize] = useState<string | null>(null);
  const [toppings, setToppings] = useState<Record<string, boolean>>({});
  const [rushDelivery, setRushDelivery] = useState(false);
  const [notes, setNotes] = useState("");
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setKeyboardVisible(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const selectedToppings = TOPPINGS.filter((topping) => toppings[topping]);
  const orderValid =
    size === "Medium" &&
    selectedToppings.length === REQUIRED_TOPPINGS.length &&
    REQUIRED_TOPPINGS.every((topping) => toppings[topping]) &&
    rushDelivery;

  /**
   * Toggles a topping checkbox on or off.
   */
  const toggleTopping = (topping: string) => {
    setToppings((current) => ({ ...current, [topping]: !current[topping] }));
  };

  if (submitted) {
    return (
      <View style={styles.center}>
        <Text testID="success-message" style={styles.successText}>
          Order placed: Medium with Cheese, Olives (rush)
        </Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.hint}>
        Order a Medium pizza with exactly Cheese and Olives, enable rush delivery, then place the
        order (dismiss the keyboard first).
      </Text>

      <Text style={styles.sectionTitle}>Size</Text>
      <View style={styles.row}>
        {SIZES.map((option) => (
          <TouchableOpacity
            key={option}
            testID={`size-${option.toLowerCase()}`}
            accessibilityRole="radio"
            accessibilityState={{ selected: size === option }}
            style={[styles.chip, size === option && styles.chipSelected]}
            onPress={() => setSize(option)}
          >
            <Text style={[styles.chipText, size === option && styles.chipTextSelected]}>
              {option}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Toppings</Text>
      {TOPPINGS.map((topping) => (
        <TouchableOpacity
          key={topping}
          testID={`topping-${topping.toLowerCase()}`}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: !!toppings[topping] }}
          style={styles.checkboxRow}
          onPress={() => toggleTopping(topping)}
        >
          <View style={[styles.checkbox, toppings[topping] && styles.checkboxChecked]}>
            {toppings[topping] && <Text style={styles.checkboxMark}>✓</Text>}
          </View>
          <Text style={styles.checkboxLabel}>{topping}</Text>
        </TouchableOpacity>
      ))}

      <View style={styles.switchRow}>
        <Text style={styles.checkboxLabel}>Rush delivery</Text>
        <Switch testID="rush-delivery" value={rushDelivery} onValueChange={setRushDelivery} />
      </View>

      <Text style={styles.sectionTitle}>Delivery notes</Text>
      <TextInput
        testID="delivery-notes"
        style={styles.input}
        placeholder="Ring the doorbell twice"
        value={notes}
        onChangeText={setNotes}
      />

      {keyboardVisible && (
        <Text testID="keyboard-warning" style={styles.warning}>
          Dismiss the keyboard to place the order
        </Text>
      )}
      <TouchableOpacity
        testID="place-order"
        style={[styles.button, (!orderValid || keyboardVisible) && styles.buttonDisabled]}
        disabled={!orderValid || keyboardVisible}
        onPress={() => setSubmitted(true)}
      >
        <Text style={styles.buttonText}>Place order</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 24,
    gap: 12,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  hint: {
    fontSize: 14,
    color: "#666",
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "600",
    marginTop: 8,
  },
  row: {
    flexDirection: "row",
    gap: 8,
  },
  chip: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  chipSelected: {
    backgroundColor: "#111",
    borderColor: "#111",
  },
  chipText: {
    fontSize: 15,
  },
  chipTextSelected: {
    color: "#fff",
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 6,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#999",
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    backgroundColor: "#111",
    borderColor: "#111",
  },
  checkboxMark: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  checkboxLabel: {
    fontSize: 16,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  warning: {
    color: "#b00020",
    fontSize: 14,
  },
  button: {
    backgroundColor: "#111",
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  buttonDisabled: {
    backgroundColor: "#bbb",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
    textAlign: "center",
  },
});
