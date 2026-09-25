import type { ComponentType } from "react";
import AriaHiddenFlow from "./Examples/AriaHiddenFlow";
import AsyncStates from "./Examples/AsyncStates";
import CanvasOnly from "./Examples/CanvasOnly";
import CanvasWhiteboard from "./Examples/CanvasWhiteboard";
import CartTotals from "./Examples/CartTotals";
import CheckoutReview from "./Examples/CheckoutReview";
import ContextMenuTrap from "./Examples/ContextMenuTrap";
import ControlInventory from "./Examples/ControlInventory";
import CssContentUi from "./Examples/CssContentUi";
import DatePicker from "./Examples/DatePicker";
import DebouncedSearch from "./Examples/DebouncedSearch";
import DeferredDialog from "./Examples/DeferredDialog";
import DivSoup from "./Examples/DivSoup";
import DragAndDrop from "./Examples/DragAndDrop";
import FileRoundTrip from "./Examples/FileRoundTrip";
import FilterDeepLink from "./Examples/FilterDeepLink";
import GiftCardPurchase from "./Examples/GiftCardPurchase";
import HoverMenu from "./Examples/HoverMenu";
import IframeForm from "./Examples/IframeForm";
import ImageOnlyUi from "./Examples/ImageOnlyUi";
import InfiniteScroll from "./Examples/InfiniteScroll";
import KanbanBoard from "./Examples/KanbanBoard";
import LoginForm from "./Examples/LoginForm";
import LyingLabels from "./Examples/LyingLabels";
import NativeDialogs from "./Examples/NativeDialogs";
import NewsletterSignup from "./Examples/NewsletterSignup";
import NewTabFlow from "./Examples/NewTabFlow";
import OnboardingWizard from "./Examples/OnboardingWizard";
import OrderHistory from "./Examples/OrderHistory";
import OtpAutoAdvance from "./Examples/OtpAutoAdvance";
import OverlayTrap from "./Examples/OverlayTrap";
import PlaybookCleanup from "./Examples/PlaybookCleanup";
import PriceSorting from "./Examples/PriceSorting";
import ProductReviews from "./Examples/ProductReviews";
import PromoStorefront from "./Examples/PromoStorefront";
import RichTextEditor from "./Examples/RichTextEditor";
import SavedAddresses from "./Examples/SavedAddresses";
import ShadowDomForm from "./Examples/ShadowDomForm";
import StaleDom from "./Examples/StaleDom";
import StickyChrome from "./Examples/StickyChrome";
import VirtualizedTable from "./Examples/VirtualizedTable";
import Wishlist from "./Examples/Wishlist";

export type Example = {
  component: ComponentType;
  slug: string;
  name: string;
  description: string;
  /**
   * The intentional product bug a correct test must catch. Present only on
   * bug-book scenarios; never rendered anywhere a test or an agent can read it.
   * Keep slug, name, and description flow-neutral so they do not leak the bug.
   */
  plantedBug?: string;
};

/**
 * Registry of benchmark examples. Two kinds of entries:
 *
 * - Task scenarios: self-contained flows to write tests against; each ends in
 *   a deterministic success state (data-testid "success-message" where the DOM
 *   semantics are intact, on-screen success text where they are deliberately
 *   broken). Add one whenever a hard surface needs permanent coverage.
 * - Bug-book scenarios (plantedBug set): flows with exactly one intentional,
 *   deterministic product bug. A test asserting the correct behavior must fail
 *   here; the rest of the flow works so a pass is a missed bug, not a
 *   blockage. Never "fix" a planted bug.
 */
