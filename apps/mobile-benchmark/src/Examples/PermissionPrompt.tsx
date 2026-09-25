import { AudioModule } from "expo-audio";
import { useState } from "react";
import { Linking, StyleSheet, Text, TouchableOpacity, View } from "react-native";

type PermissionState = "unknown" | "granted" | "denied";

/**
 * Gates handling of the OS permission dialog: the agent must trigger the
 * microphone request, answer the system prompt (which lives outside the app's
 * accessibility tree), and land on the granted state. If the prompt was
 * denied, the recovery path goes through system settings and a re-check.
 */
export default function PermissionPrompt() {
  const [status, setStatus] = useState<PermissionState>("unknown");
  const [requesting, setRequesting] = useState(false);

  /**
   * Requests microphone access, surfacing the OS permission prompt on first
   * run, and records the resulting status.
   */
  const handleRequest = async () => {
    setRequesting(true);
    try {
      const response = await AudioModule.requestRecordingPermissionsAsync();
      setStatus(response.granted ? "granted" : "denied");
    } finally {
      setRequesting(false);
    }
  };

  /**
   * Re-reads the current permission status without prompting, so a grant made
   * in system settings is picked up.
   */
  const handleCheckAgain = async () => {
    const response = await AudioModule.getRecordingPermissionsAsync();
    if (response.granted) {
      setStatus("granted");
    } else if (response.canAskAgain) {
      setStatus("unknown");
    } else {
      setStatus("denied");
    }
  };

  if (status === "granted") {
    return (
      <View style={styles.center}>
        <Text testID="success-message" style={styles.successText}>
          Microphone enabled
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.center}>
      <Text style={styles.title}>Voice notes</Text>
      <Text style={styles.hint}>
        Recording voice notes requires microphone access. Allow the permission when the system asks.
      </Text>
      {status === "denied" && (
        <View testID="denied-banner" style={styles.banner}>
          <Text style={styles.bannerText}>
            Microphone access is denied. Enable it in system settings, then check again.
          </Text>
        </View>
      )}
      <TouchableOpacity
        testID="request-permission"
        style={styles.button}
        disabled={requesting}
        onPress={handleRequest}
      >
        <Text style={styles.buttonText}>{requesting ? "Requesting…" : "Enable microphone"}</Text>
      </TouchableOpacity>
      {status === "denied" && (
        <>
          <TouchableOpacity
            testID="open-settings"
            style={styles.secondaryButton}
            onPress={() => Linking.openSettings()}
          >
            <Text style={styles.secondaryButtonText}>Open settings</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="check-again"
            style={styles.secondaryButton}
            onPress={handleCheckAgain}
          >
            <Text style={styles.secondaryButtonText}>Check again</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
  },
  hint: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
  },
  banner: {
    backgroundColor: "#fdecea",
    borderRadius: 8,
    padding: 12,
  },
  bannerText: {
    color: "#b00020",
    fontSize: 14,
    textAlign: "center",
  },
  button: {
    backgroundColor: "#111",
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  secondaryButton: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  secondaryButtonText: {
    color: "#0066cc",
    fontSize: 15,
    fontWeight: "500",
  },
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
  },
});
