---
'e2e': minor
---

`e2e mcp` sessions record video on demand. The catalog gains `start_recording` and `stop_recording` when the engine records video: a coding agent starts a recording once the screen is set up and stops it when the part worth watching is over, and gets back the path of each file under `.e2e/videos/<session>/`, ready to attach to a pull request. `close_session` saves a recording still running, a recording stopped after a secret was filled says the video may show it, and `e2e init` adds `.e2e/videos/` to `.gitignore`. A session no longer records from launch when the config asks for the `video` artifact kind; that kind is for runs.
