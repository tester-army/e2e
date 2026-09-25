import { useState } from "react";
import { Alert, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";

export default function ModalFlow() {
  const [modalVisible, setModalVisible] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  /**
   * Presents a native alert on top of the modal; accepting it closes the
   * modal and moves the screen into the success state.
   */
  const handleConfirm = () => {
    Alert.alert("Confirm action", "Do you want to complete this flow?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Confirm",
        onPress: () => {
          setModalVisible(false);
          setConfirmed(true);
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      {confirmed ? (
        <Text testID="success-message" style={styles.successText}>
          Flow completed
        </Text>
      ) : (
        <TouchableOpacity
          testID="open-modal-button"
          style={styles.button}
          onPress={() => setModalVisible(true)}
        >
          <Text style={styles.buttonText}>Open modal</Text>
        </TouchableOpacity>
      )}
      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="modal-card">
            <Text style={styles.modalTitle}>Benchmark modal</Text>
            <Text style={styles.modalBody}>
              Tap Continue, then accept the native alert to finish.
            </Text>
            <TouchableOpacity
              testID="continue-button"
              style={styles.button}
              onPress={handleConfirm}
            >
              <Text style={styles.buttonText}>Continue</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="close-modal-button"
              style={styles.secondaryButton}
              onPress={() => setModalVisible(false)}
            >
              <Text style={styles.secondaryButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  button: {
    backgroundColor: "#111",
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
    alignItems: "center",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  secondaryButton: {
    paddingVertical: 12,
    alignItems: "center",
  },
  secondaryButtonText: {
    color: "#666",
    fontSize: 15,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 24,
    gap: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "600",
  },
  modalBody: {
    fontSize: 15,
    color: "#444",
  },
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
  },
});
