import { useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

const VALID_EMAIL = "tester@tester.army";
const VALID_PASSWORD = "benchmark123";

export default function LoginForm() {
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
      <View style={styles.container}>
        <Text testID="success-message" style={styles.successText}>
          Logged in successfully
        </Text>
        <TouchableOpacity
          testID="logout-button"
          style={styles.button}
          onPress={() => {
            setLoggedIn(false);
            setEmail("");
            setPassword("");
          }}
        >
          <Text style={styles.buttonText}>Log out</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.hint}>
        Use {VALID_EMAIL} / {VALID_PASSWORD}
      </Text>
      <TextInput
        testID="email-input"
        style={styles.input}
        placeholder="Email"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        testID="password-input"
        style={styles.input}
        placeholder="Password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      {error ? (
        <Text testID="error-message" style={styles.errorText}>
          {error}
        </Text>
      ) : null}
      <TouchableOpacity testID="login-button" style={styles.button} onPress={handleSubmit}>
        <Text style={styles.buttonText}>Log in</Text>
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
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  button: {
    backgroundColor: "#111",
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  errorText: {
    color: "#c00",
    fontSize: 14,
  },
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
    textAlign: "center",
    marginBottom: 16,
  },
});
