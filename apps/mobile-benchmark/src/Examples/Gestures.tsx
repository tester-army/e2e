import { useRef, useState } from "react";
import { PanResponder, Pressable, StyleSheet, Text, View } from "react-native";

const SWIPE_THRESHOLD = -80;
const DOUBLE_TAP_WINDOW_MS = 300;

export default function Gestures() {
  const [step, setStep] = useState(0);
  const lastTapRef = useRef(0);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dx) > 10,
      onPanResponderRelease: (_event, gesture) => {
        if (gesture.dx < SWIPE_THRESHOLD) {
          setStep((current) => (current === 1 ? 2 : current));
        }
      },
    }),
  ).current;

  /**
   * Detects a double tap by comparing timestamps of consecutive presses and
   * advances the flow when two taps land within the allowed window.
   */
  const handleDoubleTapCandidate = () => {
    const now = Date.now();
    if (now - lastTapRef.current <= DOUBLE_TAP_WINDOW_MS) {
      setStep((current) => (current === 2 ? 3 : current));
    }
    lastTapRef.current = now;
  };

  if (step === 3) {
    return (
      <View style={styles.container}>
        <Text testID="success-message" style={styles.successText}>
          All gestures completed
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.stepIndicator}>Step {step + 1} of 3</Text>
      {step === 0 && (
        <>
          <Text style={styles.instruction}>Long-press the button below (hold ~1 second)</Text>
          <Pressable
            testID="long-press-target"
            style={styles.target}
            delayLongPress={800}
            onLongPress={() => setStep(1)}
          >
            <Text style={styles.targetText}>Hold me</Text>
          </Pressable>
        </>
      )}
      {step === 1 && (
        <>
          <Text style={styles.instruction}>Swipe the card below to the left</Text>
          <View testID="swipe-target" style={styles.card} {...panResponder.panHandlers}>
            <Text style={styles.targetText}>Swipe me left</Text>
          </View>
        </>
      )}
      {step === 2 && (
        <>
          <Text style={styles.instruction}>Double-tap the button below</Text>
          <Pressable
            testID="double-tap-target"
            style={styles.target}
            onPress={handleDoubleTapCandidate}
          >
            <Text style={styles.targetText}>Double-tap me</Text>
          </Pressable>
        </>
      )}
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
  stepIndicator: {
    fontSize: 13,
    color: "#666",
  },
  instruction: {
    fontSize: 16,
    textAlign: "center",
  },
  target: {
    backgroundColor: "#111",
    borderRadius: 8,
    paddingVertical: 16,
    paddingHorizontal: 32,
  },
  card: {
    backgroundColor: "#36c",
    borderRadius: 12,
    paddingVertical: 24,
    paddingHorizontal: 48,
  },
  targetText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
  },
});
