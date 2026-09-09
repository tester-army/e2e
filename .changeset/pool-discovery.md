---
'@e2edev/agent-device': minor
---

With no `device`, the pool is every booted device of the platform: `prepare` lists the inventory, boots as many as the run has slots, reports the count as the target's worker cap, and hands the devices to the workers through the run environment. Four booted simulators run a target's files four at a time with no config, instead of failing with "Multiple booted iOS simulators have the app installed". A `device` entry that is a simulator UDID is selected as `udid`, as the docs always said.
