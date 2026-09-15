import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";

const LOAD_MS = 1500;

type Phase = "loading" | "error" | "loaded";

/**
 * Deterministic error-and-recovery loop: the first load always fails with a
 * retryable error banner, the retry always succeeds, and finishing the flow
 * requires confirming a destructive action through a modal.
 */
export default function ErrorRecovery() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const attempts = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      attempts.current += 1;
      setPhase("error");
    }, LOAD_MS);
    return () => clearTimeout(timer);
  }, []);

  /**
   * Retries the failed load; the second attempt deterministically succeeds.
   */
  const handleRetry = () => {
    setPhase("loading");
    setTimeout(() => {
      attempts.current += 1;
      setPhase(attempts.current >= 2 ? "loaded" : "error");
    }, LOAD_MS);
  };

  if (phase === "loading") {
    return (
      <View style={styles.center}>
        <ActivityIndicator testID="loading-indicator" size="large" />
        <Text style={styles.hint}>Loading drafts…</Text>
      </View>
    );
  }

  if (phase === "error") {
    return (
      <View style={styles.center}>
        <View testID="error-banner" style={styles.banner}>
          <Text style={styles.bannerText}>Network error: could not load drafts</Text>
        </View>
        <TouchableOpacity testID="retry-button" style={styles.button} onPress={handleRetry}>
          <Text style={styles.buttonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.center}>
      {deleted ? (
        <Text testID="success-message" style={styles.successText}>
          Draft deleted
        </Text>
      ) : (
        <>
          <Text style={styles.title}>Drafts</Text>
          <View style={styles.draftRow}>
            <Text style={styles.draftText}>Untitled draft — “Quarterly numbers…”</Text>
          </View>
          <TouchableOpacity
            testID="delete-draft"
            style={styles.destructiveButton}
            onPress={() => setConfirmVisible(true)}
          >
            <Text style={styles.destructiveButtonText}>Delete draft</Text>
          </TouchableOpacity>
        </>
      )}
      <Modal transparent visible={confirmVisible} animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Delete this draft?</Text>
            <Text style={styles.hint}>This action cannot be undone.</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                testID="confirm-cancel"
                style={styles.secondaryButton}
                onPress={() => setConfirmVisible(false)}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="confirm-delete"
                style={styles.destructiveButton}
                onPress={() => {
                  setConfirmVisible(false);
                  setDeleted(true);
                }}
              >
                <Text style={styles.destructiveButtonText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
  },
  draftRow: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#d0d0d0",
    borderRadius: 8,
    padding: 12,
    alignSelf: "stretch",
  },
  draftText: {
    fontSize: 15,
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
  destructiveButton: {
    backgroundColor: "#b00020",
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  destructiveButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  secondaryButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  secondaryButtonText: {
    fontSize: 16,
    color: "#0066cc",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  modalCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 20,
    gap: 8,
    width: "80%",
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "600",
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 8,
  },
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
  },
});
