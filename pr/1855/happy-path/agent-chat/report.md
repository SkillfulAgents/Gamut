[TEST_FAIL]
[REASON] Ran the 6-step QA check on agent QA-20261124-023403-nmxt: open the agent, confirm idle status, send "Hello! What is 2+2?", wait for a reply, and verify it contains "4". The reply was correct, but the first send needed a button click.
[BUG_FOUND] On the agent's landing page, submitting the first message with Enter did not send it. The text stayed in the composer with no session created. Clicking the Send button then sent it. Action: typed "Hello! What is 2+2?" and submitted with Enter. Expected: message sent and navigation into the new session. Actual: text remained in the input, no navigation, and the Send button was still active until clicked.
[STEP] Step 1 (navigate to http://localhost:47891) — page loaded with the Gamut sidebar listing "QA-20261124-023403-nmxt" (idle), with no errors.
[STEP] Step 2 (click the QA-20261124-023403-nmxt agent in the sidebar) — agent home opened at /agents/qa-20261124-023403-nmxt-3nbny42yh8 with the composer visible.
[STEP] Step 3 (verify status is running or idle) — the status indicator in the top-right reads "idle", so the check passed.
[STEP] Step 4 (send "Hello! What is 2+2?") — typed the message and pressed Enter; it stayed in the composer (see BUG_FOUND). Clicking Send then created a new session "Simple Arithmetic Question Check" and the message appeared in the chat as the first user message.
[STEP] Step 5 (wait up to 3 minutes for a response) — the activity indicator showed "Working..." and cleared after about 30 seconds. The agent's status returned to "idle".
[STEP] Step 6 (verify response mentions "4" and take a screenshot) — the assistant reply "2 + 2 = 4." is shown below the user message. The check passed and a screenshot was taken.
