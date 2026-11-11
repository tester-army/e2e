// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"42b2d072bcb69e7ebdcf09ee2787b8813b14021e5a72123127bb8208cd7cd126","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20Sticky%20Chrome%20Target"},
  [
  replay.step(
    {
      "key": "d823e86a70e480e47e0706526de86df9c679a7e4cb8d69ce679bb2632be623f1",
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
            "name": "Terms accepted",
            "role": "text",
            "testId": "success-message"
          }
        ],
        "endPath": "dev.e2e.benchmark",
        "endWaitMs": 11974,
        "executor": {
          "name": "e2e-default-agent",
          "version": "2"
        },
        "goneAnchors": [
          {
            "name": "Read the agreement, tap Accept terms at the bottom, then Continue.",
            "role": "text"
          },
          {
            "name": "Section 1",
            "role": "text"
          },
          {
            "name": "Deterministic agreement paragraph 1 of 14. Nothing in this section is actionable; it only adds scroll distance between the top of the screen and the accept button.",
            "role": "text"
          },
          {
            "name": "Section 2",
            "role": "text"
          },
          {
            "name": "Deterministic agreement paragraph 2 of 14. Nothing in this section is actionable; it only adds scroll distance between the top of the screen and the accept button.",
            "role": "text"
          },
          {
            "name": "Section 3",
            "role": "text"
          },
          {
            "name": "Deterministic agreement paragraph 3 of 14. Nothing in this section is actionable; it only adds scroll distance between the top of the screen and the accept button.",
            "role": "text"
          },
          {
            "name": "Section 4",
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
          "instructionDigest": "c8995bcdba36d775696cf386be302127a69622849b54e095755e2dc908af89bd",
          "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          "targetId": "android-emulator",
          "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Sticky%20Chrome%20Target"
        },
        "startPath": "dev.e2e.benchmark",
        "summary": "Scrolled to and tapped Accept terms, which changed to “Terms accepted ✓”. Tapped Continue; the screen now shows the “Terms accepted” success message."
      },
      [
        replay.scrollUntil({
          "direction": "down",
          "summary": "scroll down until \"Accept terms\" shows (2 screens)",
          "text": "Accept terms"
        }),
        replay.tap({
          "summary": "tap group \"Accept terms\" in \"Deterministic agreement paragraph 8 of …\"",
          "target": {
            "name": "Accept terms",
            "role": "group",
            "selector": "id=accept-terms",
            "testId": "accept-terms",
            "within": "Deterministic agreement paragraph 8 of 14. Nothing in this section is actionabl…"
          }
        }),
        replay.tap({
          "summary": "tap group \"Continue\"",
          "target": {
            "name": "Continue",
            "role": "group",
            "selector": "id=continue-button",
            "testId": "continue-button"
          }
        }),
      ],
    )
  ),
  replay.step(
    {
      "key": "54cafd3addc2fab4dbdf705595e188cbbfb89c56012342ed59d7a7b4dcbb635f",
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
            "name": "Terms accepted",
            "role": "text",
            "testId": "success-message"
          }
        ],
        "endPath": "dev.e2e.benchmark / Sticky Chrome Target",
        "endWaitMs": 12235,
        "executor": {
          "name": "e2e-default-agent",
          "version": "2"
        },
        "goneAnchors": [
          {
            "name": "Vertical scroll bar, 3 pages",
            "role": "other",
            "value": "0%"
          },
          {
            "name": "Horizontal scroll bar, 1 page",
            "role": "other",
            "value": "0%"
          },
          {
            "name": "Continue",
            "role": "other",
            "testId": "continue-button"
          },
          {
            "name": "Read the agreement, tap Accept terms at the bottom, then Continue.",
            "role": "text"
          },
          {
            "name": "Section 1",
            "role": "text"
          },
          {
            "name": "Deterministic agreement paragraph 1 of 14. Nothing in this section is actionable; it only adds scroll distance between the top of the screen and the accept button.",
            "role": "text"
          },
          {
            "name": "Section 2",
            "role": "text"
          },
          {
            "name": "Deterministic agreement paragraph 2 of 14. Nothing in this section is actionable; it only adds scroll distance between the top of the screen and the accept button.",
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
          "instructionDigest": "c8995bcdba36d775696cf386be302127a69622849b54e095755e2dc908af89bd",
          "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          "targetId": "ios-simulator",
          "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Sticky%20Chrome%20Target"
        },
        "startPath": "dev.e2e.benchmark / Sticky Chrome Target",
        "summary": "Accept terms was already selected on the current screen. Tapped Continue in the sticky footer, and the screen now confirms “Terms accepted.”"
      },
      [
        replay.scrollUntil({
          "direction": "down",
          "summary": "scroll down until \"Accept terms\" shows (2 screens)",
          "text": "Accept terms"
        }),
        replay.tap({
          "summary": "tap other \"Accept terms\"",
          "target": {
            "name": "Accept terms",
            "role": "other",
            "selector": "id=accept-terms",
            "testId": "accept-terms"
          }
        }),
        replay.scroll({
          "direction": "down",
          "summary": "scroll down"
        }),
        replay.tap({
          "summary": "tap other \"Continue\"",
          "target": {
            "name": "Continue",
            "role": "other",
            "selector": "id=continue-button",
            "testId": "continue-button"
          }
        }),
      ],
    )
  ),
  ],
);
