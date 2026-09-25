import * as LocalAuthentication from "expo-local-authentication";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

/**
 * Names the strongest sensor the device declares, the way the app prints it.
 */
function describeSensor(types: LocalAuthentication.AuthenticationType[]): string {
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return "face";
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return "fingerprint";
  if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) return "iris";
  return "none";
}

/**
 * The device fixture's biometric surface: a vault that unlocks through the
 * OS biometric prompt, which lives outside the app's accessibility tree, so
 * `enrollBiometrics` and `setBiometrics` have a prompt to answer. The sensor
 * and enrollment lines are re-read on demand; a failed or refused attempt
 * shows its error code.
 */
export default function BiometricLock() {
  const [sensor, setSensor] = useState("unknown");
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authenticating, setAuthenticating] = useState(false);

  /**
   * Re-reads the sensor and the enrollment state from the OS.
   */
  const refresh = useCallback(async () => {
    setSensor(describeSensor(await LocalAuthentication.supportedAuthenticationTypesAsync()));
    setEnrolled(await LocalAuthentication.isEnrolledAsync());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Shows the biometric prompt with no passcode fallback and records the outcome.
   */
  const handleUnlock = async () => {
    setAuthenticating(true);
    setError(null);
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Unlock the vault",
        cancelLabel: "Cancel",
        disableDeviceFallback: true,
      });
      if (result.success) {
        setUnlocked(true);
      } else {
        setError(result.error);
      }
    } finally {
      setAuthenticating(false);
    }
  };

  if (unlocked) {
    return (
      <View style={styles.center}>
        <Text testID="success-message" style={styles.successText}>
          Vault unlocked
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.center}>
      <Text style={styles.title}>Vault</Text>
      <Text style={styles.hint}>Unlocking asks for the device biometric. Answer the system prompt.</Text>
      <Text testID="biometric-sensor" style={styles.status}>
        sensor: {sensor}
      </Text>
      <Text testID="biometric-enrolled" style={styles.status}>
        enrolled: {enrolled === null ? "unknown" : enrolled ? "yes" : "no"}
      </Text>
      {error !== null && (
        <View style={styles.banner}>
          <Text testID="biometric-error" style={styles.bannerText}>
            error: {error}
          </Text>
        </View>
      )}
      <TouchableOpacity testID="unlock-vault" style={styles.button} disabled={authenticating} onPress={handleUnlock}>
        <Text style={styles.buttonText}>{authenticating ? "Waiting…" : "Unlock"}</Text>
      </TouchableOpacity>
      <TouchableOpacity testID="refresh-biometrics" style={styles.secondaryButton} onPress={refresh}>
        <Text style={styles.secondaryButtonText}>Check again</Text>
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
  status: {
    fontSize: 16,
    fontFamily: "Menlo",
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
