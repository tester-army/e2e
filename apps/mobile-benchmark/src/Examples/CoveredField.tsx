import { useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

const FOOTER_HEIGHT = 112;
const FIELD_HEIGHT = 48;
const GAP = 24;
/** How far below the footer's top edge the Brand field starts. */
const BRAND_UNDER_FOOTER = 16;

/**
 * A product form whose Back/Next footer rises with the keyboard and lands on
 * the next field (tester-army/e2e#1324). In an app that happens on some
 * screen and keyboard sizes only; here a spacer sized from the form's
 * measured height pins the Brand field under the footer on any screen, with
 * the keyboard up or down, while Product name stays just above it. The form
 * scrolls, so one swipe brings Brand clear. A tap aimed at Brand's covered
 * centre presses Next, which complains that Brand is empty.
 */
export default function CoveredField() {
  const formRef = useRef<ScrollView>(null);
  const [formHeight, setFormHeight] = useState(0);
  const [product, setProduct] = useState("");
  const [brand, setBrand] = useState("");
  const [price, setPrice] = useState("");
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);

  // The content's gap also falls between the spacer and Product name, so
  // Brand starts at spacer + GAP + FIELD_HEIGHT + GAP.
  const spacer = Math.max(0, formHeight - FOOTER_HEIGHT + BRAND_UNDER_FOOTER - FIELD_HEIGHT - 2 * GAP);

  if (saved) {
    return (
      <View style={styles.successContainer}>
        <Text testID="success-message" style={styles.successText}>
          Saved {product} by {brand}
        </Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <View style={styles.container}>
        <ScrollView
          testID="product-form"
          style={styles.container}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          onLayout={(event) => setFormHeight(event.nativeEvent.layout.height)}
          // The keyboard shrinks the form and Android scrolls it to keep the
          // focused field in view; back to the top keeps Brand pinned.
          onContentSizeChange={() => formRef.current?.scrollTo({ y: 0, animated: false })}
          ref={formRef}
        >
          <View style={{ height: spacer }} />
          <TextInput
            testID="product-name-input"
            placeholder="Product name"
            placeholderTextColor="#777"
            style={styles.input}
            value={product}
            onChangeText={setProduct}
          />
          <TextInput
            testID="brand-input"
            placeholder="Brand"
            placeholderTextColor="#777"
            style={styles.input}
            value={brand}
            onChangeText={setBrand}
          />
          <TextInput
            testID="price-input"
            placeholder="Price"
            placeholderTextColor="#777"
            style={styles.input}
            value={price}
            onChangeText={setPrice}
          />
        </ScrollView>

        <View style={styles.footer}>
          {error && (
            <Text testID="form-error" style={styles.footerError}>
              Fill in Product name and Brand first
            </Text>
          )}
          <View style={styles.footerButtons}>
            <TouchableOpacity
              testID="back-button"
              accessibilityRole="button"
              style={styles.footerButton}
              onPress={() => setError(false)}
            >
              <Text style={styles.footerText}>Back</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="next-button"
              accessibilityRole="button"
              style={[styles.footerButton, styles.next]}
              onPress={() => {
                if (product !== "" && brand !== "") {
                  setSaved(true);
                } else {
                  setError(true);
                }
              }}
            >
              <Text style={styles.footerText}>Next</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: FOOTER_HEIGHT + GAP,
    gap: GAP,
  },
  input: {
    height: FIELD_HEIGHT,
    borderWidth: 1,
    borderColor: "#999",
    borderRadius: 6,
    paddingHorizontal: 12,
    fontSize: 16,
    color: "#000",
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: FOOTER_HEIGHT,
    backgroundColor: "#222",
  },
  footerError: {
    position: "absolute",
    top: -24,
    left: 16,
    color: "#c62828",
    fontSize: 13,
  },
  footerButtons: {
    flex: 1,
    flexDirection: "row",
  },
  footerButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  next: {
    backgroundColor: "#2a5bd7",
  },
  footerText: {
    color: "#fff",
    fontSize: 18,
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
  },
});
