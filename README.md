# Tick CLI

Use `tick` to review a timesheet, find a client or task, check a budget, record time, or manage a timer. Each operation has a terminal command and a JSON interface for agents. The client talks directly to the [Tick API v2](https://github.com/tick/tick-api).

## Install

Install Node.js 22 or later and npm. From a source checkout:

```sh
git clone https://github.com/tick/tick-cli.git
cd tick-cli
npm install --global .
tick --help
```

You can also run `node bin/tick.js` from the checkout without installing anything. The CLI has no runtime package dependencies.

## Connect a Tick account

```sh
tick login
tick account
```

Browser login requires a Tick server with the OAuth provider deployed. On an older server, use the existing API token login described below.

Tick opens your browser. Choose your subscription and approve read access. If you already have a Tick session in that browser, you can use it. To log time or change timers, run `tick login --allow-writes` and approve the additional permission.

If the browser does not open, follow the URL printed in the terminal. Use `tick login --no-browser` to skip the automatic launch. Open the link on the same computer as the CLI. Over SSH, forward the loopback port shown in the link’s `redirect_uri` to the same port on the remote host.

The CLI saves the selected account and its credentials in `$XDG_CONFIG_HOME/tick/account.json` or `~/.config/tick/account.json` with owner-only permissions. It renews browser credentials automatically. Signing in again revokes the previous saved browser connection before switching to the new account or permissions. When switching API origins, log out at the previous origin first. Run `tick logout` to revoke the saved browser connection and clear its credentials. If Tick cannot confirm revocation, the CLI keeps the file so you can retry.

To sign in with an existing API token, run:

```sh
tick login --subscription-id 123
```

The prompt hides your token. Scripts can pipe it with `--token-stdin`. The existing `tick login --email EMAIL` command also supports a hidden password prompt or `--password-stdin`; use `--subscription-id ID` to select among multiple accounts. Logging out of a legacy account removes the local file. Keep passwords and tokens out of command arguments.

For a script, supply `TICK_SUBSCRIPTION_ID` and `TICK_API_TOKEN` together through its secret store. They override the saved account. Tick identifies regular members through the user list and administrators through their personal timesheet when it contains entries. When an administrator’s week is empty and several people are visible, use browser or email login and unset the token environment overrides before writing personal entries. `TICK_USER_ID` can verify an independently identified account, but supplying an ID alone cannot establish which person owns a token.

## First commands

```sh
tick tasks recent
tick tasks search design --project-id 16
tick week
tick projects budget 16
tick log 45m --task-id 24 --notes "Reviewed the design" --dry-run
tick log 45m --task-id 24 --notes "Reviewed the design"
```

Check the project and task IDs before posting, especially when names repeat. A time entry accepts a positive duration of up to 24 hours, such as `45m`, `1h30m`, or `1.5`. Pass `--date YYYY-MM-DD` to record time for another day. Tick supplies today’s date when you omit it.

| Command | Purpose |
| --- | --- |
| `tick account`, `tick users list` | See the selected account and people visible to your role. |
| `tick clients list`, `tick clients get ID` | Find open, closed or all clients and inspect project summaries. |
| `tick projects list`, `tick projects get ID`, `tick projects budget ID` | Browse projects, get details and check remaining budget. |
| `tick tasks list`, `tick tasks get ID`, `tick tasks recent`, `tick tasks search QUERY`, `tick tasks budget ID` | Find a task and inspect its budget. |
| `tick week`, `tick entries list`, `tick entries get ID` | Review your current week or filter entries visible to your role. |
| `tick report --start-date DATE --end-date DATE` | Total recorded hours across all pages, grouped by day, task, or user. |
| `tick log DURATION --task-id ID`, `tick entries update ID` | Record time or edit your own unbilled entry. |
| `tick timers list`, `tick timers get ID`, `tick timers start TASK_ID`, `tick timers update ID` | Inspect timers, start a new timer, or change its task and notes. |
| `tick timers pause ID`, `tick timers resume ID`, `tick timers save ID` | Pause, resume or turn a timer into a time entry. |

Use `--help` after a command for its arguments. Write commands accept `--dry-run` to print the proposed method, path and payload without contacting Tick. The preview omits fields supplied by Tick or resolved during the live request, such as the logged-in user’s ID. The CLI never automatically retries writes. If the connection drops while recording time, check the timesheet before repeating the command.

### Reports and budgets

```sh
tick entries list --start-date 2026-11-01 --end-date 2026-11-30 --billable true --page 1 --json
tick report --start-date 2026-11-01 --end-date 2026-11-30 --group-by task
tick projects list --include-budget true --json
tick tasks list --project-id 16 --state closed --include-budget true
```

`week` sums the current user’s recorded entries Monday through Sunday in the subscription’s time zone. `entries list` accepts an inclusive date range or `--updated-at` with an ISO timestamp and timezone. Administrators can see other users’ entries in date-range queries. Add `--user-id` to select one person. `report` sums up to 5,000 matching entries. If more match, it asks for a smaller range before reporting a total.

Project and task budgets count all recorded entries across people and dates. Running timers count once saved. A negative balance means over budget; a null balance means no budget was set. Collection pages contain up to 100 records. Pass `--page 2`, then higher numbers, until Tick returns an empty list. Task search reads at most five pages per call and returns `next_page` when more may be available.

### Timers

```sh
tick timers start 24 --notes "Design review"
tick timers list
tick timers pause 7
tick timers resume 7
tick timers save 7
```

Starting, resuming, or retargeting a timer requires an open task on an open project assigned to the signed-in user. An administrator who can see additional projects must still be assigned to the selected project. You can retarget a timer whose previous project has closed.

Use the timer ID returned from `start` for the remaining commands. Starting or resuming a timer pauses the other running timer in that subscription. Pausing keeps the elapsed time. Saving creates an entry dated today in the user’s timezone and removes the timer. Tick's timer response reports accumulated seconds from previous runs and the start of the current run in `last_started_at`.

Timer saves from CLI and MCP processes that share the same OS home directory use one local lock per subscription and timer. If Tick's response is lost or a process stops during conversion, later saves return the lock directory. Before removing this directory, verify that the original process has finished and check both the timer and timesheet in Tick. If the entry already exists, leave it as recorded. If the timer is still present and no entry was recorded, remove only the reported empty directory with `rmdir` and save the timer. Separate devices and OS users cannot share this protection; atomic cross-device conversion requires support from Tick’s API.

## Scripts and AI assistants

```sh
tick tools --json
printf '%s\n' '{"project_id":16}' | tick call get_project_budget --json
printf '%s\n' '{"task_id":24,"duration":"45m","notes":"Planning"}' | tick call log_time --json --dry-run
```

`tools --json` returns the catalog, descriptions, JSON input schemas and tool annotations. `call` accepts exactly one JSON object on stdin. Every operation runs the same validation and Tick API calls as its terminal equivalent. `--json` writes a bare JSON value to stdout on success. On failure, stderr contains `{"error":{"code":"…","message":"…"}}` and the process exits with status 1 for service/configuration errors or 2 for invalid input. Rate-limit errors include `status` and `retry_after` when supplied by Tick.

`tick session --json` returns an opaque local account binding. An integration can pass it in `TICK_EXPECTED_SESSION` on subsequent calls. Browser credentials keep the same binding through automatic renewal. A new browser login, changed legacy token, account switch, or removed profile returns `session_changed` before any Tick API request. Restart the integration to select the current account.

To connect an MCP-compatible assistant, add `https://www.tickspot.com/mcp` as a remote server and authorize the assistant in your browser. Tick hosts the server. You can use it without installing the CLI. The CLI also includes a portable [Tick skill](skills/tick/SKILL.md).

## Development

```sh
npm test
```

Tests run the CLI as a child process against a local fixture. Set `TICK_BASE_URL` for a separate development API origin. HTTPS is required except on loopback, and the client rejects redirects. Production defaults to `https://www.tickspot.com`.
