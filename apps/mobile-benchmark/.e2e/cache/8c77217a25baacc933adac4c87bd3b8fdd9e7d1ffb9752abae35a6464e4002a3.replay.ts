// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Order placed: Medium with Cheese, Olives (rush)",
        "role": "text",
        "testId": "success-message"
      }
    ],
    "endPath": "dev.e2e.benchmark",
    "endWaitMs": 11772,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Order a Medium pizza with exactly Cheese and Olives, enable rush delivery, then place the order (dismiss the keyboard first).",
        "role": "text"
      },
      {
        "name": "Size",
        "role": "text"
      },
      {
        "name": "Small",
        "role": "text"
      },
      {
        "name": "Medium",
        "role": "text"
      },
      {
        "name": "Large",
        "role": "text"
      },
      {
        "name": "Toppings",
        "role": "text"
      },
      {
        "name": "Cheese",
        "role": "text"
      },
      {
        "name": "Olives",
        "role": "text"
      }
    ],
    "keyedBy": {
      "agentContextDigest": "9851c2b004c95e29037ba508c9a81e7efff8fcaa01e5491077154e702520281a",
      "appIdentity": "e18e9835187bab993e11f2dd7ff5624429bc26890c846accacf0057b525e92a0",
      "cacheSchema": "trace-1",
      "engineName": "mobile",
      "engineSpiVersion": 1,
      "platform": "android",
      "policyVersion": "conservative/6",
      "project": "5db668e539f1f8a455eaa798ab239f0cfdc68c99776863db1ddd6f27a9fba643"
    },
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "e45bc3c8dfe206c28355448b56384192428222d9ab9b304cefdfa5b86f6da188",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "android-emulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Choice%20Controls"
    },
    "startPath": "dev.e2e.benchmark",
    "summary": "Selected Medium, enabled Cheese and Olives only, turned on rush delivery, dismissed the keyboard, and placed the order. The screen confirms: “Order placed: Medium with Cheese, Olives (rush).”"
  },
  [
    replay.check({
      "checked": true,
      "summary": "check checkbox \"Cheese\" in \"Order a Medium pizza with exactly Chees…\"",
      "target": {
        "name": "Cheese",
        "role": "checkbox",
        "selector": "id=topping-cheese",
        "testId": "topping-cheese",
        "within": "Order a Medium pizza with exactly Cheese and Olives, enable rush delivery, then…"
      }
    }),
    replay.check({
      "checked": true,
      "summary": "check checkbox \"Olives\" in \"Order a Medium pizza with exactly Chees…\"",
      "target": {
        "name": "Olives",
        "role": "checkbox",
        "selector": "id=topping-olives",
        "testId": "topping-olives",
        "within": "Order a Medium pizza with exactly Cheese and Olives, enable rush delivery, then…"
      }
    }),
    replay.check({
      "checked": true,
      "summary": "check switch \"rush-delivery\" in \"Order a Medium pizza with exactly Chees…\"",
      "target": {
        "role": "switch",
        "selector": "id=rush-delivery",
        "testId": "rush-delivery",
        "within": "Order a Medium pizza with exactly Cheese and Olives, enable rush delivery, then…"
      }
    }),
    replay.tap({
      "summary": "tap radio \"Medium\" in \"Order a Medium pizza with exactly Chees…\"",
      "target": {
        "name": "Medium",
        "role": "radio",
        "selector": "id=size-medium",
        "testId": "size-medium",
        "within": "Order a Medium pizza with exactly Cheese and Olives, enable rush delivery, then…"
      }
    }),
    replay.tap({
      "summary": "tap textbox \"Ring the doorbell twice\" in \"Order a Medium pizza with exactly Chees…\"",
      "target": {
        "name": "Ring the doorbell twice",
        "placeholder": "Ring the doorbell twice",
        "role": "textbox",
        "selector": "id=delivery-notes",
        "testId": "delivery-notes",
        "within": "Order a Medium pizza with exactly Cheese and Olives, enable rush delivery, then…"
      }
    }),
    replay.dismissKeyboard({
      "summary": "dismiss the keyboard"
    }),
    replay.tap({
      "summary": "tap group \"Place order\" in \"Order a Medium pizza with exactly Chees…\"",
      "target": {
        "name": "Place order",
        "role": "group",
        "selector": "id=place-order",
        "testId": "place-order",
        "within": "Order a Medium pizza with exactly Cheese and Olives, enable rush delivery, then…"
      }
    }),
  ],
);
