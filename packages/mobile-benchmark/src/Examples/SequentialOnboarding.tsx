import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

/**
 * Sequential Onboarding — distilled from a real production signup wizard:
 * a multi-step signup wizard where every step auto-focuses its first field, so
 * the keyboard is open the moment the screen appears and covers the Continue
 * button pinned at the bottom. On the name step the second field is anchored
 * low as well, so while the first field holds focus the second sits under the
 * keyboard too. Enter never submits (submitBehavior="submit" keeps the
 * keyboard up), forcing an explicit dismiss-then-tap. The success screen
 * echoes the exact entered values, so a single stray character typed by a tap
 * that landed on the keyboard fails the run.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^0\d{9}$/;

type Step = "email" | "name" | "phone" | "done";

export default function SequentialOnboarding() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);

  const advance = (isValid: boolean, message: string, next: Step) => {
    if (!isValid) {
      setError(message);
      return;
    }
    setError(null);
    setStep(next);
  };

  if (step === "done") {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text testID="success-message" style={styles.successText}>
          Onboarding complete
        </Text>
        <Text testID="echo-email" style={styles.echoText}>
          {email}
        </Text>
        <Text testID="echo-name" style={styles.echoText}>
          {firstName} {lastName}
        </Text>
        <Text testID="echo-phone" style={styles.echoText}>
          {phone}
        </Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.wizard}
      keyboardShouldPersistTaps="never"
      testID={`onboarding-step-${step}`}
    >
      {step === "email" && (
        <>
          <Text style={styles.progress}>Step 1 of 3</Text>
          <Text style={styles.title}>{"Let's start with your email"}</Text>
          <TextInput
            key="email"
            testID="email-input"
            style={styles.input}
            placeholder="e.g. jane@example.com"
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            submitBehavior="submit"
            value={email}
            onChangeText={setEmail}
          />
          <View style={styles.spacer} />
        </>
      )}
      {step === "name" && (
        <>
          <Text style={styles.progress}>Step 2 of 3</Text>
          <Text style={styles.title}>Tell us more about you</Text>
          <Text style={styles.label}>First name</Text>
          <TextInput
            key="first-name"
            testID="first-name-input"
            style={styles.input}
            placeholder="e.g. Jane"
            autoFocus
            autoCorrect={false}
            submitBehavior="submit"
            value={firstName}
            onChangeText={setFirstName}
          />
          <View style={styles.spacer} />
          <Text style={styles.label}>Last name</Text>
          <TextInput
            key="last-name"
            testID="last-name-input"
            style={styles.input}
            placeholder="e.g. Merchant"
            autoCorrect={false}
            submitBehavior="submit"
            value={lastName}
            onChangeText={setLastName}
          />
        </>
      )}
      {step === "phone" && (
        <>
          <Text style={styles.progress}>Step 3 of 3</Text>
          <Text style={styles.title}>Your phone number</Text>
          <TextInput
            key="phone"
            testID="phone-input"
            style={styles.input}
            placeholder="e.g. 0612435678"
            autoFocus
            keyboardType="number-pad"
            submitBehavior="submit"
            value={phone}
            onChangeText={setPhone}
          />
          <View style={styles.spacer} />
        </>
      )}
      {error !== null && (
        <Text testID="step-error" style={styles.errorText}>
          {error}
        </Text>
      )}
      {step === "email" && (
        <TouchableOpacity
          testID="continue-button"
          style={styles.button}
          onPress={() => advance(EMAIL_PATTERN.test(email), "Enter a valid email address", "name")}
        >
          <Text style={styles.buttonText}>Continue</Text>
        </TouchableOpacity>
      )}
      {step === "name" && (
        <TouchableOpacity
          testID="continue-button"
          style={styles.button}
          onPress={() =>
            advance(
              firstName.trim().length > 0 && lastName.trim().length > 0,
              "Enter your first and last name",
              "phone",
            )
          }
        >
          <Text style={styles.buttonText}>Continue</Text>
        </TouchableOpacity>
      )}
      {step === "phone" && (
        <TouchableOpacity
          testID="continue-button"
          style={styles.button}
          onPress={() =>
            advance(
              PHONE_PATTERN.test(phone),
              "Enter a 10-digit phone number starting with 0",
              "done",
            )
          }
        >
          <Text style={styles.buttonText}>Continue</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 24,
    gap: 8,
  },
  wizard: {
    flexGrow: 1,
    padding: 24,
    gap: 8,
  },
  progress: {
    fontSize: 13,
    color: "#666",
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
    marginBottom: 16,
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
  // Pushes what follows toward the bottom so the last-name field and the
  // Continue button sit inside the region the open keyboard covers.
  spacer: {
    flex: 1,
  },
  button: {
    marginTop: 16,
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
    marginTop: 8,
  },
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
    textAlign: "center",
    marginTop: 48,
  },
  echoText: {
    fontSize: 16,
    textAlign: "center",
    marginTop: 8,
  },
});
