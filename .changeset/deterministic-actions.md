---
'@e2edev/agent-device': minor
---

Deterministic steps no longer settle. A test's tap, fill, check, or back acts at once and leaves verification to `expect`; only agent actions keep the `settle` window. The one wait that remains is the new `transition` budget (default 500 ms): a control that appeared or moved with the previous action is given that long, counted from the action, to finish arriving, because accessibility frames report a control's final position from the first frame of a transition and a tap at a point it has not reached lands on whatever is behind it. Controls that were already in place are acted on immediately. react-native-pager-view's 11-test suite: 190 s with a 500 ms settle on every action, 142 s with 150 ms, about 125 s with this, all 11 passing.
