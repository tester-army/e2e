import type { ComponentType } from "react";

import ApplePay from "./Examples/ApplePay";
import ApplePayBillingAddress from "./Examples/ApplePayBillingAddress";
import AsyncStates from "./Examples/AsyncStates";
import BottomTabs from "./Examples/BottomTabs";
import BrokenAccessibility from "./Examples/BrokenAccessibility";
import ChoiceControls from "./Examples/ChoiceControls";
import DebouncedSearch from "./Examples/DebouncedSearch";
import ErrorRecovery from "./Examples/ErrorRecovery";
import FlattenedForm from "./Examples/FlattenedForm";
import FlattenedLogin from "./Examples/FlattenedLogin";
import Gestures from "./Examples/Gestures";
import HugeVirtualizedList from "./Examples/HugeVirtualizedList";
import InfiniteScrollList from "./Examples/InfiniteScrollList";
import LoginForm from "./Examples/LoginForm";
import ModalFlow from "./Examples/ModalFlow";
import PermissionPrompt from "./Examples/PermissionPrompt";
import PhotoPicker from "./Examples/PhotoPicker";
import ProductCatalog from "./Examples/ProductCatalog";
import SequentialOnboarding from "./Examples/SequentialOnboarding";
import StickyChrome from "./Examples/StickyChrome";
import StripePaymentSheet from "./Examples/StripePaymentSheet";
import TextInputs from "./Examples/TextInputs";
import VisionOnly from "./Examples/VisionOnly";
import WebViewAccessibility from "./Examples/WebViewAccessibility";

export type Example = {
  component: ComponentType;
  name: string;
  description: string;
  platform?: "ios" | "android";
  screenOptions?: { headerShown?: boolean };
};

/**
 * Registry of benchmark examples. Each entry is a self-contained scenario the
 * QA agent must complete; every scenario ends in a deterministic success state
 * (testID "success-message" where the a11y tree is intact, on-screen success
 * text where it is deliberately broken). Add a new entry here whenever a hard
 * real-world case needs permanent gate coverage.
 */
export const examples: Example[] = [
  {
    component: LoginForm,
    name: "Login Form",
    description: "Fill credentials, handle validation errors, reach the logged-in state.",
  },
  {
    component: InfiniteScrollList,
    name: "Infinite Scroll List",
    description: "Scroll a paginated list until a target item deep in the list is found.",
  },
  {
    component: ModalFlow,
    name: "Modal Flow",
    description: "Open a modal, confirm a native alert, and land on the success state.",
  },
  {
    component: BottomTabs,
    name: "Bottom Tabs",
    description: "Navigate between tabs and complete an action on the last tab.",
    screenOptions: { headerShown: false },
  },
  {
    component: TextInputs,
    name: "Text Input Variations",
    description: "Fill secure, multiline, and numeric inputs to unlock the submit button.",
  },
  {
    component: BrokenAccessibility,
    name: "Broken Accessibility",
    description:
      "Whole screen merged into one a11y node (accessible=true) — snapshot is useless, vision required.",
  },
  {
    component: VisionOnly,
    name: "Vision Only",
    description:
      "A11y tree fully hidden like a canvas-rendered (Flutter-style) app — pure pixel-driven flow.",
  },
  {
    component: Gestures,
    name: "Gestures",
    description: "Long-press, swipe left, and double-tap targets in sequence.",
  },
  {
    component: AsyncStates,
    name: "Async States",
    description: "Wait out a loading screen, pull to refresh, and catch a transient toast.",
  },
  {
    component: DebouncedSearch,
    name: "Debounced Search",
    description: "Type into a debounced search field, wait for async results, select the target.",
  },
  {
    component: HugeVirtualizedList,
    name: "Huge Virtualized List",
    description:
      "600 preloaded virtualized rows — the target sits ~28,000px down and off-screen rows never enter the a11y tree, so the agent must size long scroll jumps from the scroll extent.",
  },
  {
    component: FlattenedForm,
    name: "Flattened Registration Form",
    description:
      "Multi-field registration form merged into one a11y node (accessible=true) — fields must be focused from vision and typed into via focused typing.",
  },
  {
    component: FlattenedLogin,
    name: "Flattened Login",
    description:
      "Login form merged into one a11y node (accessible=true) - credentials must be filled from vision via focused fill, success visible only in pixels.",
  },
  {
    component: StickyChrome,
    name: "Sticky Chrome Target",
    description:
      "Accept button ~3 screens down in a non-virtualized scroll (present as an off-screen ref) under a sticky footer — tapping it must scroll it clear of the footer.",
  },
  {
    component: WebViewAccessibility,
    name: "WebView Accessibility",
    description:
      "Read a coupon code inside a WebView, fill the web form, accept the terms, and apply it.",
  },
  {
    component: PermissionPrompt,
    name: "Permission Prompt",
    description:
      "Trigger the microphone permission request and handle the OS dialog to reach the granted state.",
  },
  {
    component: PhotoPicker,
    name: "Photo Picker",
    description:
      "Open the system photo picker (outside the app a11y tree), select the seeded receipt photo, land back with it attached.",
  },
  {
    component: ProductCatalog,
    name: "Product Catalog",
    description:
      "Disambiguate near-identical cards, drill into Trail Mix 500 g, set quantity 2, add to cart, review it.",
  },
  {
    component: ErrorRecovery,
    name: "Error Recovery",
    description:
      "Recover from a failed load via retry, then delete a draft through a destructive-confirm modal.",
  },
  {
    component: ChoiceControls,
    name: "Choice Controls",
    description:
      "Select the exact size, toppings, and switch combination, dismiss the keyboard, place the order.",
  },
  {
    component: StripePaymentSheet,
    name: "Stripe PaymentSheet",
    description:
      "Complete Stripe's SDK-provided test-mode PaymentSheet while native focus, keyboard, and field refs shift.",
  },
  {
    component: SequentialOnboarding,
    name: "Sequential Onboarding",
    description:
      "Multi-step signup wizard where each step auto-focuses a field, so the keyboard covers the Continue button (and the second name field) from the moment the screen opens — occluded taps land on keyboard keys and corrupt the values, and the success screen echoes them exactly.",
  },
  {
    component: ApplePay,
    name: "Apple Pay",
    description:
      "Start an Apple Pay payment and authorize it inside the out-of-process PassKit sheet.",
    platform: "ios",
  },
  {
    component: ApplePayBillingAddress,
    name: "Apple Pay Billing Address",
    description:
      "PassKit requires a billing address before authorizing — fill the in-sheet address form from vision, then pay.",
    platform: "ios",
  },
];
