[TEST_PASS]
[REASON] Sent "Hello! What is 2+2?" to agent QA-20261122-060535-wun5 and verified the reply contains 4.
[STEP] Navigated to http://localhost:47891 — the Gamut home page loaded with the sidebar listing agents QA-20261122-060536-z1uq and QA-20261122-060535-wun5.
[STEP] Clicked the QA-20261122-060535-wun5 agent in the sidebar — its agent page opened at /agents/qa-20261122-060535-wun5-or4d24z5vj with the new-session composer.
[STEP] Verified agent status — the status indicator in the top bar reads "idle", which is an allowed state.
[STEP] Typed "Hello! What is 2+2?" into the message composer and sent it — the session opened as "Basic Arithmetic Greeting Check", the status changed to "working", and the message appeared in the message list.
[STEP] Waited up to 3 minutes for a response — the reply appeared well within the limit, and the status returned to "idle".
[STEP] Verified the response and took a screenshot — the assistant replied "2 + 2 = 4.", which contains "4". The message list shows the user message followed by this reply.
