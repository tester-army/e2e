// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
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
);
