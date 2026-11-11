// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Microphone enabled",
        "role": "other"
      },
      {
        "name": "Microphone enabled",
        "role": "text",
        "testId": "success-message"
      }
    ],
    "endPath": "dev.e2e.benchmark / Permission Prompt",
    "endWaitMs": 12356,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Voice notes",
        "role": "text"
      },
      {
        "name": "Recording voice notes requires microphone access. Allow the permission when the system asks.",
        "role": "text"
      },
      {
        "name": "Enable microphone",
        "role": "other",
        "testId": "request-permission"
      },
      {
        "name": "Voice notes",
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
      "instructionDigest": "b0942b32f51f5f05d38db2a1978624dad1187acfb8aca674dbbb09cc9c29ac87",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "ios-simulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Permission%20Prompt"
    },
    "startPath": "dev.e2e.benchmark / Permission Prompt",
    "summary": "Requested microphone access and selected Allow in the system dialog. The app now shows “Microphone enabled.”"
  },
  [
    replay.tap({
      "summary": "tap other \"Enable microphone\"",
      "target": {
        "name": "Enable microphone",
        "role": "other",
        "selector": "id=request-permission",
        "testId": "request-permission"
      }
    }),
    replay.tap({
      "summary": "tap button \"Allow\"",
      "target": {
        "name": "Allow",
        "role": "button"
      }
    }),
  ],
);
