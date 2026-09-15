import { useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";

const SECTION_COUNT = 14;

const sections = Array.from({ length: SECTION_COUNT }, (_, i) => i + 1);

/**
 * An off-screen target under sticky chrome. The agreement content is a plain
 * (non-virtualized) ScrollView, so every section — including the "Accept
 * terms" button roughly three screens down — is present in the accessibility
 * tree as an off-screen node from the first snapshot. A sticky footer overlaps
 * the bottom of the scroll area, so bringing the accept button into view is
 * not enough: a tap must land it clear of the footer, and the footer's
 * Continue button stays a decoy until the terms are accepted.
 */
export default function StickyChrome() {
  const [accepted, setAccepted] = useState(false);
  const [decoyTapped, setDecoyTapped] = useState(false);
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <View style={styles.successContainer}>
        <Text testID="success-message" style={styles.successText}>
          Terms accepted
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.hint}>
          Read the agreement, tap Accept terms at the bottom, then Continue.
        </Text>
        {sections.map((section) => (
          <View key={section} style={styles.section}>
            <Text style={styles.sectionTitle}>Section {section}</Text>
            <Text style={styles.sectionBody}>
              Deterministic agreement paragraph {section} of {SECTION_COUNT}. Nothing in this
              section is actionable; it only adds scroll distance between the top of the screen and
              the accept button.
            </Text>
          </View>
        ))}
        <TouchableOpacity
          testID="accept-terms"
          style={[styles.accept, accepted && styles.acceptDone]}
          onPress={() => setAccepted(true)}
        >
          <Text style={styles.acceptText}>{accepted ? "Terms accepted ✓" : "Accept terms"}</Text>
        </TouchableOpacity>
      </ScrollView>

      <View style={styles.footer}>
        {decoyTapped && !accepted && (
          <Text style={styles.footerError}>Accept the terms at the bottom first</Text>
        )}
        <TouchableOpacity
          testID="continue-button"
          style={[styles.continue, !accepted && styles.continueDisabled]}
          onPress={() => {
            if (accepted) {
              setDone(true);
            } else {
              setDecoyTapped(true);
            }
          }}
        >
          <Text style={styles.continueText}>Continue</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 140,
    gap: 12,
  },
  hint: {
    fontSize: 13,
    color: "#666",
  },
  section: {
    gap: 4,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "600",
  },
  sectionBody: {
    fontSize: 14,
    color: "#444",
    lineHeight: 20,
  },
  accept: {
    backgroundColor: "#2a9d2a",
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
  },
  acceptDone: {
    backgroundColor: "#1d7a1d",
  },
  acceptText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: 16,
    paddingBottom: 28,
    backgroundColor: "#fff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#ccc",
    gap: 8,
  },
  footerError: {
    color: "#c00",
    fontSize: 13,
    textAlign: "center",
  },
  continue: {
    backgroundColor: "#111",
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
  },
  continueDisabled: {
    backgroundColor: "#999",
  },
  continueText: {
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
