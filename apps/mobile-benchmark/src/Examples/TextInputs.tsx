import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
} from "react-native";

const MIN_NOTES_LENGTH = 10;

export default function TextInputs() {
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [notes, setNotes] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const isValid = username.length >= 3 && pin.length === 4 && notes.length >= MIN_NOTES_LENGTH;

  if (submitted) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text testID="success-message" style={styles.successText}>
          Form submitted
        </Text>
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Username (min 3 chars)</Text>
        <TextInput
          testID="username-input"
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          value={username}
          onChangeText={setUsername}
        />
        <Text style={styles.label}>PIN (exactly 4 digits, secure)</Text>
        <TextInput
          testID="pin-input"
          style={styles.input}
          keyboardType="number-pad"
          secureTextEntry
          maxLength={4}
          value={pin}
          onChangeText={(text) => setPin(text.replace(/[^0-9]/g, ""))}
        />
        <Text style={styles.label}>
          Notes (multiline, min {MIN_NOTES_LENGTH} chars) — {notes.length}/{MIN_NOTES_LENGTH}
        </Text>
        <TextInput
          testID="notes-input"
          style={[styles.input, styles.multiline]}
          multiline
          numberOfLines={4}
          value={notes}
          onChangeText={setNotes}
        />
        <TouchableOpacity
          testID="submit-button"
          style={[styles.button, !isValid && styles.buttonDisabled]}
          disabled={!isValid}
          onPress={() => setSubmitted(true)}
        >
          <Text style={styles.buttonText}>Submit</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    padding: 24,
    gap: 8,
  },
  label: {
    fontSize: 13,
    color: "#666",
    marginTop: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  multiline: {
    minHeight: 96,
    textAlignVertical: "top",
  },
  button: {
    marginTop: 16,
    backgroundColor: "#111",
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonDisabled: {
    backgroundColor: "#999",
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
    textAlign: "center",
    marginTop: 48,
  },
});
