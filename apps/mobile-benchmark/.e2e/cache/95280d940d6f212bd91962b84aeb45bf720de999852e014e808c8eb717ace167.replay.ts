// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Order placed: Medium with Cheese, Olives (rush)",
        "role": "other"
      },
      {
        "name": "Order placed: Medium with Cheese, Olives (rush)",
        "role": "text",
        "testId": "success-message"
      }
    ],
    "endPath": "dev.e2e.benchmark / Choice Controls",
    "endWaitMs": 12243,
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
        "role": "radio",
        "testId": "size-small"
      },
      {
        "name": "Medium",
        "role": "radio",
        "testId": "size-medium"
      },
      {
        "name": "Large",
        "role": "radio",
        "testId": "size-large"
      },
      {
        "name": "Toppings",
        "role": "text"
      },
      {
        "name": "Cheese",
        "role": "checkbox",
        "testId": "topping-cheese"
      },
      {
        "name": "Olives",
        "role": "checkbox",
        "testId": "topping-olives"
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
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "e45bc3c8dfe206c28355448b56384192428222d9ab9b304cefdfa5b86f6da188",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "ios-simulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Choice%20Controls"
    },
    "startPath": "dev.e2e.benchmark / Choice Controls",
    "summary": "Selected Medium, Cheese, and Olives, enabled rush delivery, opened the notes field and dismissed the keyboard, then placed the order. The app confirms: “Order placed: Medium with Cheese, Olives (rush).”"
  },
  [
    replay.check({
      "checked": true,
      "summary": "check checkbox \"Cheese\"",
      "target": {
        "name": "Cheese",
        "role": "checkbox",
        "selector": "id=topping-cheese",
        "testId": "topping-cheese"
      }
    }),
    replay.check({
      "checked": true,
      "summary": "check checkbox \"Olives\"",
      "target": {
        "name": "Olives",
        "role": "checkbox",
        "selector": "id=topping-olives",
        "testId": "topping-olives"
      }
    }),
    replay.check({
      "checked": true,
      "summary": "check switch \"0\"",
      "target": {
        "name": "0",
        "role": "switch",
        "selector": "id=rush-delivery",
        "testId": "rush-delivery"
      }
    }),
    replay.tap({
      "summary": "tap radio \"Medium\"",
      "target": {
        "name": "Medium",
        "role": "radio",
        "selector": "id=size-medium",
        "testId": "size-medium"
      }
    }),
    replay.tap({
      "summary": "tap textbox \"Ring the doorbell twice\"",
      "target": {
        "placeholder": "Ring the doorbell twice",
        "role": "textbox",
        "selector": "id=delivery-notes",
        "testId": "delivery-notes"
      }
    }),
    replay.tap({
      "summary": "tap checkbox \"✓, Mushrooms\"",
      "target": {
        "name": "✓, Mushrooms",
        "role": "checkbox",
        "selector": "id=topping-mushrooms",
        "testId": "topping-mushrooms"
      }
    }),
    replay.tap({
      "summary": "tap button \"return\"",
      "target": {
        "name": "return",
        "role": "button",
        "selector": "id=Return",
        "testId": "Return"
      }
    }),
    replay.tap({
      "summary": "tap other \"Place order\"",
      "target": {
        "name": "Place order",
        "role": "other",
        "selector": "id=place-order",
        "testId": "place-order"
      }
    }),
  ],
);
