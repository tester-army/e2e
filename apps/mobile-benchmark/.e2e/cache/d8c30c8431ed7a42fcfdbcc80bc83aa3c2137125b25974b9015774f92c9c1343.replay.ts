// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Cart",
        "role": "text"
      },
      {
        "name": "2 × Trail Mix 500 g",
        "role": "text"
      },
      {
        "name": "‹ Back to catalog",
        "role": "other"
      },
      {
        "name": "Order ready: 2 × Trail Mix 500 g",
        "role": "text",
        "testId": "success-message"
      }
    ],
    "endPath": "dev.e2e.benchmark / Product Catalog",
    "endWaitMs": 12917,
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
        "role": "other",
        "testId": "open-cart"
      },
      {
        "name": "Trail Mix, 250 g · $3.99",
        "role": "other",
        "testId": "product-trail-mix-250"
      },
      {
        "name": "Favorite Trail Mix 250 g",
        "role": "other",
        "testId": "favorite-trail-mix-250"
      },
      {
        "name": "Trail Mix, 500 g · $6.99",
        "role": "other",
        "testId": "product-trail-mix-500"
      },
      {
        "name": "Favorite Trail Mix 500 g",
        "role": "other",
        "testId": "favorite-trail-mix-500"
      },
      {
        "name": "Trail Mix, 1 kg · $11.99",
        "role": "other",
        "testId": "product-trail-mix-1000"
      },
      {
        "name": "Favorite Trail Mix 1 kg",
        "role": "other",
        "testId": "favorite-trail-mix-1000"
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
      "instructionDigest": "df6d87ed0275359863ecaf58d94669a7d2b9881afd75c25cb6af7327bb4e052d",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "ios-simulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Product%20Catalog"
    },
    "startPath": "dev.e2e.benchmark / Product Catalog",
    "summary": "Opened the exact Trail Mix 500 g product, increased its quantity to 2, added it to the cart, and opened the cart. The cart shows “2 × Trail Mix 500 g” and “Order ready: 2 × Trail Mix 500 g”."
  },
  [
    replay.tap({
      "summary": "tap other \"Trail Mix, 500 g · $6.99\"",
      "target": {
        "name": "Trail Mix, 500 g · $6.99",
        "role": "other",
        "selector": "id=product-trail-mix-500",
        "testId": "product-trail-mix-500"
      }
    }),
    replay.tap({
      "summary": "tap other \"+\"",
      "target": {
        "name": "+",
        "role": "other",
        "selector": "id=quantity-increase",
        "testId": "quantity-increase"
      }
    }),
    replay.tap({
      "summary": "tap other \"Add to cart\"",
      "target": {
        "name": "Add to cart",
        "role": "other",
        "selector": "id=add-to-cart",
        "testId": "add-to-cart"
      }
    }),
    replay.tap({
      "summary": "tap other \"Cart (2)\"",
      "target": {
        "name": "Cart (2)",
        "role": "other",
        "selector": "id=open-cart",
        "testId": "open-cart"
      }
    }),
  ],
);
