// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "‹ Back to catalog",
        "role": "text"
      },
      {
        "name": "Cart",
        "role": "text"
      },
      {
        "name": "2 × Trail Mix 500 g",
        "role": "text"
      },
      {
        "name": "Order ready: 2 × Trail Mix 500 g",
        "role": "text",
        "testId": "success-message"
      },
      {
        "name": "‹ Back to catalog",
        "role": "group",
        "testId": "back-to-list"
      }
    ],
    "endPath": "dev.e2e.benchmark",
    "endWaitMs": 11915,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Add exactly 2 × Trail Mix 500 g to the cart, then review the cart",
        "role": "text"
      },
      {
        "name": "Cart (0)",
        "role": "text"
      },
      {
        "name": "Trail Mix",
        "role": "text"
      },
      {
        "name": "250 g · $3.99",
        "role": "text"
      },
      {
        "name": "♡",
        "role": "text"
      },
      {
        "name": "500 g · $6.99",
        "role": "text"
      },
      {
        "name": "1 kg · $11.99",
        "role": "text"
      },
      {
        "name": "Granola",
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
      "instructionDigest": "df6d87ed0275359863ecaf58d94669a7d2b9881afd75c25cb6af7327bb4e052d",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "android-emulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Product%20Catalog"
    },
    "startPath": "dev.e2e.benchmark",
    "summary": "Opened the specific Trail Mix 500 g product, increased quantity to 2, added it to the cart, and opened the cart. The cart shows “2 × Trail Mix 500 g” and “Order ready: 2 × Trail Mix 500 g”."
  },
  [
    replay.tap({
      "summary": "tap group \"Trail Mix, 500 g · $6.99\" in \"Add exactly 2 × Trail Mix 500 g to the …\"",
      "target": {
        "name": "Trail Mix, 500 g · $6.99",
        "role": "group",
        "selector": "id=product-trail-mix-500",
        "testId": "product-trail-mix-500",
        "within": "Add exactly 2 × Trail Mix 500 g to the cart, then review the cart"
      }
    }),
    replay.tap({
      "summary": "tap group \"+\"",
      "target": {
        "name": "+",
        "role": "group",
        "selector": "id=quantity-increase",
        "testId": "quantity-increase"
      }
    }),
    replay.tap({
      "summary": "tap group \"Add to cart\"",
      "target": {
        "name": "Add to cart",
        "role": "group",
        "selector": "id=add-to-cart",
        "testId": "add-to-cart"
      }
    }),
    replay.tap({
      "summary": "tap group \"Cart (2)\" in \"Add exactly 2 × Trail Mix 500 g to the …\"",
      "target": {
        "name": "Cart (2)",
        "role": "group",
        "selector": "id=open-cart",
        "testId": "open-cart",
        "within": "Add exactly 2 × Trail Mix 500 g to the cart, then review the cart"
      }
    }),
  ],
);
