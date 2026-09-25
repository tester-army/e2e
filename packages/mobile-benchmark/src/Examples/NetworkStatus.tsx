import { useNetworkState } from "expo-network";
import { StyleSheet, Text, View } from "react-native";

/**
 * Prints a nullable flag as the app spells it.
 */
const yesNo = (value: boolean | undefined) => (value === undefined ? "unknown" : value ? "yes" : "no");

/**
 * The device fixture's network surface: three lines that follow the network
 * state the OS reports, so `setNetwork` and `setAirplaneMode` have something
 * to be read back from. Not a hard surface, and nothing to complete.
 */
export default function NetworkStatus() {
  const state = useNetworkState();

  return (
    <View style={styles.center}>
      <Text style={styles.title}>Connection</Text>
      <Text style={styles.hint}>The lines below follow the network as the OS reports it and update on their own.</Text>
      <Text testID="network-type" style={styles.status}>
        type: {(state.type ?? "unknown").toLowerCase()}
      </Text>
      <Text testID="network-connected" style={styles.status}>
        connected: {yesNo(state.isConnected)}
      </Text>
      <Text testID="network-reachable" style={styles.status}>
        internet: {yesNo(state.isInternetReachable)}
      </Text>
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
});
