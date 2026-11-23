[TEST_FAIL]
[REASON] Opened agent QA-20261123-211716-k7es, confirmed it was idle, sent "Hello! What is 2+2?", and checked that the reply contains "4". The reply was correct, but the session header still reads "New Session" after the sidebar renamed the session.
[BUG_FOUND] After the first message, the session header breadcrumb and page title still read "New Session", while the sidebar shows the session as "Basic Arithmetic Question". Expected: the header reflects the session's current title. Actual: the header stays "New Session". This is a minor inconsistency and may be a stale render, but I did not reload to confirm.
[STEP] Step 1: Navigated to http://localhost:47891 — the Gamut home page loaded with the sidebar listing QA-20261123-211717-px3f and QA-20261123-211716-k7es.
[STEP] Step 2: Clicked QA-20261123-211716-k7es in the sidebar — its agent page opened at /agents/qa-20261123-211716-k7es-xks5v79884.
[STEP] Step 3: Checked the agent status — the header shows "idle" and the sidebar shows "Idle". The status is idle, so the check passes. Screenshot taken.
[STEP] Step 4: Typed "Hello! What is 2+2?" into the message box and clicked Send — the app navigated to a new session at /sessions/bb71d943-… and the message appeared in the chat.
[STEP] Step 5: No explicit wait was needed. The reply "2 + 2 = 4." was already present in the message list on the first check after sending.
[STEP] Step 6: Verified the response contains "4" ("2 + 2 = 4.") and took a screenshot. The step passes, but the header naming bug above was seen in the same screenshot.
