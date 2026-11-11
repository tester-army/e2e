// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "name": "Search playbooks",
        "placeholder": "Search",
        "role": "searchbox",
        "value": "Launch Approval Draft"
      },
      {
        "testId": "success-message",
        "text": "No playbooks match \"Launch Approval Draft\"."
      }
    ],
    "endPath": "/e/playbook-cleanup",
    "endWaitMs": 11698,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "goneAnchors": [
      {
        "name": "Search playbooks",
        "placeholder": "Search",
        "role": "searchbox"
      },
      {
        "name": "NDA Review",
        "role": "heading"
      },
      {
        "text": "8 rules"
      },
      {
        "name": "More actions for NDA Review",
        "role": "button",
        "text": "⋯"
      },
      {
        "name": "Launch Approval Draft",
        "role": "heading"
      },
      {
        "text": "4 rules"
      },
      {
        "name": "More actions for Launch Approval Draft",
        "role": "button",
        "text": "⋯"
      },
      {
        "name": "Vendor Onboarding",
        "role": "heading"
      }
    ],
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "423676dde62142adee61619b5958db96013371bf84519c7e0441aaa32d6f9fce",
      "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "targetId": "web",
      "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20playbook-cleanup"
    },
    "startPath": "/e/playbook-cleanup",
    "summary": "Deleted the playbook “Launch Approval Draft” and confirmed the removal. Searching for its exact name shows: “No playbooks match ‘Launch Approval Draft’.”"
  },
  [
    replay.tap({
      "summary": "tap button \"More actions for Launch Approval Draft\" in \"Launch Approval Draft\"",
      "target": {
        "name": "More actions for Launch Approval Draft",
        "role": "button",
        "text": "⋯",
        "within": "Launch Approval Draft"
      }
    }),
    replay.tap({
      "summary": "tap menuitem \"Delete\" in \"Launch Approval Draft\"",
      "target": {
        "name": "Delete",
        "role": "menuitem",
        "within": "Launch Approval Draft"
      }
    }),
    replay.tap({
      "summary": "tap button \"Remove\" in \"Remove Playbook\"",
      "target": {
        "name": "Remove",
        "role": "button",
        "within": "Remove Playbook"
      }
    }),
    replay.type({
      "summary": "type \"Launch Approval Draft\" into searchbox \"Search playbooks\"",
      "target": {
        "name": "Search playbooks",
        "placeholder": "Search",
        "role": "searchbox"
      },
      "value": "Launch Approval Draft"
    }),
  ],
);
