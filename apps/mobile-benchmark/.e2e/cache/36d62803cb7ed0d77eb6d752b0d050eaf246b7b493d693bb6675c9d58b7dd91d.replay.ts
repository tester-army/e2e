// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
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
);
