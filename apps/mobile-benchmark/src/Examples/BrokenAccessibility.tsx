import { useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

const SECRET_CODE = "7291";

/**
 * Deliberately hostile accessibility: the whole screen is wrapped in a single
 * `accessible={true}` container, which merges every descendant into one
 * accessibility node on both platforms. Nothing inside is individually
 * focusable, there are no testIDs, and the buttons carry no labels — the
 * hierarchy snapshot is useless here and the agent must operate from vision
 * and raw coordinates.
 */
export default function BrokenAccessibility() {
  const [step, setStep] = useState<"pick" | "code" | "done">("pick");
  const [code, setCode] = useState("");
  const [wrongPick, setWrongPick] = useState(false);

  return (
    <View accessible={true} style={styles.container}>
      {step === "pick" && (
        <>
          <Text style={styles.instruction}>Tap the green circle to continue</Text>
          {wrongPick && <Text style={styles.errorText}>Wrong shape, try again</Text>}
          <View style={styles.shapeRow}>
            <TouchableOpacity
              style={[styles.shape, styles.circle, styles.red]}
              onPress={() => setWrongPick(true)}
            />
            <TouchableOpacity
              style={[styles.shape, styles.square, styles.green]}
              onPress={() => setWrongPick(true)}
            />
            <TouchableOpacity
              style={[styles.shape, styles.circle, styles.green]}
              onPress={() => {
                setWrongPick(false);
                setStep("code");
              }}
            />
            <TouchableOpacity
              style={[styles.shape, styles.circle, styles.blue]}
              onPress={() => setWrongPick(true)}
            />
          </View>
        </>
      )}
      {step === "code" && (
        <>
          <Text style={styles.instruction}>Enter the code {SECRET_CODE} and press the arrow</Text>
          <View style={styles.codeRow}>
            <TextInput
              style={styles.codeInput}
              keyboardType="number-pad"
              maxLength={4}
              value={code}
              onChangeText={setCode}
            />
            <TouchableOpacity
              style={[
                styles.shape,
                styles.circle,
                code === SECRET_CODE ? styles.green : styles.gray,
              ]}
              onPress={() => {
                if (code === SECRET_CODE) {
                  setStep("done");
                }
              }}
            >
              <Text style={styles.arrow}>→</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
      {step === "done" && <Text style={styles.successText}>Access granted</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 16,
  },
  instruction: {
    fontSize: 16,
    textAlign: "center",
  },
  shapeRow: {
    flexDirection: "row",
    gap: 16,
  },
  codeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  codeInput: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 18,
    width: 120,
    textAlign: "center",
  },
  shape: {
    width: 56,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
  },
  circle: {
    borderRadius: 28,
  },
  square: {
    borderRadius: 8,
  },
  red: {
    backgroundColor: "#d33",
  },
  green: {
    backgroundColor: "#2a9d2a",
  },
  blue: {
    backgroundColor: "#36c",
  },
  gray: {
    backgroundColor: "#aaa",
  },
  arrow: {
    color: "#fff",
    fontSize: 24,
  },
  errorText: {
    color: "#c00",
    fontSize: 14,
  },
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
  },
});
