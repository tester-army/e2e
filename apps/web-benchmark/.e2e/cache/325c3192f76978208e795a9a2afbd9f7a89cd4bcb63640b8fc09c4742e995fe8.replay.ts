// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "testId": "success-message",
        "text": "Gift card sent to friend@example.com"
      },
      {
        "text": "A $25.00 gift card is on its way."
      }
    ],
    "endPath": "/e/gift-card-purchase",
    "endWaitMs": 11710,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "text": "Send a digital gift card. Delivered by email within minutes."
      },
      {
        "name": "gift_card_amount_option_undefined",
        "role": "button",
        "testId": "amount-10",
        "text": "$10"
      },
      {
        "name": "gift_card_amount_option_undefined",
        "role": "button",
        "testId": "amount-25",
        "text": "$25"
      },
      {
        "name": "gift_card_amount_option_undefined",
        "role": "button",
        "testId": "amount-50",
        "text": "$50"
      },
      {
        "name": "{{recipient_email_label}}",
        "placeholder": "friend@example.com",
        "role": "textbox",
        "testId": "recipient-input"
      },
      {
        "text": "Total"
      },
      {
        "text": "Total: $NaN"
      },
      {
        "name": "btn_purchase_label",
        "role": "button",
        "testId": "buy-button",
        "text": "Buy gift card"
      }
    ],
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "58b82e08250d41e942c183d1c49b7e031fb5754f62c785c3f064c404c6b44851",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "web",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20gift-card-purchase"
    },
    "startPath": "/e/gift-card-purchase",
    "summary": "Selected a $25 gift card, entered friend@example.com, and completed the purchase. The page confirms the gift card was sent and says a $25.00 gift card is on its way."
  },
  [
    replay.tap({
      "summary": "tap button \"gift_card_amount_option_undefined\"",
      "target": {
        "name": "gift_card_amount_option_undefined",
        "role": "button",
        "testId": "amount-25",
        "text": "$25"
      }
    }),
    replay.type({
      "summary": "type \"friend@example.com\" into textbox \"{{recipient_email_label}}\"",
      "target": {
        "name": "{{recipient_email_label}}",
        "placeholder": "friend@example.com",
        "role": "textbox",
        "testId": "recipient-input"
      },
      "value": "friend@example.com"
    }),
    replay.tap({
      "summary": "tap button \"btn_purchase_label\"",
      "target": {
        "name": "btn_purchase_label",
        "role": "button",
        "testId": "buy-button",
        "text": "Buy gift card"
      }
    }),
  ],
);