export const examples: Example[] = [
  {
    component: LoginForm,
    slug: "login-form",
    name: "Login Form",
    description: "Fill credentials, handle validation errors, reach the logged-in state.",
  },
  {
    component: ShadowDomForm,
    slug: "shadow-dom-form",
    name: "Shadow DOM Form",
    description:
      "Fill a form buried in nested open and closed shadow roots where CSS selectors cannot reach.",
  },
  {
    component: CanvasOnly,
    slug: "canvas-only",
    name: "Canvas Only",
    description:
      "Complete a flow rendered entirely on a canvas element - no DOM, pure vision and coordinates.",
  },
  {
    component: CanvasWhiteboard,
    slug: "canvas-whiteboard",
    name: "Canvas Whiteboard",
    description:
      "Drag shapes into matching slots on a Figma-style whiteboard painted entirely on one canvas, then save.",
  },
  {
    component: DivSoup,
    slug: "div-soup",
    name: "Div Soup",
    description:
      "Operate a login built from bare divs with no semantic roles, labels, or test ids.",
  },
  {
    component: AriaHiddenFlow,
    slug: "aria-hidden-flow",
    name: "Aria Hidden Flow",
    description:
      "Complete a plan-selection flow whose entire subtree is aria-hidden - the a11y snapshot is empty.",
  },
  {
    component: ImageOnlyUi,
    slug: "image-only-ui",
    name: "Image Only UI",
    description:
      "Follow instructions rendered as images and click icon-only buttons - zero readable text in the DOM.",
  },
  {
    component: CssContentUi,
    slug: "css-content-ui",
    name: "CSS Content UI",
    description:
      "Operate a flow whose every label comes from CSS pseudo-element content - the DOM is empty divs.",
  },
  {
    component: LyingLabels,
    slug: "lying-labels",
    name: "Lying Labels",
    description:
      "Ignore an accessibility tree that lies - shuffled aria-labels and swapped placeholders; visible text is truth.",
  },
  {
    component: IframeForm,
    slug: "iframe-form",
    name: "Iframe Form",
    description: "Read a code from a nested iframe and submit it through a form in another iframe.",
  },
  {
    component: InfiniteScroll,
    slug: "infinite-scroll",
    name: "Infinite Scroll",
    description:
      "Scroll a paginated feed until a target item deep in the list loads, then claim it.",
  },
  {
    component: VirtualizedTable,
    slug: "virtualized-table",
    name: "Virtualized Table",
    description: "Find a row deep in a windowed table where off-screen rows are never in the DOM.",
  },
  {
    component: OverlayTrap,
    slug: "overlay-trap",
    name: "Overlay Trap",
    description:
      "Dismiss a cookie banner and an invisible click-intercepting overlay before the target button works.",
  },
  {
    component: StickyChrome,
    slug: "sticky-chrome",
    name: "Sticky Chrome",
    description:
      "Scroll a far-down accept button clear of sticky header and footer chrome before clicking it.",
  },
  {
    component: AsyncStates,
    slug: "async-states",
    name: "Async States",
    description:
      "Wait out a skeleton load, catch a transient toast, and submit once the button finally enables.",
  },
  {
    component: DebouncedSearch,
    slug: "debounced-search",
    name: "Debounced Search",
    description:
      "Type into a debounced combobox and pick the target from a portal-rendered listbox.",
  },
  {
    component: HoverMenu,
    slug: "hover-menu",
    name: "Hover Menu",
    description: "Navigate a hover-only nested dropdown menu to reach a buried action.",
  },
  {
    component: ContextMenuTrap,
    slug: "context-menu-trap",
    name: "Context Menu Trap",
    description: "Rename the file report.pdf to summary.pdf in the file manager.",
  },
  {
    component: NativeDialogs,
    slug: "native-dialogs",
    name: "Native Dialogs",
    description: "Handle a chain of native alert, confirm, and prompt dialogs to finish checkout.",
  },
  {
    component: DeferredDialog,
    slug: "deferred-dialog",
    name: "Deferred Dialog",
    description:
      "Accept a confirm dialog that opens on a timer after the click has already settled.",
  },
  {
    component: NewTabFlow,
    slug: "new-tab-flow",
    name: "New Tab Flow",
    description:
      "Open a second tab carrying a verification code, then return and enter it in the original tab.",
  },
  {
    component: DragAndDrop,
    slug: "drag-and-drop",
    name: "Drag and Drop",
    description: "Drag the right items into a dropzone using pointer events in the correct order.",
  },
  {
    component: KanbanBoard,
    slug: "kanban-board",
    name: "Kanban Board",
    description:
      "Move cards across a kanban board driven purely by pointer events with a drag threshold - HTML5 drag events do nothing.",
  },
  {
    component: StaleDom,
    slug: "stale-dom",
    name: "Stale DOM",
    description:
      "Click a target in a list whose nodes are torn down and remounted every second - stale refs break.",
  },
  {
    component: OtpAutoAdvance,
    slug: "otp-auto-advance",
    name: "OTP Auto-Advance",
    description: "Enter a 6-digit code into segmented inputs that auto-advance focus per digit.",
  },
  {
    component: FileRoundTrip,
    slug: "file-round-trip",
    name: "File Round Trip",
    description: "Download a voucher file, then upload the same file back to verify its contents.",
  },
  {
    component: FilterDeepLink,
    slug: "filter-deep-link",
    name: "Filter Deep Link",
    description:
      "Apply a list filter and verify the page URL carries it as a shareable query param.",
  },
  {
    component: DatePicker,
    slug: "date-picker",
    name: "Date Picker",
    description:
      "Navigate a custom calendar widget across months to select an exact required date.",
  },
  {
    component: OnboardingWizard,
    slug: "onboarding-wizard",
    name: "Onboarding Wizard",
    description:
      "Fill a five-step wizard from a brief only visible on step 1 - long-horizon recall across unlabeled fields, custom dropdowns, a hostile date picker, steppers, and trap toggles.",
  },
  {
    component: RichTextEditor,
    slug: "rich-text-editor",
    name: "Rich Text Editor",
    description: "Type into a contenteditable editor and apply bold formatting to an exact phrase.",
  },
  {
    component: PlaybookCleanup,
    slug: "playbook-cleanup",
    name: "Playbook Cleanup",
    description:
      "Delete 'Launch Approval Draft', confirm removal, then search for its exact name to verify it is gone.",
  },
  {
    component: PriceSorting,
    slug: "price-sorting",
    name: "Price Sorting",
    description: "Sort a small product grid by price and check the resulting order.",
    plantedBug:
      "Price sorting compares original prices instead of sale prices, so discounted products land in the wrong position (e.g. the $49 backpack sorts as $120).",
  },
  {
    component: CartTotals,
    slug: "cart-totals",
    name: "Cart Totals",
    description: "Adjust item quantities in a shopping cart and check the order summary math.",
    plantedBug:
      "The order summary is computed once from the initial quantities and never updates - changing a quantity updates the line total but subtotal and order total stay stale.",
  },
  {
    component: CheckoutReview,
    slug: "checkout-review",
    name: "Checkout Review",
    description: "Review a prefilled order summary page and place the order.",
    plantedBug:
      "The greeting shows a raw {{firstName}} template token and the delivery estimate reads 'Arrives by undefined'. Placing the order still works.",
  },
  {
    component: SavedAddresses,
    slug: "saved-addresses",
    name: "Saved Addresses",
    description: "Manage an address book: add a new address and remove a saved one.",
    plantedBug:
      "Deleting an address shows an 'Address deleted' toast but never removes the address from the list, even on retry. Adding addresses works.",
  },
  {
    component: NewsletterSignup,
    slug: "newsletter-signup",
    name: "Newsletter Signup",
    description: "Subscribe to a newsletter and confirm the signup feedback.",
    plantedBug:
      "The Subscribe button's handler crashes (console TypeError) and renders no confirmation or error UI - subscribing is silently impossible.",
  },
  {
    component: OrderHistory,
    slug: "order-history",
    name: "Order History",
    description: "Open the account's orders section and review past orders.",
    plantedBug:
      "The Orders tab is stuck on 'Loading your orders...' forever while Overview and Settings work - a broken feature inside a working app (product bug, not an environment blocker).",
  },
  {
    component: ProductReviews,
    slug: "product-reviews",
    name: "Product Reviews",
    description: "Read a product page and its customer reviews.",
    plantedBug:
      "Every review on the running-shoe page is clearly about a coffee grinder - the wrong product's reviews are wired to the page.",
  },
  {
    component: Wishlist,
    slug: "wishlist",
    name: "Wishlist",
    description: "Save products to a wishlist and check they appear on the wishlist tab.",
    plantedBug:
      "The wishlist tab badge counts saved items correctly, but the tab itself always renders the 'No saved items yet.' empty state - saved products are lost.",
  },
  {
    component: PromoStorefront,
    slug: "promo-storefront",
    name: "Promo Storefront",
    description: "Browse a promo-heavy storefront, handle its overlays, and complete a purchase.",
  },
  {
    component: GiftCardPurchase,
    slug: "gift-card-purchase",
    name: "Gift Card Purchase",
    description: "Pick a gift card amount, enter a recipient, and complete the purchase.",
  },
  {
    component: ControlInventory,
    slug: "control-inventory",
    name: "Control Inventory",
    description:
      "The deterministic contract surface: plain controls with every state exposed, one exercise per agent verb. Not a hard surface.",
  },
];
