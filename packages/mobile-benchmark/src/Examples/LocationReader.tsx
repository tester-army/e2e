import * as Location from "expo-location";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

type PermissionState = "unknown" | "granted" | "denied";

const POSITION_TIMEOUT_MS = 10_000;

/**
 * Formats a position the way the app prints it, four decimals each.
 */
const formatCoordinates = (latitude: number, longitude: number) => `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;

/**
 * Reads one position no older than the tap, or fails once the timeout
 * passes. A one-shot read can answer from the provider's cache, which on
 * Android is the fix before a `geo fix`, so the reader watches for the first
 * fresh one instead; a simulator with no location set never answers, and the
 * screen must not hang on it. Play Services' own "turn on location accuracy"
 * dialog is declined up front, so an unsatisfied setting comes back as an
 * error line, not a system sheet.
 */
async function readPosition(): Promise<Location.LocationObject> {
  const since = Date.now() - 1_000;
  let subscription: Location.LocationSubscription | undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Location.LocationObject>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`No position within ${POSITION_TIMEOUT_MS / 1000} s`)), POSITION_TIMEOUT_MS);
      Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 0, distanceInterval: 0, mayShowUserSettingsDialog: false },
        (position) => {
          if (position.timestamp >= since) {
            settled = true;
            resolve(position);
          }
        },
      ).then((started) => {
        subscription = started;
        if (settled) started.remove();
      }, reject);
    });
  } finally {
    settled = true;
    clearTimeout(timer);
    subscription?.remove();
  }
}

/**
 * The device fixture's location surface: one button that asks for foreground
 * location access, then reads the current position and prints it, so
 * `setLocation` and `clearLocation` have something to be read back from. A
 * denied permission or disabled location services show as an error line.
 */
export default function LocationReader() {
  const [permission, setPermission] = useState<PermissionState>("unknown");
  const [coordinates, setCoordinates] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  /**
   * Requests the permission if needed, then reads and prints the position.
   */
  const handleRead = async () => {
    setReading(true);
    setError(null);
    setCoordinates(null);
    try {
      const response = await Location.requestForegroundPermissionsAsync();
      setPermission(response.granted ? "granted" : "denied");
      if (!response.granted) {
        setError("Location permission denied");
        return;
      }
      if (!(await Location.hasServicesEnabledAsync())) {
        setError("Location services are off");
        return;
      }
      const position = await readPosition();
      setCoordinates(formatCoordinates(position.coords.latitude, position.coords.longitude));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setReading(false);
    }
  };

  return (
    <View style={styles.center}>
      <Text style={styles.title}>Where am I</Text>
      <Text style={styles.hint}>Reads the device position once. Allow location access when the system asks.</Text>
      <Text testID="location-permission" style={styles.status}>
        permission: {permission}
      </Text>
      {coordinates !== null && (
        <>
          <Text testID="location-coordinates" style={styles.status}>
            {coordinates}
          </Text>
          <Text testID="success-message" style={styles.successText}>
            Position read
          </Text>
        </>
      )}
      {error !== null && (
        <View style={styles.banner}>
          <Text testID="location-error" style={styles.bannerText}>
            {error}
          </Text>
        </View>
      )}
      <TouchableOpacity testID="read-location" style={styles.button} disabled={reading} onPress={handleRead}>
        <Text style={styles.buttonText}>{reading ? "Reading…" : "Read location"}</Text>
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
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
  },
});
