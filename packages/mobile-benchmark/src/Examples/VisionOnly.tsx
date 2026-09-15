import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

type Shape = "circle" | "square" | "diamond";

const SEQUENCE: Shape[] = ["square", "circle", "diamond"];

/**
 * Simulates a canvas-rendered app (Flutter, game engines, custom renderers):
 * the entire subtree is removed from the accessibility tree on both platforms
 * via `accessibilityElementsHidden` and `importantForAccessibility`, so a
 * hierarchy snapshot returns nothing actionable. The agent has to read the
 * on-screen instruction and tap the shapes in the right order purely from
 * pixels.
 */
export default function VisionOnly() {
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);

  /**
   * Advances the sequence when the tapped shape matches the next expected
   * one; any wrong tap resets progress and shows a visual error flash.
   */
  const handleTap = (shape: Shape) => {
    if (shape === SEQUENCE[progress]) {
      setFailed(false);
      setProgress((current) => current + 1);
      return;
    }
    setFailed(true);
    setProgress(0);
  };

  const done = progress >= SEQUENCE.length;

  return (
    <View
      style={styles.container}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {done ? (
        <Text style={styles.successText}>Sequence complete</Text>
      ) : (
        <>
          <Text style={styles.instruction}>Tap: square, then circle, then diamond</Text>
          <Text style={styles.progress}>
            Progress: {progress}/{SEQUENCE.length}
            {failed ? " — wrong shape, start over" : ""}
          </Text>
          <View style={styles.shapeRow}>
            <TouchableOpacity
              style={[styles.shape, styles.circle]}
              onPress={() => handleTap("circle")}
            />
            <TouchableOpacity
              style={[styles.shape, styles.diamond]}
              onPress={() => handleTap("diamond")}
            />
            <TouchableOpacity
              style={[styles.shape, styles.square]}
              onPress={() => handleTap("square")}
            />
          </View>
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
  instruction: {
    fontSize: 16,
    textAlign: "center",
  },
  progress: {
    fontSize: 14,
    color: "#666",
  },
  shapeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 24,
    marginTop: 16,
  },
  shape: {
    width: 56,
    height: 56,
    backgroundColor: "#36c",
  },
  circle: {
    borderRadius: 28,
  },
  square: {
    borderRadius: 4,
  },
  diamond: {
    borderRadius: 4,
    transform: [{ rotate: "45deg" }],
  },
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
  },
});
