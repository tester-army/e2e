// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {
    "id": "e6fc816d4240c92038ef5f5ab5547891efda54705805e9b530104576b3eb74c7",
    "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20gift-card-purchase"
  },
  [
    replay.step(
      {
        "key": "325c3192f76978208e795a9a2afbd9f7a89cd4bcb63640b8fc09c4742e995fe8",
        "order": 0,
        "variant": {
          "agent": "37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f",
          "project": "6c340b4558007fd12144b6a4e0daf3abb724b92faa2d08705fa564444b68533c",
          "target": "4b5e57f6eb2f42b9039b3d1e13929295f231749c510cbe341cd68036d9af97e2"
        }
      },
      replay.define(
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
      ),
    ),
  ],
);
