---
name: tick
description: Use Tick time tracking to review a timesheet, find project or task budgets, record time, or manage a timer with the Tick CLI.
---

# Tick time tracking

Use `tick tools --json` to discover the installed operations and input schemas. Use `tick account --json` to identify the selected subscription and user. Ask the user to run `tick login` in their terminal if authorization is missing. Browser login grants read access by default. If the user wants to record time or change timers, ask them to run `tick login --allow-writes` and approve the permission in Tick. Restart the MCP server after a new login. Keep credentials out of the conversation.

## Review a week or budget

`tick week --json` returns the selected person's recorded time for the current Monday–Sunday week in the subscription's time zone. For a different period or a team, use the date-range operations. Follow pagination before totaling entries. Preserve the distinction between billable work and entries already marked billed.

`tick projects budget ID --json` and `tick tasks budget ID --json` report recorded hours across people and dates. A negative balance means the budget was exceeded. A null balance means no budget was set. Timers contribute to a budget only after someone records the time.

## Log time and work with timers

Find candidate tasks with `tick tasks recent --json` or `tick tasks search QUERY --json`. Resolve duplicate task names using the client and project. Use the selected task ID when writing.

Read “1:30” as a duration only when the context makes that clear. One hour and thirty minutes is `1h30m` or 1.5 hours. For a draft timesheet, keep proposed entries separate from recorded ones. Use work notes for context and ask for missing durations.

For a request to record 45 minutes, the command shape is `tick log 45m --task-id ID --date YYYY-MM-DD --notes TEXT`. Add `--dry-run` to preview it. Return the saved ID and duration after recording. If a write times out, check the entries or timers before repeating it.

Starting a timer pauses another running timer in the same account. Pausing preserves elapsed time. Saving converts the timer into a recorded entry and removes the timer. Keep “pause” and “log” distinct when interpreting “stop.”
