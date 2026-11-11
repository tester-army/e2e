// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"aa44574c382c5bce70e5e593c1edcb2eddf4892c38ae6a2fb2187d286775b83f","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20context-menu-trap"},
  [
  replay.step(
    {
      "key": "d737be304170b7372163dd61fce8015ac180c44cdc899ac5da795854e17ae3b8",
      "order": 0,
      "variant": {
        "agent": "37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f",
        "project": "6c340b4558007fd12144b6a4e0daf3abb724b92faa2d08705fa564444b68533c",
        "target": "4b5e57f6eb2f42b9039b3d1e13929295f231749c510cbe341cd68036d9af97e2"
      }
    },
    replay.define(
      {
        "endAnchors": [
          {
            "text": "summary.pdf"
          },
          {
            "name": "More actions for summary.pdf",
            "role": "button",
            "text": "⋯"
          },
          {
            "testId": "success-message",
            "text": "File renamed to summary.pdf"
          }
        ],
        "endPath": "/e/context-menu-trap",
        "endWaitMs": 11888,
        "executor": {
          "name": "e2e-default-agent",
          "version": "2"
        },
        "goneAnchors": [
          {
            "text": "report.pdf"
          },
          {
            "name": "More actions for report.pdf",
            "role": "button",
            "text": "⋯"
          }
        ],
        "recordedFor": {
          "agent": "default",
          "callIndex": 0,
          "instructionDigest": "63530e281eafd2d07743a56500bfed3eae14e1ab7a4c0ad00e838e8b51912917",
          "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          "targetId": "web",
          "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20context-menu-trap"
        },
        "startPath": "/e/context-menu-trap",
        "summary": "Renamed report.pdf to summary.pdf. The file manager now lists summary.pdf and shows “File renamed to summary.pdf.”"
      },
      [
        replay.secondaryTap({
          "summary": "secondary-tap node \"report.pdf\"",
          "target": {
            "text": "report.pdf"
          }
        }),
        replay.tap({
          "summary": "tap button \"More actions for report.pdf\"",
          "target": {
            "name": "More actions for report.pdf",
            "role": "button",
            "text": "⋯"
          }
        }),
        replay.tap({
          "summary": "tap button \"Rename\"",
          "target": {
            "name": "Rename",
            "role": "button"
          }
        }),
        replay.type({
          "summary": "type \"summary.pdf\" into textbox \"New file name\"",
          "target": {
            "name": "New file name",
            "role": "textbox"
          },
          "value": "summary.pdf"
        }),
        replay.tap({
          "summary": "tap button \"Save\"",
          "target": {
            "name": "Save",
            "role": "button"
          }
        }),
      ],
    )
  ),
  ],
);
