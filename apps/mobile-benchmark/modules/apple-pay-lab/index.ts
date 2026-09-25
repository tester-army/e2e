import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

export type PaymentSheetOptions = {
  requireBillingAddress?: boolean;
};

export type PaymentSheetResult = {
  status: "authorized" | "dismissed";
  billingPostalCode: string | null;
};

type ApplePayLabModule = {
  canMakePayments(): boolean;
  presentPaymentSheetAsync(options: PaymentSheetOptions): Promise<PaymentSheetResult>;
};

function getModule(): ApplePayLabModule {
  if (Platform.OS !== "ios") {
    throw new Error("Apple Pay is available only on iOS.");
  }
  const nativeModule = requireOptionalNativeModule<ApplePayLabModule>("ApplePayLab");
  if (!nativeModule) {
    throw new Error("Rebuild the iOS app to include the ApplePayLab module.");
  }
  return nativeModule;
}

/**
 * Presents the Apple Pay payment sheet and resolves with the outcome:
 * status "authorized" once the payment is confirmed (with the billing postal
 * code when one was required), or "dismissed" when the sheet is closed
 * without paying.
 */
export async function presentPaymentSheet(
  options: PaymentSheetOptions = {},
): Promise<PaymentSheetResult> {
  return getModule().presentPaymentSheetAsync(options);
}
