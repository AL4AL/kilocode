---
"@kilocode/cli": patch
"kilo-code": patch
---

Stopping the parent chat now cancels spawn_script children still pending or running, including their in-flight model calls.