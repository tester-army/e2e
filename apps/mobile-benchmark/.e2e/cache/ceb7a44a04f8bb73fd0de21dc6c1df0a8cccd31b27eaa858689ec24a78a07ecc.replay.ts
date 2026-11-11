// e2e replay test-1
import { replay } from 'e2e/replay';

export default replay.test(
  {"id":"ceb7a44a04f8bb73fd0de21dc6c1df0a8cccd31b27eaa858689ec24a78a07ecc","testId":"tests-agent/scenarios.e2e.ts::act%20completes%20Debounced%20Search"},
  [
  replay.step(
    {
      "key": "5eff18f221aea74f513d1a35e0d22e6217704e0d5fe3574778155e7d750a9948",
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
            "name": "Selected Benchmark Target",
            "role": "text",
            "testId": "success-message"
          }
        ],
        "endPath": "dev.e2e.benchmark",
        "endWaitMs": 11661,
        "executor": {
          "name": "e2e-default-agent",
          "version": "2"
        },
        "goneAnchors": [
          {
            "name": "Search for and select \"Benchmark Target\"",
            "role": "text"
          },
          {
            "name": "Search…",
            "placeholder": "Search…",
            "role": "textbox",
            "testId": "search-input"
          },
          {
            "role": "group",
            "testId": "search-results"
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
          "instructionDigest": "c212f90679a61041258d6d57a10468462a17a4c9c398605f324169c734daa7f5",
          "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          "targetId": "android-emulator",
          "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Debounced%20Search"
        },
        "startPath": "dev.e2e.benchmark",
        "summary": "Searched for “Benchmark Target,” waited for the result to load, and selected the exact matching result once. The screen confirms “Selected Benchmark Target.”"
      },
      [
        replay.type({
          "summary": "type \"Benchmark Target\" into textbox \"Search…\" in \"Search for and select \\\"Benchmark Target\\\"\"",
          "target": {
            "name": "Search…",
            "placeholder": "Search…",
            "role": "textbox",
            "selector": "id=search-input",
            "testId": "search-input",
            "within": "Search for and select \"Benchmark Target\""
          },
          "value": "Benchmark Target"
        }),
        replay.tap({
          "summary": "tap group \"Benchmark Target\"",
          "target": {
            "name": "Benchmark Target",
            "role": "group",
            "selector": "id=\"result-Benchmark Target\"",
            "testId": "result-Benchmark Target"
          }
        }),
      ],
    )
  ),
  replay.step(
    {
      "key": "7df0802b8a1fd00e85fc85537606ea1ed445e1175357020711139c55c755d169",
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
            "name": "Selected Benchmark Target",
            "role": "other"
          },
          {
            "name": "Selected Benchmark Target",
            "role": "text",
            "testId": "success-message"
          }
        ],
        "endPath": "dev.e2e.benchmark / Debounced Search",
        "endWaitMs": 12017,
        "executor": {
          "name": "e2e-default-agent",
          "version": "2"
        },
        "goneAnchors": [
          {
            "name": "Search for and select \"Benchmark Target\"",
            "role": "text"
          },
          {
            "placeholder": "Search…",
            "role": "textbox",
            "testId": "search-input"
          },
          {
            "name": "Vertical scroll bar, 1 page",
            "role": "other",
            "value": "0%"
          },
          {
            "name": "Horizontal scroll bar, 1 page",
            "role": "other",
            "value": "0%"
          },
          {
            "name": "Search for and select \"Benchmark Target\"",
            "role": "other"
          },
          {
            "name": "Vertical scroll bar, 1 page",
            "role": "other",
            "testId": "search-results"
          },
          {
            "name": "Vertical scroll bar, 1 page",
            "role": "scroll-view"
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
          "instructionDigest": "c212f90679a61041258d6d57a10468462a17a4c9c398605f324169c734daa7f5",
          "paramsDigest": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
          "targetId": "ios-simulator",
          "testId": "tests-agent/scenarios.e2e.ts::act%20completes%20Debounced%20Search"
        },
        "startPath": "dev.e2e.benchmark / Debounced Search",
        "summary": "Searched for “Benchmark Target,” waited for the exact result to load, and selected it once. The screen confirms “Selected Benchmark Target.”"
      },
      [
        replay.tap({
          "summary": "tap textbox \"Search…\"",
          "target": {
            "placeholder": "Search…",
            "role": "textbox",
            "selector": "id=search-input",
            "testId": "search-input"
          }
        }),
        replay.type({
          "summary": "type \"Benchmark Target\" into textbox \"Search…\"",
          "target": {
            "placeholder": "Search…",
            "role": "textbox",
            "selector": "id=search-input",
            "testId": "search-input"
          },
          "value": "Benchmark Target"
        }),
        replay.tap({
          "summary": "tap other \"Benchmark Target\"",
          "target": {
            "name": "Benchmark Target",
            "role": "other",
            "selector": "id=\"result-Benchmark Target\"",
            "testId": "result-Benchmark Target"
          }
        }),
        replay.tap({
          "summary": "tap other \"Benchmark Target\"",
          "target": {
            "name": "Benchmark Target",
            "role": "other",
            "selector": "id=\"result-Benchmark Target\"",
            "testId": "result-Benchmark Target"
          }
        }),
      ],
    )
  ),
  ],
);
