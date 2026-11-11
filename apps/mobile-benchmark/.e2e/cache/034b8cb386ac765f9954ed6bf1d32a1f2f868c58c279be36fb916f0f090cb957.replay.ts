// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Logged in successfully",
        "role": "other"
      }
    ],
    "endPath": "dev.e2e.benchmark / Flattened Login",
    "endWaitMs": 14797,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Use tester@tester.army / <secret:benchmark.password>, Email, Password, SIGN IN",
        "role": "other"
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
      "instructionDigest": "2ac57f8c28a31069613ffb9bbf8151a42ea8ceb4bb65d0ad6dcd9eea0b8a2755",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "ios-simulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Flattened%20Login"
    },
    "startPath": "dev.e2e.benchmark / Flattened Login",
    "summary": "Entered the hinted email and password, submitted the login, and verified the screen shows “Logged in successfully.”"
  },
  [
    replay.tapAt({
      "point": {
        "x": 178,
        "y": 450
      },
      "summary": "tap the point (178, 450) on other \"Use tester@tester.army / <secret:benchm…\"",
      "viewport": {
        "height": 874,
        "width": 402
      },
      "within": {
        "fx": 0.4428,
        "fy": 0.4406,
        "target": {
          "name": "Use tester@tester.army / <secret:benchmark.password>, Email, Password, SIGN IN",
          "role": "other"
        }
      }
    }),
    replay.tool({
      "derived": "pixels",
      "summary": "tool type (run-time value)"
    }),
    replay.tapAt({
      "point": {
        "x": 191,
        "y": 532
      },
      "summary": "tap the point (191, 532) on other \"Use tester@tester.army / <secret:benchm…\"",
      "viewport": {
        "height": 874,
        "width": 402
      },
      "within": {
        "fx": 0.4751,
        "fy": 0.5488,
        "target": {
          "name": "Use tester@tester.army / <secret:benchmark.password>, Email, Password, SIGN IN",
          "role": "other"
        }
      }
    }),
    replay.tool({
      "derived": "pixels",
      "summary": "tool type (run-time value)"
    }),
    replay.tapAt({
      "point": {
        "x": 181,
        "y": 533
      },
      "summary": "tap the point (181, 533) on other \"Use tester@tester.army / <secret:benchm…\"",
      "viewport": {
        "height": 874,
        "width": 402
      },
      "within": {
        "fx": 0.4502,
        "fy": 0.5501,
        "target": {
          "name": "Use tester@tester.army / <secret:benchmark.password>, Email, Password, SIGN IN",
          "role": "other"
        }
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
    replay.tapAt({
      "point": {
        "x": 199,
        "y": 596
      },
      "summary": "tap the point (199, 596) on other \"Use tester@tester.army / <secret:benchm…\"",
      "viewport": {
        "height": 874,
        "width": 402
      },
      "within": {
        "fx": 0.495,
        "fy": 0.6332,
        "target": {
          "name": "Use tester@tester.army / <secret:benchmark.password>, Email, Password, SIGN IN",
          "role": "other"
        }
      }
    }),
    replay.tap({
      "summary": "tap button \"Not Now\"",
      "target": {
        "name": "Not Now",
        "role": "button"
      }
    }),
  ],
);
