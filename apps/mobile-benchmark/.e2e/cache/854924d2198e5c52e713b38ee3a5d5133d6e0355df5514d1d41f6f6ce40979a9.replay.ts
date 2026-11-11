// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"854924d2198e5c52e713b38ee3a5d5133d6e0355df5514d1d41f6f6ce40979a9","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20Product%20Catalog"},
  [
  replay.step(
    {
      "key": "daf3ae5af4da333cba6ca81767518806f7fb143a4d1d14bb7133008cfdeed82c",
      "order": 0,
      "variant": {
        "agent": "37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f",
        "project": "5db668e539f1f8a455eaa798ab239f0cfdc68c99776863db1ddd6f27a9fba643",
        "target": "a34152a60079722a259a417c0251ad71bf53cd3ef002e7f6c1e465dad98bee2b"
      }
    },
    replay.define(
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
    )
  ),
  replay.step(
    {
      "key": "d8c30c8431ed7a42fcfdbcc80bc83aa3c2137125b25974b9015774f92c9c1343",
      "order": 0,
      "variant": {
        "agent": "37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f",
        "project": "5db668e539f1f8a455eaa798ab239f0cfdc68c99776863db1ddd6f27a9fba643",
        "target": "d34e594487171911acb852c9c20a9b1e42d960b2c08aeb43fe1145049c6f1eed"
      }
    },
    replay.define(
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
    )
  ),
  ],
);
