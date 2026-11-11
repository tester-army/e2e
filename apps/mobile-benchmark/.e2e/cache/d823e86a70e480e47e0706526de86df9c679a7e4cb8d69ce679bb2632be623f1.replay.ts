// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
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
);
