// e2e replay code-1
import { replay } from 'e2e/replay';

export default replay.define(
  {
    "endAnchors": [
      {
        "testId": "toast",
        "text": "Address saved"
      },
      {
        "text": "{{param:/label}}"
      },
      {
        "name": "{{param:/label}} 7 Pine Way, Bend Delete",
        "role": "listitem",
        "testId": "address-custom-2"
      },
      {
        "text": "7 Pine Way, Bend"
      }
    ],
    "endPath": "/e/saved-addresses",
    "endWaitMs": 12289,
    "executor": {
      "name": "e2e-default-agent",
      "version": "2"
    },
    "recordedFor": {
      "agent": "default",
      "callIndex": 0,
      "instructionDigest": "7e6f99066c5bc180c1e5188150277917670b918eb0a9646ac967ef798648b455",
      "paramsDigest": "49ed432ec36207f5728e4da6da98006ed0d126739d72fdcdb919e032bfd6a511",
      "targetId": "web",
      "testId": "tests-agent/unique-cache.e2e.ts::act%20adds%20an%20address%20with%20a%20run-unique%20label"
    },
    "startPath": "/e/saved-addresses",
    "summary": "Added address labelled “Cabin mutk7a4i” with line “7 Pine Way, Bend”; the new address appears in the list and an “Address saved” confirmation is shown."
  },
  [
    replay.type({
      "summary": "type \"{{param:/label}}\" into textbox \"Label (e.g. Cabin)\"",
      "target": {
        "name": "Label (e.g. Cabin)",
        "placeholder": "Label (e.g. Cabin)",
        "role": "textbox",
        "testId": "label-input"
      },
      "value": "{{param:/label}}"
    }),
    replay.type({
      "summary": "type \"7 Pine Way, Bend\" into textbox \"Street address\"",
      "target": {
        "name": "Street address",
        "placeholder": "Street address",
        "role": "textbox",
        "testId": "line-input"
      },
      "value": "7 Pine Way, Bend"
    }),
    replay.tap({
      "summary": "tap button \"Add address\"",
      "target": {
        "name": "Add address",
        "role": "button",
        "testId": "add-button"
      }
    }),
  ],
);
