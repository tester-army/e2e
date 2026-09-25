import {
  PaymentSheet,
  PaymentSheetError,
  StripeProvider,
  useStripe,
} from "@stripe/stripe-react-native";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";

// This is Stripe's public React Native example backend. It creates disposable
// test-mode customers and PaymentIntents, so the benchmark can exercise the
// real PaymentSheet without embedding a TesterArmy Stripe secret in the app.
const STRIPE_DEMO_API_URL = "https://rigorous-heartbreaking-cephalopod.stripedemos.com";
const RETURN_URL_SCHEME = "e2e-benchmark";

type PaymentSheetBootstrap = {
  customer: string;
  ephemeralKey: string;
  paymentIntent: string;
};

function isPaymentSheetBootstrap(value: unknown): value is PaymentSheetBootstrap {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  return (
    typeof response.customer === "string" &&
    typeof response.ephemeralKey === "string" &&
    typeof response.paymentIntent === "string"
  );
}

function BenchmarkScreen({ children }: { children: ReactNode }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Stripe test payment</Text>
      <Text style={styles.hint}>Complete the payment in Stripe’s native PaymentSheet.</Text>

      <View style={styles.testCard}>
        <Text style={styles.testCardTitle}>Test card details</Text>
        <Text style={styles.testCardLine}>Card: 4242 4242 4242 4242</Text>
        <Text style={styles.testCardLine}>Expiry: 12/34 · CVC: 123</Text>
        <Text style={styles.testCardLine}>Postal code: SW1A 1AA</Text>
      </View>
      {children}
    </View>
  );
}

function PaymentSheetCheckout() {
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const [status, setStatus] = useState<
    "initializing" | "presenting" | "ready" | "success" | "error"
  >("initializing");
  const [message, setMessage] = useState("Preparing Stripe's test checkout…");
  const [initializationAttempt, setInitializationAttempt] = useState(0);

  const showPaymentSheet = async () => {
    setStatus("presenting");
    setMessage("Stripe PaymentSheet is open");
    const result = await presentPaymentSheet();

    if (result.error) {
      if (result.error.code === PaymentSheetError.Canceled) {
        setStatus("ready");
        setMessage("Stripe checkout closed. Open it again when ready.");
      } else {
        setStatus("error");
        setMessage(result.error.localizedMessage ?? result.error.message);
      }
      return;
    }
    if (result.didCancel) {
      setStatus("ready");
      setMessage("Stripe checkout closed. Open it again when ready.");
      return;
    }

    setStatus("success");
    setMessage("Stripe test payment completed");
  };

  useEffect(() => {
    let active = true;

    async function initializeAndPresent() {
      setStatus("initializing");
      setMessage("Preparing Stripe's test checkout…");

      try {
        const response = await fetch(`${STRIPE_DEMO_API_URL}/payment-sheet`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customer_key_type: "legacy_ephemeral_key" }),
        });
        if (!response.ok) {
          throw new Error(`Stripe demo backend returned HTTP ${response.status}`);
        }

        const bootstrap: unknown = await response.json();
        if (!isPaymentSheetBootstrap(bootstrap)) {
          throw new Error("Stripe demo backend returned an unexpected response");
        }

        const initialization = await initPaymentSheet({
          merchantDisplayName: "TesterArmy Benchmark",
          customerId: bootstrap.customer,
          customerEphemeralKeySecret: bootstrap.ephemeralKey,
          paymentIntentClientSecret: bootstrap.paymentIntent,
          allowsDelayedPaymentMethods: false,
          billingDetailsCollectionConfiguration: {
            address: PaymentSheet.AddressCollectionMode.AUTOMATIC,
          },
          defaultBillingDetails: { address: { country: "GB" } },
          link: { display: PaymentSheet.LinkDisplay.NEVER },
          paymentMethodOrder: ["card"],
          returnURL: `${RETURN_URL_SCHEME}://stripe-redirect`,
          style: "alwaysLight",
        });

        if (initialization.error) {
          throw new Error(initialization.error.localizedMessage ?? initialization.error.message);
        }
        if (!active) return;

        setStatus("presenting");
        setMessage("Stripe PaymentSheet is open");
        const presentation = await presentPaymentSheet();
        if (!active) return;

        if (presentation.error) {
          if (presentation.error.code === PaymentSheetError.Canceled) {
            setStatus("ready");
            setMessage("Stripe checkout closed. Open it again when ready.");
          } else {
            setStatus("error");
            setMessage(presentation.error.localizedMessage ?? presentation.error.message);
          }
        } else if (presentation.didCancel) {
          setStatus("ready");
          setMessage("Stripe checkout closed. Open it again when ready.");
        } else {
          setStatus("success");
          setMessage("Stripe test payment completed");
        }
      } catch (error) {
        if (!active) return;
        setStatus("error");
        setMessage(error instanceof Error ? error.message : String(error));
      }
    }

    void initializeAndPresent();
    return () => {
      active = false;
    };
  }, [initPaymentSheet, initializationAttempt, presentPaymentSheet]);

  return (
    <BenchmarkScreen>
      {status === "success" ? (
        <Text testID="success-message" style={styles.successText}>
          Stripe test payment completed
        </Text>
      ) : (
        <Text
          accessibilityRole={status === "error" ? "alert" : undefined}
          style={styles.statusText}
        >
          {message}
        </Text>
      )}

      {(status === "initializing" || status === "presenting") && (
        <ActivityIndicator color="#111" size="small" />
      )}
      {status === "ready" && (
        <TouchableOpacity
          testID="open-stripe-checkout"
          accessibilityRole="button"
          style={styles.payButton}
          onPress={showPaymentSheet}
        >
          <Text style={styles.payButtonText}>Open Stripe checkout</Text>
        </TouchableOpacity>
      )}
      {status === "error" && (
        <TouchableOpacity
          testID="retry-stripe-checkout"
          accessibilityRole="button"
          style={styles.payButton}
          onPress={() => setInitializationAttempt((attempt) => attempt + 1)}
        >
          <Text style={styles.payButtonText}>Retry Stripe checkout</Text>
        </TouchableOpacity>
      )}
    </BenchmarkScreen>
  );
}

