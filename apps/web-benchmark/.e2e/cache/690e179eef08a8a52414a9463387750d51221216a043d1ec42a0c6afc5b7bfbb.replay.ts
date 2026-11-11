// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {
    "id": "690e179eef08a8a52414a9463387750d51221216a043d1ec42a0c6afc5b7bfbb",
    "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20hover-menu"
  },
  [
    replay.step(
      {
        "key": "a0db42fa84bc24935c7dcb6fbfa0fec45b392cd144d988f2cda64f97cb7a5b3f",
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
      ),
    ),
  ],
);
