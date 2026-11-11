// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "testId": "success-message",
        "text": "Voucher redeemed"
      }
    ],
    "endPath": "/e/hover-menu",
    "endWaitMs": 11468,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "text": "Using hover only, find Redeem voucher under Account."
      },
      {
        "testId": "menu-products",
        "text": "Products"
      },
      {
        "testId": "menu-settings",
        "text": "Settings"
      },
      {
        "testId": "menu-account",
        "text": "Account"
      }
    ],
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "4d2bd092cafaf0bdc40c9442fb592d58283fd7a946e7efb98e1142cffe3c07a3",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "web",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20hover-menu"
    },
    "startPath": "/e/hover-menu",
    "summary": "Hovered Account, then Billing, and selected Redeem voucher. The page confirms “Voucher redeemed.”"
  },
  [
    replay.hover({
      "summary": "hover over node \"Account\"",
      "target": {
        "testId": "menu-account",
        "text": "Account"
      }
    }),
    replay.hover({
      "summary": "hover over node \"Billing ›\"",
      "target": {
        "text": "Billing ›"
      }
    }),
    replay.tap({
      "summary": "tap node \"Redeem voucher\"",
      "target": {
        "text": "Redeem voucher"
      }
    }),
  ],
);
