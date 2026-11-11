// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Microphone enabled",
        "role": "text",
        "testId": "success-message"
      }
    ],
    "endPath": "dev.e2e.benchmark",
    "endWaitMs": 11500,
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
        "role": "text"
      },
      {
        "name": "Enable microphone",
        "role": "group",
        "testId": "request-permission"
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
      "instructionDigest": "b0942b32f51f5f05d38db2a1978624dad1187acfb8aca674dbbb09cc9c29ac87",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "android-emulator",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Permission%20Prompt"
    },
    "startPath": "dev.e2e.benchmark",
    "summary": "Requested microphone access and allowed it using “While using the app” in the system dialog. The app now displays “Microphone enabled.”"
  },
  [
    replay.tap({
      "summary": "tap group \"Enable microphone\" in \"Voice notes\"",
      "target": {
        "name": "Enable microphone",
        "role": "group",
        "selector": "id=request-permission",
        "testId": "request-permission",
        "within": "Voice notes"
      }
    }),
    replay.tap({
      "summary": "tap button \"While using the app\"",
      "target": {
        "name": "While using the app",
        "role": "button",
        "selector": "id=com.android.permissioncontroller:id/permission_allow_foreground_only_button",
        "testId": "com.android.permissioncontroller:id/permission_allow_foreground_only_button"
      }
    }),
  ],
);
