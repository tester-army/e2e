import { useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

const VALID_EMAIL = "tester@tester.army";
const VALID_PASSWORD = "benchmark123";

/**
 * Credential-filling variant of the flattened-AX drill: the whole login
 * screen sits inside one `accessible={true}` container, so both inputs and
 * the button merge into a single accessibility node with no testIDs. The
 * agent cannot target the email or password fields through the tree - it
 * must tap each field from vision and fill the credential into whatever
 * holds focus, then verify success from pixels alone.
 */
export default function FlattenedLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);

  /**
   * Validates the credentials against the hardcoded benchmark account and
   * moves the screen into the logged-in success state on match.
   */
  const handleSubmit = () => {
    if (!email.includes("@")) {
      setError("Enter a valid email address");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (email !== VALID_EMAIL || password !== VALID_PASSWORD) {
      setError("Invalid credentials");
      return;
    }
    setError(null);
    setLoggedIn(true);
  };

  if (loggedIn) {
    return (
      <View accessible={true} style={styles.successContainer}>
        <Text style={styles.successText}>Logged in successfully</Text>
      </View>
    );
  }

  return (
    <View accessible={true} style={styles.container}>
      <Text style={styles.hint}>
        Use {VALID_EMAIL} / {VALID_PASSWORD}
      </Text>
      <Text style={styles.label}>Email</Text>
      <TextInput
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <Text style={styles.label}>Password</Text>
      <TextInput
        style={styles.input}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        value={password}
        onChangeText={setPassword}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <TouchableOpacity style={styles.button} onPress={handleSubmit}>
        <Text style={styles.buttonText}>SIGN IN</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    gap: 12,
    justifyContent: "center",
  },
  hint: {
    fontSize: 13,
    color: "#666",
    textAlign: "center",
  },
  label: {
    fontSize: 14,
    color: "#333",
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
  },
  button: {
    backgroundColor: "#111",
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  errorText: {
    color: "#c00",
    fontSize: 14,
  },
  successContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
  },
});
