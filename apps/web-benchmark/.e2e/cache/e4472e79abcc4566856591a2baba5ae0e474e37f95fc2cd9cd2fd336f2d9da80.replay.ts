// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "File state",
        "role": "status",
        "text": "report.pdf renamed to summary.pdf"
      },
      {
        "text": "summary.pdf"
      },
      {
        "name": "summary.pdf",
        "role": "listitem"
      }
    ],
    "endPath": "/e/control-inventory",
    "endWaitMs": 11535,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "File state",
        "role": "status",
        "text": "no menu open"
      },
      {
        "text": "report.pdf"
      },
      {
        "name": "report.pdf",
        "role": "listitem"
      }
    ],
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "cb3da13c69639f87ac80d3bd6fa2b908c9df0bbbda211433bdc779611d4909fe",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "web",
      "testId": "tests-agent/control-inventory.e2e.ts::control%20inventory::a%20right-click%20opens%20the%20file%20menu%20and%20Rename%20renames%20the%20file"
    },
    "startPath": "/e/control-inventory",
    "summary": "Right-clicked report.pdf to open its actions menu, selected Rename, and verified the file list now shows summary.pdf with the status “report.pdf renamed to summary.pdf.”"
  },
  [
    replay.secondaryTap({
      "summary": "secondary-tap listitem \"report.pdf\" in \"Files\"",
      "target": {
        "name": "report.pdf",
        "role": "listitem",
        "within": "Files"
      }
    }),
    replay.secondaryTap({
      "summary": "secondary-tap node \"report.pdf\"",
      "target": {
        "text": "report.pdf"
      }
    }),
    replay.tap({
      "summary": "tap menuitem \"Rename\" in \"report.pdf\"",
      "target": {
        "name": "Rename",
        "role": "menuitem",
        "within": "report.pdf"
      }
    }),
  ],
);
