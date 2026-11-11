// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"804cf1caf8a6fd0eb889bd112e1402c4dabe45319a1793f99071cbf496048771","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20Flattened%20Login"},
  [
  replay.step(
    {
      "key": "36d62803cb7ed0d77eb6d752b0d050eaf246b7b493d693bb6675c9d58b7dd91d",
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
            "name": "Logged in successfully",
            "role": "text"
          }
        ],
        "endPath": "dev.e2e.benchmark",
        "endWaitMs": 14497,
        "executor": {
          "name": "e2e-default-agent",
          "version": "2"
        },
        "goneAnchors": [
          {
            "name": "Use tester@tester.army / <secret:benchmark.password>",
            "role": "text"
          },
          {
            "name": "Email",
            "role": "text"
          },
          {
            "name": "Password",
            "role": "text"
          },
          {
            "name": "SIGN IN",
            "role": "text"
          },
          {
            "name": "SIGN IN",
            "role": "group"
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
          "instructionDigest": "2ac57f8c28a31069613ffb9bbf8151a42ea8ceb4bb65d0ad6dcd9eea0b8a2755",
          "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          "targetId": "android-emulator",
          "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Flattened%20Login"
        },
        "startPath": "dev.e2e.benchmark",
        "summary": "Used the screenshot hint to log in with tester@tester.army and password <secret:benchmark.password>. The screen confirms “Logged in successfully.”"
      },
      [
        replay.tool({
          "derived": "pixels",
          "summary": "tool type (run-time value)"
        }),
        replay.tool({
          "derived": "pixels",
          "summary": "tool type (run-time value)"
        }),
        replay.tap({
          "summary": "tap group \"SIGN IN\" in \"Use tester@tester.army / <secret:benchm…\"",
          "target": {
            "name": "SIGN IN",
            "role": "group",
            "within": "Use tester@tester.army / <secret:benchmark.password>"
          }
        }),
      ],
    )
  ),
  replay.step(
    {
      "key": "034b8cb386ac765f9954ed6bf1d32a1f2f868c58c279be36fb916f0f090cb957",
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
    )
  ),
  ],
);