export default function StripePaymentSheet() {
  const [publishableKey, setPublishableKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyAttempt, setKeyAttempt] = useState(0);

  useEffect(() => {
    let active = true;

    async function loadPublishableKey() {
      setError(null);
      try {
        const response = await fetch(`${STRIPE_DEMO_API_URL}/stripe-key?paymentMethod=card`);
        if (!response.ok) {
          throw new Error(`Stripe demo backend returned HTTP ${response.status}`);
        }
        const result: unknown = await response.json();
        const key =
          result && typeof result === "object"
            ? (result as Record<string, unknown>).publishableKey
            : undefined;
        if (typeof key !== "string" || !key.startsWith("pk_test_")) {
          throw new Error("Stripe demo backend did not return a test publishable key");
        }
        if (active) setPublishableKey(key);
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    }

    void loadPublishableKey();
    return () => {
      active = false;
    };
  }, [keyAttempt]);

  if (!publishableKey) {
    return (
      <BenchmarkScreen>
        {error ? (
          <>
            <Text accessibilityRole="alert" style={styles.errorText}>
              {error}
            </Text>
            <TouchableOpacity
              testID="retry-stripe-key"
              accessibilityRole="button"
              style={styles.payButton}
              onPress={() => setKeyAttempt((attempt) => attempt + 1)}
            >
              <Text style={styles.payButtonText}>Retry Stripe checkout</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={styles.statusText}>Loading Stripe test mode…</Text>
            <ActivityIndicator color="#111" size="small" />
          </>
        )}
      </BenchmarkScreen>
    );
  }

  return (
    <StripeProvider publishableKey={publishableKey} urlScheme={RETURN_URL_SCHEME}>
      <PaymentSheetCheckout />
    </StripeProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
    gap: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
  },
  hint: {
    color: "#666",
    fontSize: 14,
    textAlign: "center",
  },
  testCard: {
    alignSelf: "stretch",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#d0d0d0",
    borderRadius: 8,
    padding: 16,
    gap: 6,
  },
  testCardTitle: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 2,
  },
  testCardLine: {
    color: "#333",
    fontSize: 15,
  },
  statusText: {
    color: "#666",
    fontSize: 14,
    textAlign: "center",
  },
  errorText: {
    color: "#b00020",
    fontSize: 14,
    textAlign: "center",
  },
  payButton: {
    alignSelf: "stretch",
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
    backgroundColor: "#111",
  },
  payButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  successText: {
    fontSize: 20,
    fontWeight: "600",
    color: "#0a0",
    textAlign: "center",
  },
});
