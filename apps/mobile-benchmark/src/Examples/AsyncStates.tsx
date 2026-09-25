import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

const INITIAL_LOAD_MS = 2000;
const REFRESH_MS = 1200;
const TOAST_MS = 2500;

export default function AsyncStates() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rewardVisible, setRewardVisible] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);
  const [claimed, setClaimed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), INITIAL_LOAD_MS);
    return () => clearTimeout(timer);
  }, []);

  /**
   * Simulates a pull-to-refresh fetch that reveals the claim button once the
   * refresh completes.
   */
  const handleRefresh = () => {
    setRefreshing(true);
    setTimeout(() => {
      setRefreshing(false);
      setRewardVisible(true);
    }, REFRESH_MS);
  };

  /**
   * Claims the reward: shows a transient toast, then settles into the
   * persistent success state once the toast disappears.
   */
  const handleClaim = () => {
    setToastVisible(true);
    setTimeout(() => {
      setToastVisible(false);
      setClaimed(true);
    }, TOAST_MS);
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator testID="initial-loading" size="large" />
        <Text style={styles.hint}>Loading…</Text>
      </View>
    );
  }

  let content = <Text style={styles.hint}>Pull down to refresh and reveal your reward</Text>;
  if (claimed) {
    content = (
      <Text testID="success-message" style={styles.successText}>
        Reward claimed
      </Text>
    );
  } else if (rewardVisible) {
    content = (
      <TouchableOpacity testID="claim-button" style={styles.button} onPress={handleClaim}>
        <Text style={styles.buttonText}>Claim reward</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.flex}>
      <ScrollView
        testID="reward-scroll"
        contentContainerStyle={styles.container}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      >
        {content}
      </ScrollView>
      {toastVisible && (
        <View testID="toast" style={styles.toast}>
          <Text style={styles.toastText}>Claiming reward…</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  container: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  hint: {
    fontSize: 14,
    color: "#666",
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
  toast: {
    position: "absolute",
    bottom: 48,
    alignSelf: "center",
    backgroundColor: "#333",
    borderRadius: 24,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  toastText: {
    color: "#fff",
    fontSize: 14,
  },
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
  },
});
