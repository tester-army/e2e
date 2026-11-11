// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Payment complete: $8.99",
        "role": "text",
        "testId": "success-message"
      }
    ],
    "endPath": "dev.e2e.benchmark / Apple Pay",
    "endWaitMs": 10168,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Buy with Apple Pay",
        "role": "other",
        "testId": "apple-pay-button"
      },
      {
        "name": "Order summary",
        "role": "text"
      },
      {
        "name": "Trail Mix 500 g — $6.99",
        "role": "text"
      },
      {
        "name": "Rush delivery — $2.00",
        "role": "text"
      },
      {
        "name": "Total — $8.99",
        "role": "text"
      }
    ],
    "keyedBy": {
      "agentContextDigest": "9851c2b004c95e29037ba508c9a81e7efff8fcaa01e5491077154e702520281a",
      "appIdentity": "873e96a3c0364ffd8e603a0fb9ccef7bb32dd2c64eb8bddaa76d36fdfbf446ae",
      "cacheSchema": "trace-1",
      "engineName": "mobile",
      "engineSpiVersion": 1,
      "platform": "ios",
      "policyVersion": "conservative/6",
      "project": "5db668e539f1f8a455eaa798ab239f0cfdc68c99776863db1ddd6f27a9fba643"
    },
    "recordedBy": {
      "model": "openai/gpt-6-luna-fast",
      "provider": "gateway"
    },
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "94f39431cf1ce1c380678b2d8ee27fb1e2a33fe296495a90c007ad4dc3f2ae45",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "ios-simulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Apple%20Pay"
    },
    "startPath": "dev.e2e.benchmark / Apple Pay",
    "summary": "The Apple Pay payment completed successfully; the screen shows “Payment complete: $8.99.”"
  },
  [
    replay.tap({
      "summary": "tap other \"Buy with Apple Pay\"",
      "target": {
        "name": "Buy with Apple Pay",
        "role": "other",
        "selector": "id=apple-pay-button",
        "testId": "apple-pay-button"
      }
    }),
    replay.tap({
      "summary": "tap button \"Pay with Passcode\"",
      "target": {
        "name": "Pay with Passcode",
        "role": "button",
        "selector": "id=footer",
        "testId": "footer"
      }
    }),
  ],
);
