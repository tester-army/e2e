# App Store Review Guidelines rubric

Judge against what App Review actually rejects, not against taste. Quote the
on-screen copy that supports a finding; a verdict without a quote is a guess.

## 2.1 App Completeness

Violation: placeholder copy (lorem ipsum, TODO, TBD, "Label", "Title",
template or variable names), images that fail to load, empty containers
where content is clearly expected, screens stuck loading, crashes, or a
technical error shown raw. Reviewers test on restricted networks: an app
that hangs or shows a blank screen offline is a 2.1 stability issue; a clear
offline message or cached content is fine.

## 2.2 Beta Testing and 2.3.10 other platforms

Violation: beta, alpha, demo, test build, trial version, or "not for
release" wording anywhere in the shipped app. Mentions of Android, Google
Play, Windows, or other non-Apple platforms are irrelevant information under
2.3.10; treat them as advisory.

## 5.1.1 Data collection

- (i) A privacy policy link must be reachable inside the app, not only in the
  store listing.
- (ii) A permission alert must say what the app does with the access and how
  the user benefits. "This app needs your location" alone does not explain
  why.
- (iii) and (iv) The app must work when a permission is denied unless the
  data is essential to its core function. A hard wall or repeated nagging
  after denial is a violation; a calm message with a path to Settings is the
  correct handling.
- (v) If the app creates accounts, it must offer account deletion that starts
  in the app. Linking to a web page that completes deletion is acceptable;
  telling users to email or call support is not. An app whose core is not
  account-based should be usable without signing in; sign-in gating is
  advisory unless the app is a thin brochure.

## 4.8 Login Services

Applies only when a third-party login (Google, Facebook, X, Microsoft, and
similar) is offered. Then Sign in with Apple, or another service that limits
data to name and email, lets users hide their email, and does not collect
interactions with the app for advertising without consent, must be offered
too. Email-and-password only, or the developer's own account system, is not
applicable.

## 3.1.1 In-App Purchase and 3.1.2 Subscriptions

Digital goods consumed in the app (subscriptions, premium features, coins,
content unlocks) must go through in-app purchase. Physical goods and
services used outside the app may use other payment methods and are not
applicable. 3.1.3 lists exceptions that are compliant without in-app
purchase: reader apps (magazines, newspapers, books, audio, music, video)
letting users access content bought elsewhere; multiplatform services whose
content or subscriptions were acquired on another platform, as long as they
are also sold in-app; enterprise apps sold directly to organizations;
person-to-person services delivered live one-to-one; and free stand-alone
companions to a paid web tool. Judge one of those as compliant, or
unverified when the category cannot be told from the screen, never as a
violation. Copy steering users to buy elsewhere or noting cheaper prices
elsewhere is a violation outside the storefronts where Apple has granted an
external-link entitlement; report it and let the developer confirm their
entitlement. A subscription paywall must show the price, the billing period,
that it renews automatically until cancelled, and links to Terms of Use and
the Privacy Policy. The full paywall checklist follows below.

## 1.2 User-Generated Content

Applies when the app lets users post or share content, or shows content
posted by other users: feeds, comments, reviews, chat, public profiles, shared
media, even when the current feed is empty. Then the app must filter
objectionable material, offer a way to report content with timely responses,
offer a way to block abusive users, and publish contact information; the
controls may live in a menu or settings screen rather than on each piece of
content. Missing any of the four is a violation.

## 4.2 Minimum Functionality and 4.0 Design

Advisory. A website wrapped in a full-screen web view, or an app that only
presents static information, is rejected under 4.2 when reviewers notice.
Text that is illegible in dark mode or clipped by the notch or home
indicator is a 4.0 design issue reviewers raise inconsistently.

## Subscription paywall checklist (3.1.2)

A compliant auto-renewable subscription offer shows, before the purchase
sheet:

1. The price in the user's currency.
2. The billing period: weekly, monthly, yearly, or the exact length.
3. That the subscription renews automatically unless cancelled at least 24
   hours before the end of the current period.
4. Free trial or introductory terms, when offered: the trial length and the
   price that applies when it ends.
5. A link to the Terms of Use (EULA) and a link to the Privacy Policy.

Common misses reviewers flag:

- A price with no period ("$9.99" with no "per month").
- Trial copy that hides the post-trial price ("Try free" with no follow-up).
- "Cancel anytime" without saying the subscription renews.
- Legal links only in the store listing, not on the paywall.
- A dismiss control that is hidden or delayed; advisory, but noted.
