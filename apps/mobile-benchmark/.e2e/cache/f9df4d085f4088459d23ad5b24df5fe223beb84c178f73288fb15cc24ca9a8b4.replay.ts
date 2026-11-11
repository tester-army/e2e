// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"f9df4d085f4088459d23ad5b24df5fe223beb84c178f73288fb15cc24ca9a8b4","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20Permission%20Prompt"},
  [
  replay.step(
    {
      "key": "f50a29e19e742730567db09904ee11673498a119cb2ef0da68c08ab6834873ec",
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
    )
  ),
  replay.step(
    {
      "key": "c88b3e2074686fa95172580baee395a9efd45c3ce815d8fdfc695293c1f94228",
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
    )
  ),
  ],
);
