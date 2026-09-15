import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

type FieldKey = "firstName" | "lastName" | "email" | "password";

const FIELD_ERRORS: Record<FieldKey, string> = {
  firstName: "Please enter your first name",
  lastName: "Please enter your last name",
  email: "Please enter a valid email address",
  password: "Password must be at least 8 characters",
};

/**
 * Validates one field the same way on every run so failures are
 * deterministic: names must be non-empty, the email needs an "@", and the
 * password needs at least 8 characters.
 */
function fieldError(key: FieldKey, value: string): string | null {
  const trimmed = value.trim();
  if (key === "email") {
    return trimmed.includes("@") && trimmed.length >= 3 ? null : FIELD_ERRORS.email;
  }
  if (key === "password") {
    return value.length >= 8 ? null : FIELD_ERRORS.password;
  }
  return trimmed.length > 0 ? null : FIELD_ERRORS[key];
}

/**
 * Distilled from a real production registration screen: the entire
 * scrollable form sits inside one `accessible={true}` container, so every
 * field, label, and button merges into a single accessibility node with a
 * giant concatenated label. Individual inputs are never focusable via the
 * tree and carry no testIDs — the agent must tap fields from vision and type
 * into whatever holds focus, across roughly two screens of content.
 */
export default function FlattenedForm() {
  const [values, setValues] = useState<Record<FieldKey, string>>({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
  });
  const [submitted, setSubmitted] = useState(false);
  const [done, setDone] = useState(false);

  const setValue = (key: FieldKey) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const errors = (Object.keys(values) as FieldKey[]).filter(
    (key) => fieldError(key, values[key]) !== null,
  );

  if (done) {
    return (
      <View accessible={true} style={styles.successContainer}>
        <Text style={styles.successText}>Account created</Text>
      </View>
    );
  }

  return (
    <ScrollView>
      <View accessible={true} style={styles.container}>
        <Text style={styles.heading}>Create your benchmark account</Text>

        {(
          [
            { key: "firstName", label: "First name", secure: false },
            { key: "lastName", label: "Last name", secure: false },
            { key: "email", label: "Email address", secure: false },
            { key: "password", label: "Set password", secure: true },
          ] as const
        ).map(({ key, label, secure }) => (
          <View key={key} style={styles.field}>
            <Text style={styles.label}>{label}</Text>
            <TextInput
              style={styles.input}
              value={values[key]}
              onChangeText={setValue(key)}
              secureTextEntry={secure}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {submitted && fieldError(key, values[key]) !== null && (
              <Text style={styles.errorText}>{FIELD_ERRORS[key]}</Text>
            )}
          </View>
        ))}

        <Text style={styles.legal}>
          Passwords must contain a minimum of 8 characters. By signing up you confirm you have read
          the benchmark terms. This filler paragraph exists so the form spans roughly two screens
          and the scroll indicator reports multiple pages, matching the production app this scenario
          was distilled from.
        </Text>

        <TouchableOpacity
          style={styles.submit}
          onPress={() => {
            setSubmitted(true);
            if (errors.length === 0) {
              setDone(true);
            }
          }}
        >
          <Text style={styles.submitText}>CREATE ACCOUNT</Text>
        </TouchableOpacity>

        <Text style={styles.legal}>
          More filler content below the primary action: support links, privacy policy, and terms and
          conditions would normally live here. It pads the scroll extent so off-screen estimation
          has something to measure.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 24,
    gap: 16,
  },
  heading: {
    fontSize: 20,
    fontWeight: "600",
  },
  field: {
    gap: 6,
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
  errorText: {
    color: "#c00",
    fontSize: 13,
  },
  legal: {
    fontSize: 13,
    color: "#666",
    lineHeight: 20,
    paddingVertical: 40,
  },
  submit: {
    backgroundColor: "#111",
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
  },
  submitText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
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
