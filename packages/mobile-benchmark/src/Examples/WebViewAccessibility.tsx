import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

const EXPECTED_COUPON = "TA-BENCH-50";

/**
 * Deterministic HTML fixture rendered inside a WebView. The agent has to work
 * through web semantics projected into the native accessibility tree: read the
 * coupon code from the page, fill the web text field with it, toggle the web
 * checkbox, and press the web submit button.
 */
const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: -apple-system, Roboto, sans-serif; margin: 24px; font-size: 18px; }
  h1 { font-size: 24px; }
  label { display: block; margin-top: 16px; }
  input[type="text"] { font-size: 18px; padding: 8px; width: 90%; margin-top: 4px; }
  .checkbox-row { margin-top: 16px; }
  button { font-size: 18px; padding: 12px 24px; margin-top: 24px; }
  .error { color: #b00020; margin-top: 12px; }
</style>
</head>
<body>
  <h1>Checkout coupon</h1>
  <p>Your coupon code is <strong id="coupon">${EXPECTED_COUPON}</strong>.</p>
  <label for="coupon-input">Coupon code</label>
  <input id="coupon-input" type="text" autocomplete="off" autocapitalize="characters" />
  <div class="checkbox-row">
    <input id="terms" type="checkbox" />
    <label for="terms" style="display:inline">I accept the terms</label>
  </div>
  <button id="apply" type="button">Apply coupon</button>
  <p id="feedback" class="error" role="alert"></p>
  <script>
    document.getElementById('apply').addEventListener('click', function () {
      var code = document.getElementById('coupon-input').value.trim();
      var terms = document.getElementById('terms').checked;
      var feedback = document.getElementById('feedback');
      if (code !== '${EXPECTED_COUPON}') {
        feedback.textContent = 'Invalid coupon code';
        return;
      }
      if (!terms) {
        feedback.textContent = 'You must accept the terms';
        return;
      }
      feedback.textContent = '';
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'coupon-applied', code: code }));
    });
  </script>
</body>
</html>`;

export default function WebViewAccessibility() {
  const [applied, setApplied] = useState(false);

  /**
   * Receives the web page's postMessage and flips the native success state
   * once the correct coupon was applied inside the WebView.
   */
  const handleMessage = (event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as { type?: string; code?: string };
      if (message.type === "coupon-applied" && message.code === EXPECTED_COUPON) {
        setApplied(true);
      }
    } catch {
      // Ignore malformed messages; the fixture only sends valid JSON.
    }
  };

  return (
    <View style={styles.flex}>
      <View style={styles.statusBar}>
        {applied ? (
          <Text testID="success-message" style={styles.successText}>
            Coupon applied
          </Text>
        ) : (
          <Text style={styles.hint}>
            Apply the coupon shown inside the web page (accept the terms first)
          </Text>
        )}
      </View>
      <WebView
        testID="coupon-webview"
        originWhitelist={["*"]}
        source={{ html: FIXTURE_HTML }}
        onMessage={handleMessage}
        style={styles.flex}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  statusBar: {
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d0d0d0",
  },
  hint: {
    fontSize: 14,
    color: "#666",
  },
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
  },
});
