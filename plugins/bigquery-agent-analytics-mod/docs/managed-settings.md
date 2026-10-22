# Turn the mod on for a team with managed settings

For the administrator who deploys the host CLI's managed settings. One
policy file turns the mod on for everyone who gets it, writing to one
BigQuery table, with options people cannot change.

What a policy does not do:

- **It provisions no credentials.** Each person still installs the Google
  Cloud CLI and signs in once (see [What each person needs](#3-what-each-person-needs)).
- **It cannot enforce capture on a machine its user controls.** Safe mode,
  bare mode, other tools and administrator rights on the machine all get
  around it (see [What a person can and cannot change](#4-what-a-person-can-and-cannot-change)).
- **It does not make attribution proof.** `user_id` is what the machine
  says.

## Before it goes beyond a pilot

Do not deliver the policy to more than a pilot group until each of these is
in place:

1. **The access model** of [service-account auth](service-account-auth.md):
   a writer service account that may only insert rows, readers who see only
   the views, and the project's Viewer and Editor groups off the datasets.
2. **A data-handling sign-off** with a named owner
   ([Data-handling sign-off](#9-data-handling-sign-off)).
3. **Named owners** for the policy: who edits it, who approves a change,
   who delivers it (your device management), and who moves the pinned
   version of the mod.
4. **A pilot plan** with entry and exit criteria
   ([Roll out in stages](#7-roll-out-in-stages)).

## Choose the tier

| | A folder your device management deploys (recommended) | The GitHub marketplace, pinned to a tag |
| --- | --- | --- |
| How the mod runs | As your organization's (`tier prepend` in the debug log) | As a mod the person installed (`tier user`, "not read in place from a local folder") |
| A fresh machine records | From its first session | From its second or third session, or from the first after one install from the pinned source |
| Under `allowManagedModsOnly` | Loads | Refused |
| Under `allowManagedHooksOnly` | Loads | Not loaded |
| A person's `enabledPlugins` false, or `plugin uninstall` | No effect | No effect |
| Session-start rows and permission-prompt flags | Recorded | Not recorded, and subagent starts are inferred: on a managed machine those events pass over a mod in the user tier (the README's Limitations) |
| What you deliver | A folder and the policy | The policy only |
| The version | The archive you copied, checked by its checksum | A tag, with `autoUpdate` off |

Choose the folder wherever your device management can deliver files. With
GitHub, every tag you deploy needs a version of its own, and each move to a
new tag takes two commands on every machine
([§6](#6-without-a-folder-the-github-marketplace-pinned)).

## 1. The marketplace folder

Put the folder on every machine at the same absolute path, owned by an
administrator and writable by nobody else (the folder and every folder
above it):

```text
/opt/org/agent-plugins/
├── .claude-plugin/marketplace.json
└── plugins/bigquery-agent-analytics-mod/
```

`marketplace.json`:

```json
{
  "name": "org-tools",
  "owner": { "name": "Example Org" },
  "plugins": [
    { "name": "bigquery-agent-analytics-mod", "source": "./plugins/bigquery-agent-analytics-mod" }
  ]
}
```

Copy the mod from a commit you reviewed, as an archive with a checksum, so
every machine runs the same files:

```bash
# Once, from a checkout of this repository, at the commit you reviewed:
git archive --format=tar.gz -o bqaa-mod-COMMIT.tar.gz COMMIT plugins/bigquery-agent-analytics-mod
shasum -a 256 bqaa-mod-COMMIT.tar.gz    # record it with the commit
# On each machine, by device management, after checking the checksum:
tar -xzf bqaa-mod-COMMIT.tar.gz --strip-components=1 -C /opt/org/agent-plugins/plugins
```

A new version is a new archive, reviewed and approved the same way, given
to the pilot group first.

## 2. The policy

The host CLI reads managed settings from a file per machine:

- Linux and WSL: `/etc/claude-code/managed-settings.json` (checked)
- macOS: `/Library/Application Support/ClaudeCode/managed-settings.json`
  (not checked here)
- Windows: `C:\Program Files\ClaudeCode\managed-settings.json` (not checked
  here)

**Put the mod's entries in a drop-in of their own**, in a
`managed-settings.d/` folder beside that file:
`/etc/claude-code/managed-settings.d/50-bqaa-mod.json`. It merges with the
file your organization may already deliver, so nothing there is replaced
(checked: an existing file's `env` still reached the session beside the
drop-in), and a rollback swaps or deletes one file.

**Where the machine also gets policy from the host's admin console or a
device-management profile**, the host by default reads only the
highest-ranked managed source that holds any setting, and skips the others
(`managedSourcesBehavior: "first-wins"`), while `env` is merged variable by
variable across all of them. The plugin entries in a skipped file are then
ignored (the mod does not load, and the earlier ids stay on), but its `env`
pins still reach any copy a person installed. So put the entries in the
source your organization already uses, or set
`managedSourcesBehavior: "merge"` in the highest-ranked one. In an
interactive session, `/status` names the sources in effect ("Setting
sources") and those skipped ("Skipped sources"). Not checked here: the
container has only the file source, and `/status` needs an interactive
session.

The complete policy for the folder. Set every option: an option the policy
leaves out is the person's (their own value, or the environment's).

```json
{
  "extraKnownMarketplaces": {
    "org-tools": { "source": { "source": "directory", "path": "/opt/org/agent-plugins" } }
  },
  "enabledPlugins": {
    "bigquery-agent-analytics-mod@org-tools": true,
    "bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin": false,
    "bigquery-agent-analytics-tracing@bigquery-agent-analytics-plugin": false,
    "bigquery-agent-analytics-tracing@bqaa-tracing": false
  },
  "pluginConfigs": {
    "bigquery-agent-analytics-mod@org-tools": {
      "options": {
        "project": "my-gcp-project",
        "dataset": "agent_analytics",
        "table": "agent_events",
        "location": "US",
        "enabled": true,
        "dryRun": false,
        "accessTokenCommand": "/opt/org/bin/bqaa-token",
        "deadLetterDir": "",
        "agentName": "coding-agent",
        "maxPayloadChars": 16384,
        "flushIntervalMs": 5000,
        "userIdFromCredentials": false,
        "recordHostname": false
      }
    }
  },
  "env": {
    "BQAA_TRACE_ENABLED": "true",
    "BQAA_DRY_RUN": "false",
    "BQAA_ACCESS_TOKEN": "",
    "BQAA_DEAD_LETTER_DIR": "",
    "BQAA_USER_ID": "",
    "BQAA_AUTO_CREATE_TABLE": "false",
    "BQAA_AUTO_BACKFILL": "true"
  }
}
```

| Entry | What it does |
| --- | --- |
| `extraKnownMarketplaces` | Names the folder that holds the marketplace |
| `enabledPlugins` | Turns the mod on for everyone who gets the policy, and turns off the earlier ways in: the mod under its old marketplace id, and the settings-hook tracer from either marketplace (see [Moving from the settings-hook tracer](#5-moving-from-the-settings-hook-tracer-or-an-earlier-install)). A `false` here also refuses a new install of that plugin |
| `options.project`, `dataset`, `table`, `location` | The destination. The person's own options, a `--settings` file and `BQAA_PROJECT_ID`, `BQAA_DATASET`, `BQAA_TABLE` or `BQ_TABLE` in their shell or a repository's settings change nothing |
| `options.enabled`, `dryRun` and `env` `BQAA_TRACE_ENABLED`, `BQAA_DRY_RUN` | Capture on, and rows really sent. These two switches also read the environment: without the `env` pins, a shell or a repository's settings turn capture off or a dry run on |
| `options.accessTokenCommand` and `env` `BQAA_ACCESS_TOKEN: ""` | How tokens are had: the wrapper below, which impersonates the writer service account with a clean environment. No token from the environment instead |
| `options.deadLetterDir: ""` and `env` `BQAA_DEAD_LETTER_DIR: ""` | Rows that wait stay in each person's home folder (`~/.bqaa-mod/dead-letter`), not in a folder the person, a `--settings` file or a repository's settings name (a repository could otherwise put them in its working tree, where a commit could take them). A pinned `~/...` would not be expanded, hence the empty value |
| `options.agentName`, `maxPayloadChars`, `flushIntervalMs` | The `agent` column, how much of each payload is kept, and how often rows are sent |
| `options.userIdFromCredentials: false` and `env` `BQAA_USER_ID: ""` | `user_id` is each person's login name. Under impersonation, `userIdFromCredentials` would make every row's `user_id` the service account |
| `options.recordHostname: false` | No machine names in the rows |
| `env` `BQAA_AUTO_CREATE_TABLE: "false"` | People's credentials never try to create the table: `setup.sh` made it |
| `env` `BQAA_AUTO_BACKFILL: "true"` | Rows that waited are sent at session start once tokens work |

Left to each person, as they change when rows are sent and not where:
`BQAA_REQUEST_TIMEOUT_MS`, `BQAA_MAX_QUEUE_ROWS` and `BQAA_EXIT_FLUSH_MS`.

**The token command, as an admin-owned wrapper.** The mod runs the token
command itself, at session start, with the session's environment, and a
trusted repository's settings `env` is part of it. When this guide was
checked, a repository's `CLOUDSDK_PYTHON`, `CLOUDSDK_CONFIG`,
`CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE`, `HTTPS_PROXY`, `PYTHONPATH` and `PATH`
all reached it, so a repository could choose the interpreter gcloud runs,
or route its traffic through a proxy. Deliver this script with the folder,
owned by an administrator, mode 755, and name it in `accessTokenCommand`:

```sh
#!/bin/sh
# /opt/org/bin/bqaa-token: the mod's token command, with a clean environment.
PATH=/usr/bin:/bin
export PATH
unset LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH
user=$(/usr/bin/id -un)
home=$(eval echo "~$user")
exec /usr/bin/env -i HOME="$home" PATH=/usr/bin:/bin \
  /usr/bin/gcloud auth print-access-token \
  --impersonate-service-account=bqaa-row-writer@my-gcp-project.iam.gserviceaccount.com
```

Use gcloud's absolute path on your machines, and a `PATH` that holds the
Python it needs. Checked: in the container, the command behind it got only
`HOME`, `PATH` and `PWD`; on macOS, it printed a token with
`CLOUDSDK_PYTHON` and a proxy set in the environment, where gcloud without
it tried to start the named interpreter.

If you cannot deliver the script, use the token command in
[§6](#6-without-a-folder-the-github-marketplace-pinned), which needs no
file and clears the environment itself. Pinning variables in `env` instead
covers only the ones you name, while gcloud reads many more (`CLOUDSDK_*`
holds its account, proxy and token-file settings, among others). Pinned to
`""`, `CLOUDSDK_PYTHON`, `CLOUDSDK_PYTHON_ARGS`,
`CLOUDSDK_CONFIG`, `HTTPS_PROXY`, `HTTP_PROXY` and `PYTHONPATH` reached the
command empty, and gcloud still printed a token with each.
`CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE` cannot be pinned that way: empty, gcloud
refuses to run ("The provided path must exist"). Pins apply to every process
a session starts, the person's own gcloud commands included.

To check a machine: `claude -p /bqaa-status` (no model call) prints
`enabled, target my-gcp-project.agent_analytics.agent_events (US)`, and
`claude -p --debug-file /tmp/bqaa.log /bqaa-status` leaves
`hooks module bigquery-agent-analytics-mod@org-tools loaded (... tier prepend)`
in the log. In an interactive session, `/status` shows which managed
sources are in effect, as above.

## 3. What each person needs

- **The Google Cloud CLI, signed in once** as themselves
  (`gcloud auth login`), and membership of the group allowed to impersonate
  the writer ([service-account auth](service-account-auth.md)). The policy
  cannot sign anyone in. Until they do, their sessions show "no working
  Google credentials" and keep rows on disk.
- **gcloud at the path the policy names.** Install it at the same path on
  every machine, or deliver a policy per platform.
- **A tested host CLI.** This guide was checked with host CLI 2.1.304.
- **Windows: not checked.** The token command runs with no shell, and
  gcloud on Windows is a `.cmd` script, which may not start that way.

The network the mod and its token command reach:

| Host | For |
| --- | --- |
| `bigquery.googleapis.com` | Inserting rows |
| `iamcredentials.googleapis.com` | Impersonated tokens |
| `oauth2.googleapis.com` | gcloud's token refresh, and the account lookup of `userIdFromCredentials` |
| `accounts.google.com` | The one-time `gcloud auth login` |
| `github.com` | The GitHub variant only: fetching the marketplace |

## 4. What a person can and cannot change

What each person can try, with the folder policy above; each row is a
check in [`tests/managed-settings.live.sh`](../tests/managed-settings.live.sh):

| A person who... | Result |
| --- | --- |
| Sets their own options or uses a `--settings` file (another dataset or table, capture off, a dry run, a folder, an agent name, the identity options, another token command) | No effect |
| Sets `BQAA_*` variables in their shell or a repository's settings | No effect on the pinned ones |
| Sets `enabledPlugins` false, or runs `claude plugin disable` or `claude plugin uninstall` (with or without `--scope managed`) | No effect: the uninstall is refused |
| Starts the host with `--safe-mode`, `CLAUDE_CODE_SAFE_MODE=1` or `--bare` | No plugin loads, yours included: that session records nothing |
| Sets `USER` in their shell or a repository's settings | `user_id` changes: the login name is what the machine says |
| Works in a repository whose settings set gcloud's variables (`CLOUDSDK_PYTHON`, `CLOUDSDK_CONFIG`, a proxy, a CA file) | They reach the token command unless it is the wrapper, or §6's `env -i` command; through the wrapper, gcloud gets only `HOME` and `PATH`, and through the command, only `PATH` |
| Works in a repository whose settings set `LD_PRELOAD` or `PATH` | They reach every process the session starts, the wrapper's own shell (or `env` itself) included. No setting here prevents it: trust repositories accordingly |
| Uses another tool, or edits the policy with administrator rights on the machine | Not covered by a policy |
| Inserts rows of their own with the writer's tokens | Possible ([service-account auth](service-account-auth.md)) |

Capture cannot be fully enforced on a machine its user controls. Treat the
table as a record of the sessions that ran with the mod, not of all of
them.

**To let people opt out**, leave `enabled` and `BQAA_TRACE_ENABLED` out of
the policy: their own `enabled: false` (`/plugin configure`) or a shell's
`BQAA_TRACE_ENABLED=false` then turns capture off (checked: without the
`env` pins, the shell turns it off).

**Fleet-wide locks**, which apply to every plugin, not just this one:

- `allowManagedModsOnly`, an option of the built-in security plugin:
  `"pluginConfigs": { "cc-plugin-sec-default@builtin": { "options": { "allowManagedModsOnly": true } } }`.
  Mods load only from your organization: the folder mod loads, a copy from
  GitHub is refused. Settings hooks still run.
- `"allowManagedHooksOnly": true`: only managed plugins' hooks run. The
  folder mod loads; a copy from GitHub, people's own plugins and the hooks
  in their settings files do not. A repository's settings `env` still
  reaches the session, the token command included.

## 5. Moving from the settings-hook tracer or an earlier install

People who used the settings-hook tracer, or installed the mod from the
GitHub marketplace, keep that install when the policy arrives. Checked in a
container:

- **The tracer keeps writing** beside the mod (every event twice) until the
  policy turns it off. `allowManagedModsOnly` does not stop it.
- **With its id `false` in `enabledPlugins`** (as in the policy above) it
  runs no hook, and a new install of it is refused. So does
  `allowManagedHooksOnly`, for every person's plugins.
- **The mod under its old id** never loads beside your organization's ("another
  plugin of that name loads first"). The policy turns it off anyway, for a
  machine without the folder.

The settings-hook recipe from the earlier guide (hooks pasted into a
person's own `settings.json`) has no plugin id to turn off: ask people to
remove it, or set `allowManagedHooksOnly`. To find people still writing
twice, see the query in [Roll out in stages](#7-roll-out-in-stages).

The policy's `env` pins (`BQAA_TRACE_ENABLED: "true"`, `BQAA_DRY_RUN:
"false"`) also reach a copy of either settings-hook tracer that its `false`
ids do not stop: one loaded with `--plugin-dir`, installed from a release
archive, or listed by another catalog. Both tracers read those
variables, so a copy someone had silenced with `BQAA_TRACE_ENABLED=false`
writes again. Remove such copies, or set `allowManagedHooksOnly`.

## 6. Without a folder: the GitHub marketplace, pinned

Where you can deliver settings but not files, name the GitHub marketplace,
pinned to a tag, with `autoUpdate` off. Every option and pin is as in the
folder policy except the token command. The wrapper in
[The policy](#2-the-policy) is a file this variant cannot deliver, and with
`accessTokenCommand` set, the mod tries no other command. So name one that
needs no file and clears the environment itself:

```json
{
  "extraKnownMarketplaces": {
    "bigquery-agent-analytics-plugin": {
      "source": { "source": "github", "repo": "haiyuan-eng-google/bigquery_agent_analytics_skill", "ref": "TAG" },
      "autoUpdate": false
    }
  },
  "enabledPlugins": {
    "bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin": true,
    "bigquery-agent-analytics-tracing@bigquery-agent-analytics-plugin": false,
    "bigquery-agent-analytics-tracing@bqaa-tracing": false
  },
  "pluginConfigs": {
    "bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin": {
      "options": {
        "...": "every other option, as in the folder policy",
        "accessTokenCommand": "/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/gcloud auth print-access-token --impersonate-service-account=bqaa-row-writer@my-gcp-project.iam.gserviceaccount.com"
      }
    }
  },
  "env": { "...": "the same pins as the folder policy" }
}
```

The mod splits that line itself and runs it with no shell, so `env -i`
starts gcloud with only `PATH`, and a repository's settings `env` does not
reach it. With no `HOME`, gcloud finds the person's configuration through
their account's home folder. As with the wrapper, use gcloud's absolute
path on your machines, and a `PATH` that holds the Python it needs.
Checked:

- In the container, a stand-in gcloud at that path got only `PATH` (and
  its shell's `PWD`), in a repository whose settings set gcloud's
  variables.
- On macOS, with the real gcloud, the command printed a token with
  `CLOUDSDK_PYTHON`, `CLOUDSDK_CONFIG`, a proxy, `PYTHONPATH` and `HOME`
  all set to wrong values. Without `env -i`, gcloud tried to start the
  named interpreter.

Someone who has not signed in sees "no working Google credentials", with
`env` named as the token command: they run `gcloud auth login`, as in
[What each person needs](#3-what-each-person-needs).

If you name gcloud directly instead (`/usr/bin/gcloud auth print-access-token ...`),
a repository's settings `env` reaches it: add the fallback pins from
[The policy](#2-the-policy), which cover only the variables they name.

Checked in a container, against a test tag:

- The copy each machine installs is the tag's, not the default branch's,
  and `autoUpdate` stays off.
- The policy's options hold against the person's own.
- A fresh machine records nothing in its first session, which registers
  the marketplace and installs the mod in the background. The mod records
  from the next session after that install: the second, when the first
  stayed open (20 seconds, in a check), otherwise the third. To record from
  the first, have each person (or a setup script run as them) install it
  once from the same pinned source:
  `claude plugin install bigquery-agent-analytics-mod --marketplace "haiyuan-eng-google/bigquery_agent_analytics_skill#TAG"`
  (no `--config`: the policy's options apply).
- It runs in the user tier, with the differences in
  [Choose the tier](#choose-the-tier).

The repository has no release tags for the mod yet. Until it does, use the
folder, or a tag in a fork your organization controls. `ref` takes a branch
or a tag, not a commit (checked: a commit is "not found in upstream
origin").

To deploy a tag, the first one and every move after it:

1. **Give the tag a version nothing installed before can have.** Every
   install from the default branch or a clone is `0.1.0`, the version in
   every commit so far, so even the first tag needs another, such as
   `0.1.0-org.1`, and each later tag a new one again. Before tagging,
   change `version` in the mod's `.claude-plugin/plugin.json`, in its entry
   in the repository's `.claude-plugin/marketplace.json`, and
   `PLUGIN_VERSION` in `hooks/lib/config.ts`. `claude plugin update`
   compares only that string, and `claude plugin list` shows only that
   string. A tag at a version a machine already has is never installed over
   its copy ("already at the latest version"), so a fix shipped that way
   reaches new machines only. The others keep their code and still pass a
   check by version.
2. **Deliver the policy, or change its `ref`**, for the pilot group first.
3. **On each machine that already has the mod from this marketplace, right
   after the policy arrives**, as the person (or a script run as them),
   fetch the marketplace at the tag, then update. Require both to succeed,
   and treat "already at the latest version" as a failure: the copy is then
   not the tag's.

   ```bash
   claude plugin marketplace add "haiyuan-eng-google/bigquery_agent_analytics_skill#NEW_TAG"
   claude plugin update bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin
   ```

   Until then the machine's copy does not load. The marketplace it came
   from no longer matches the policy ("its source doesn't match its
   extraKnownMarketplaces entry"), `claude plugin list` shows the copy as
   failed to load, and `plugin update` alone fails ("not found").
4. **Check by commit, not by label, on every machine.** First look up the
   tag's commit, once:

   ```bash
   git ls-remote https://github.com/haiyuan-eng-google/bigquery_agent_analytics_skill "refs/tags/NEW_TAG" "refs/tags/NEW_TAG^{}" | awk '{ c = $1 } /\^\{\}$/ { p = $1 } END { if (!c) { print "no commit found" > "/dev/stderr"; exit 1 } print (p ? p : c) }'
   ```

   It prints the commit for every kind of tag. For an annotated or signed
   tag (`git tag -a`, `git tag -s`), the `refs/tags/NEW_TAG` line, the only
   one `git ls-remote … NEW_TAG` prints, is the tag object's id, not a
   commit; the commit, which the host records, is on the
   `refs/tags/NEW_TAG^{}` line. If it prints "no commit found" instead, the
   tag is missing or the lookup failed: stop, there is nothing to check
   against.

   The host records each copy's commit in
   `~/.claude/plugins/installed_plugins.json`. Every commit this prints must
   be that one:

   ```bash
   python3 -c 'import json, os; d = json.load(open(os.path.expanduser("~/.claude/plugins/installed_plugins.json"))); print([e.get("gitCommitSha") for e in d["plugins"]["bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin"]])'
   ```

5. **Where the commit is not the tag's**, replace the copy. This happens to
   a copy installed earlier at the tag's version from another commit, when
   step 1 was skipped. Deliver the disable policy of
   [§8](#8-stop-roll-back-revoke) to that machine, run
   `claude plugin uninstall bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin`
   as the person, deliver the policy at the tag again, and run the pinned
   install,
   `claude plugin install bigquery-agent-analytics-mod --marketplace "haiyuan-eng-google/bigquery_agent_analytics_skill#TAG"`.
   Then check the commit again.

A machine that has the mod from this marketplace at another ref when the
policy first arrives (an earlier install from the default branch, say)
needs steps 3 to 5 too. Until then its copy becomes the managed copy but
does not load, and the machine records nothing.

Checked in a container (host CLI 2.1.304, test tags in a fork, `autoUpdate`
off):

- right after the ref moved, `plugin update` alone failed ("not found");
- `marketplace add` at the new tag, an annotated one, then `plugin update`,
  both succeeded ("updated from 0.1.0-pin1 to 0.1.0-pin2 for scope
  managed"). The recorded commit was the one the lookup in step 4 printed,
  not the tag object's id, and the next session ran it;
- the same held on a machine set up by the pinned install above;
- a tag at the same version on another commit: "already at the latest
  version", and the recorded commit stayed the earlier tag's;
- an install from another ref before the policy: it did not load once the
  policy arrived. After the two commands at the policy's tag, it was that
  tag's, by commit, and recorded;
- an install before the policy at the tag's version from another commit:
  after the two commands, "already at the latest version", and it kept its
  own commit. Step 5 made it the tag's, by commit, and it recorded.

## 7. Roll out in stages

1. **Entry:** the items in [Before it goes beyond a pilot](#before-it-goes-beyond-a-pilot)
   are done, and the check at the end of [The policy](#2-the-policy)
   passes on one machine with your policy.
2. **Pilot:** deliver the policy to a named group (5 to 20 people) for a
   week. On each machine, after a session, `/bqaa-status` shows `enabled`,
   your target, no `notice` line and `requests: N ok`.
3. **Watch** these, daily:
   - enrolled people with no rows on days they used the agent;
   - people whose rows wait on disk: their `/bqaa-status` shows a notice,
     or rows waiting;
   - rows from a settings-hook tracer from enrolled people: events written
     twice. This repository's tracer stamps `writer.plugin` =
     `bqaa-coding-agent-plugin`, and the SDK repository's
     `bigquery-agent-analytics-tracing`; the query counts every writer but
     the mod (ADK agents' rows name none).

   With a table of the enrolled login names (`team_roster`, one `user_id`
   column) that you keep:

   ```sql
   -- Per enrolled person, the last 7 days: the mod's sessions and last row,
   -- and the rows of every other writer (a settings-hook tracer: writing twice).
   WITH written AS (
     SELECT user_id, session_id, timestamp, JSON_VALUE(attributes, '$.writer.plugin') AS writer
     FROM `my-gcp-project.agent_analytics.agent_events`
     WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
   ),
   seen AS (
     SELECT user_id,
       COUNT(DISTINCT IF(writer = 'bigquery-agent-analytics-mod', session_id, NULL)) AS sessions,
       MAX(IF(writer = 'bigquery-agent-analytics-mod', timestamp, NULL)) AS last_row,
       COUNTIF(writer != 'bigquery-agent-analytics-mod') AS tracer_rows
     FROM written
     WHERE writer IS NOT NULL
     GROUP BY user_id
   )
   SELECT r.user_id, IFNULL(s.sessions, 0) AS sessions, s.last_row, IFNULL(s.tracer_rows, 0) AS tracer_rows
   FROM `my-gcp-project.agent_analytics.team_roster` AS r
   LEFT JOIN seen AS s USING (user_id)
   ORDER BY sessions, r.user_id
   ```

   Run it as an administrator: it reads the table, not the views.
4. **Exit**, to widen: every enrolled person who used the agent has rows;
   no tracer rows; no notice left open for a week; the data-handling owner
   has looked at a sample of rows.
5. **Widen** in rings. A policy change reaches each person at their next
   session.

## 8. Stop, roll back, revoke

Each policy change below goes in the managed source that holds the policy
(see [The policy](#2-the-policy)). Under first-wins, a change in a
lower-ranked file that is skipped has no effect. Checked in a container,
with the drop-in, unless noted:

| To... | Do | What happens |
| --- | --- | --- |
| Stop recording, keep the mod | Policy: `options.enabled: false` and `env` `BQAA_TRACE_ENABLED: "false"` | The mod loads and records nothing (`/bqaa-status`: `disabled`, `captured 0`) |
| Unload the mod at once | Policy: `"bigquery-agent-analytics-mod@org-tools": false` | The mod does not load |
| Roll back | The disable policy below, in the source that holds the policy, kept until the earlier installs are gone; then remove it from that source, and delete the folder | Nothing loads, and no tracer hook runs |
| Revoke the writer's tokens | Disable the writer service account ([service-account auth](service-account-auth.md#offboarding)) | Tokens are refused, issued ones included (a check refused one with `401` within 15 seconds, live). Sessions show "no working Google credentials" and keep rows on disk |

Each takes effect when a session starts.

**Roll back in this order**, because the policy is also what keeps the
earlier ways in off:

1. Put the disable policy where the policy is now: every id off, and
   capture off for any copy that still loads. For a file deployment,
   replace the drop-in with it. Where you put the complete policy in a
   higher-ranked source (an admin console, or a device-management
   profile), replace it there. A disable policy in the drop-in would be
   skipped, and that source's `BQAA_TRACE_ENABLED: "true"` would outrank
   the drop-in's `false`, so the mod would keep recording.

   ```json
   {
     "enabledPlugins": {
       "bigquery-agent-analytics-mod@org-tools": false,
       "bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin": false,
       "bigquery-agent-analytics-mod@bqaa-tracing": false,
       "bigquery-agent-analytics-tracing@bigquery-agent-analytics-plugin": false,
       "bigquery-agent-analytics-tracing@bqaa-tracing": false
     },
     "env": { "BQAA_TRACE_ENABLED": "false" }
   }
   ```

   Checked, for the drop-in: with earlier installs still there, nothing
   loads and no tracer hook runs.

   Before going on, check on pilot machines that it is in effect:
   `claude -p --debug-file /tmp/bqaa.log /bqaa-status` leaves no
   `hooks module bigquery-agent-analytics-mod` line in the log. Where
   several managed sources apply, `/status` in an interactive session
   lists the one you changed under "Setting sources". Not checked here: the
   container has only the file source.
2. On each machine, remove the earlier installs, as the person or a script
   run as them: `claude plugin uninstall` for the earlier mod and the
   tracer (and the GitHub-sourced copy, for that variant), and the tracer's
   hooks pasted into their settings. `claude plugin list` shows none.
3. Remove the disable policy from that source (for a file deployment,
   delete the drop-in), then delete the folder. Checked, for the drop-in:
   nothing runs.

Removing the policy first brings the earlier tracer and mod back on a
machine that still has them (checked, straight after a migration), and a
GitHub-sourced copy stays installed and keeps loading with the person's own
options (checked) until it is uninstalled. Its files stay in
`~/.claude/plugins/cache/` after that; delete them with the rest.

**Rows that waited** are in each person's
`~/.bqaa-mod/dead-letter/<project.dataset.table>/`. They hold prompts and
tool output, so treat them as personal data on the machine:

- With the policy gone they stay (checked).
- With the mod back, `/bqaa-status` lists them (checked), and they are sent
  once tokens work, at session start or with `/bqaa-backfill`.
- To discard them, delete the folder (checked: nothing waits after).
- Include the folder when a machine is wiped or handed on.

## 9. Data-handling sign-off

Fill this in, and have the owner sign it, before the policy goes beyond the
pilot:

| Item | Answer |
| --- | --- |
| What is collected | Each person's prompts, the model's visible answers, tool arguments and results, cut to `maxPayloadChars` per column, with credential-shaped values removed (the README's [Privacy and security](../README.md#privacy-and-security)). Also token counts, latency, tool names and outcomes, the login name as `user_id`, and the working directory |
| Who can read it | Writers cannot. Readers of the views see counts and tokens per day. The administrators, and anyone with a project role that reads every table, see everything ([service-account auth](service-account-auth.md#project-roles-reach-the-table-too)): name them |
| How long it is kept | Set a partition expiration on the table (`ALTER TABLE ... SET OPTIONS (partition_expiration_days = N)`); the mod sets none |
| Where it goes | Only the project and dataset in the policy, over HTTPS to BigQuery. Rows that could not be sent wait in each person's home folder until they are |
| Who was told | How the people whose sessions are recorded were told, and where they can read this |
| Owner | Name, role, date of the decision |

## Checked

[`tests/managed-settings.live.sh`](../tests/managed-settings.live.sh) runs
this guide in a Linux container with host CLI 2.1.304, as an ordinary user
under a root-owned policy delivered as a drop-in: offline for the folder,
and over the network for the GitHub variant pinned to a test tag (with
`BQAA_CHECK_NETWORK=1`). Every row of the tables above marked as checked is
one of its checks.

Not checked:

- the macOS and Windows policy files;
- policies delivered by device-management profiles or an admin console,
  and `managedSourcesBehavior`;
- `/status` (it needs an interactive session);
- the desktop app and editor extensions (the checks run the CLI);
- Windows token commands;
- groups (people stood in for group members).
