---
name: create-copilot-studio-agent
description: Create a new Microsoft Copilot Studio CLI-authored agent project from a natural-language description, using the proper settings, behaviors, capabilities, infrastructure, and PAC synchronization structure. Use when the user asks to create, scaffold, initialize, or build a new MCS or Copilot Studio agent/project.
---

# Create a Copilot Studio Agent

Create a new **Copilot Studio CLI-authored agent** from a natural-language business problem,
scenario, or set of instructions. Reuse details from the initial request, offer optional guided
design, collect the required project identity, initialize a sync-connected workspace, implement the
agent with the modern YAML structure, validate it, and push it to Copilot Studio.

This skill creates and pushes the agent, but does not publish it unless the user explicitly requests
publication and confirms the publication warning.

## Required collaborators

Use these plugin agents in this order:

1. **Copilot Studio Init** — creates the empty sync-connected project.
2. **Copilot Studio Manage** — pulls before editing, pushes afterward, and performs the final pull.
3. **Copilot Studio Architect** — implements the requested behavior in the initialized project.

Do not replace their responsibilities with improvised PAC commands or hand-created workspace files.

## Process

### 1. Parse the request

Extract any values already supplied by the user:

- Business problem, scenario, or agent instructions.
- Agent display name.
- Target project directory.
- Target environment ID or absolute Dataverse HTTPS URL.
- Publisher customization prefix.

Treat behavioral text in the initial request as the initial agent instructions. Do not ask the user
to repeat or rephrase information they already supplied.

Extract available design details into these areas:

- **Skills** — reusable procedures or expert workflows.
- **Tools and workflows** — external actions, live data, APIs, connectors, agent flows, or other
  integrations.
- **Instructions** — role, primary jobs, intended users, tone, clarification and confirmation
  behavior, safety, privacy, and escalation constraints.
- **Data and knowledge** — public websites, SharePoint, OneDrive, uploaded files, or other grounding
  sources.
- **Settings** — authentication, access, language, model, Work IQ, and other agent-level settings.

Do not require the user to name YAML components. The Architect decides whether each requirement
belongs in instructions, knowledge, tools, or skills.

### 2. Choose the creation depth

Support both of these paths:

1. **Basic instructions-only path.** This is the minimum valid creation path. Use the instructions
   already present in the request, make reasonable non-risky assumptions, and create the base agent
   without requiring skills, tools, workflows, knowledge sources, or custom settings. Use this path
   when the user says "just go", asks to skip questions, declines elaboration, or otherwise requests
   immediate creation.
2. **Guided scenario-design path.** Prefer this path when the user wants help shaping the agent or
   when targeted clarification would materially improve the result. Ask one concise, grouped set of
   questions only for important missing details across Skills, Tools and workflows, Instructions,
   Data and knowledge, and Settings. In particular, clarify concrete data sources such as
   SharePoint locations, public URLs, or local files when grounding is requested.

The guided path is optional, not a prerequisite for creation. Do not force the user to answer every
category, ask again for details already present in the initial request, or block an
instructions-only agent because richer components were not specified. Operational values required
to initialize the project, such as the environment, may still need to be collected.

Record which path is being used and any assumptions. Never create default topics: topics are not
part of the new agent model. Translate relevant requirements into instructions, skills, tools,
knowledge, or supported settings instead.

### 3. Resolve project identity

Resolve these values before initialization:

1. **Display name.** Use an explicit user-provided name when present. Otherwise derive a concise,
   human-readable name from the behavior description and show it with the other resolved values.
2. **Project directory.** Use an explicit path when present. Otherwise derive a slugified directory
   under the current working directory. Resolve it to an absolute path.
3. **Environment.** Require an environment ID or absolute Dataverse HTTPS URL. If the request
   contains a Copilot Studio URL with `/environments/<environmentId>/`, extract the environment ID.
   Do not silently select an environment when several are plausible.
4. **Publisher prefix.** Use an explicit value when present. Otherwise default to `catmgr`. Validate
   it: 2-8 alphanumeric characters, starts with a letter, and does not start with `mscrm`
   case-insensitively. Preserve the user's casing.

Ask only for values that cannot be safely derived. Before initialization, state the resolved display
name, absolute project directory, environment, and publisher prefix.

### 4. Protect the destination

Check the target project directory:

- If it does not exist, continue.
- If it contains `settings.mcs.yml`, `agent.sync.yaml`, and `.mcs\`, treat it as an existing
  sync-connected CLI workspace. Do not initialize over it. Ask whether to resume or use another
  directory.
- If it exists but is incomplete or is not a Copilot Studio workspace, stop. Do not delete,
  overwrite, or merge into it. Ask the user to choose another directory or explicitly clean up the
  existing path themselves.

### 5. Initialize the workspace

Delegate to **Copilot Studio Init** with exactly:

- display name
- absolute target project directory
- environment ID or URL
- validated publisher prefix

The Init agent must run one `pac copilot init` command with `--authoring-mode cli-copilot`.

After it completes, verify:

- `<project>\settings.mcs.yml` exists
- `<project>\agent.sync.yaml` exists
- `<project>\.mcs\` exists
- `settings.mcs.yml` contains the expected display name and a nonempty `schemaName`
- `configuration.recognizer.kind` is `CLICopilotRecognizer` or `CLIAgentRecognizer`
- `configuration.authoringModel` is `CliCopilot`

If initialization fails or a marker is missing, stop and report the exact failure. Never create the
missing workspace files manually.

Read `.mcs\conn.json` only to assess client compatibility; never edit it. Record whether
`AgentManagementEndpoint` is a nonempty URL.

- A PAC-initialized or PAC-cloned workspace can have `AgentManagementEndpoint: null`. PAC pull and
  push may still work because PAC uses its external auth profile, but the Copilot Studio VS Code
  extension rejects that workspace as having incomplete connection settings.
- Do not repair the field manually and do not repeatedly clone with PAC; PAC can reproduce the same
  null endpoint.
- Mark the workspace as requiring extension reattachment. Tell the user to update or reload the
  Copilot Studio extension and run **Copilot Studio: Reattach Agent** from the VS Code Command
  Palette, selecting the same environment and agent. Current extension builds can also attempt an
  on-demand endpoint repair for PAC-cloned workspaces.
- If reattachment is unavailable or fails, use the extension's Clone Agent workflow to clone the
  already-pushed remote agent into a new folder, then open that extension-created workspace.

Missing `AgentManagementEndpoint` is a VS Code extension-readiness warning, not proof that the PAC
workspace or remote agent is invalid. Continue the PAC-based creation workflow, but do not report
the project as extension-ready until reattachment or an extension clone supplies complete metadata.

### 6. Pull before implementation

Delegate a pull to **Copilot Studio Manage** for the initialized project. Do not start implementation
until pull completes successfully.

### 7. Build the implementation brief

Turn the request into a concrete brief for the Architect. Include:

- exact target project directory
- new-agent mode, not migration mode
- selected creation depth: basic instructions-only or guided scenario design
- resolved display name and `schemaName`
- the original instructions, preserving all useful details from the initial request
- requested Skills
- requested Tools and workflows, including live-data and external-action requirements
- Instructions covering role, users, capabilities, tone, clarification rules, and safety constraints
- Data and knowledge, including concrete SharePoint locations, URLs, or local files
- requested Settings
- existing tools, knowledge, skills, and connections in the workspace
- assumptions and unresolved integration details

For the basic path, require meaningful global instructions but do not invent skills, tools,
knowledge sources, custom settings, connections, or topics merely to make the project look more
complete.

For current or live data, require a real tool when API-level reliability is expected. Do not claim a
connector-backed capability is implemented unless the environment has the required connection and
the project has a valid connection reference. A public website knowledge source is only a
best-effort fallback and must be identified as such.

### 8. Implement with the Architect

Delegate the brief to **Copilot Studio Architect**. Require it to write the complete YAML
implementation into the initialized project, not merely return a design.

The Architect must:

- preserve initialized identity and synchronization fields
- always write meaningful global behavior into `settings.mcs.yml`, including for the basic
  instructions-only path
- place reusable procedures under `behaviors\`
- place knowledge under `capabilities\knowledge\`
- place tools under `capabilities\tools\` only when complete tool and connection metadata exists
- create only components justified by the request or guided design; do not create default topics or
  speculative skills, tools, knowledge, or settings
- use the publisher customization prefix from `schemaName` for every newly authored flat component
  filename and keep the complete derived component schema within Dataverse's 100-character limit
- leave `.mcs\` and `agent.sync.yaml` untouched
- report exact files changed and unresolved gaps

If the Architect returns only a proposal or makes no concrete file changes, creation is incomplete.

### 9. Run the structural gate

Before push, inspect the resulting workspace and block on any failure:

1. `settings.mcs.yml`, `agent.sync.yaml`, and `.mcs\` still exist.
2. Initialized `displayName`, `schemaName`, recognizer, and authoring model are preserved.
3. `settings.mcs.yml` contains meaningful instructions derived from the user's request.
4. No default topic or topic-equivalent routing components were created.
5. Every new component is under `behaviors\`, `capabilities\`, or `infrastructure\`.
6. Every authored `*.mcs.yml` component except `settings.mcs.yml` contains `mcs.metadata` and
   `kind`.
7. Every new flat bot-component filename starts with the publisher customization prefix derived from
   `schemaName`, followed by `_` or `.`. For example, a `catmgr_...` agent uses
   `catmgr_getweather_a1B2c3.mcs.yml`. Do not repeat a long full agent `schemaName` in every filename
   when that would make the derived Dataverse component schema too long.
8. For each new flat component, conservatively calculate
   `<agent-schemaName> + "." + <filename-without-.mcs.yml>` and require at most 100 characters.
   Shorten the slug, never the publisher prefix or uniqueness suffix, when over budget.
9. Knowledge components follow `reference/knowledge-schema.md`, including its filename budget.
10. No connector tool contains an invented or placeholder `connectionReference`, connector ID,
   operation ID, input, or output.
11. Live-data behavior uses a real tool or is explicitly described as a best-effort grounded
   fallback that must not fabricate results.
12. `.mcs\` and `agent.sync.yaml` were not authored or modified by the Architect.
13. `.mcs\conn.json` was inspected without modification. If `AgentManagementEndpoint` is null or
    empty, record that VS Code extension reattachment is required; do not block PAC push solely for
    this reason.

If a filename lacks the required namespace, rename it before push:

```text
<publisher-prefix>_<budgeted-slug>_<short-unique-id>.mcs.yml
```

Never wait for Dataverse to discover a predictable prefix error.

### 10. Push and verify

Delegate push to **Copilot Studio Manage**. It must follow its normal pull-before-push rules and
surface conflicts rather than overwrite remote changes.

After a successful push, delegate one final pull:

- Zero applied changes confirms local and remote synchronization.
- If remote changes are applied, inspect them and confirm that the authored components still exist
  in PAC's canonical layout.

Do not publish unless explicitly requested. Publication requires the Manage agent's standard warning
and explicit confirmation.

### 11. Report

Report:

- display name
- project directory
- environment
- agent ID and schema name when available
- creation depth used and assumptions made
- component areas and principal files created
- push result
- final synchronization result
- unresolved connectors, knowledge, or live-data limitations
- VS Code extension readiness, including whether **Copilot Studio: Reattach Agent** is required
- publication status

Do not claim an unavailable integration works. Do not dump complete YAML unless requested.

## Resumability and errors

- Preserve a successfully initialized workspace when a later phase fails.
- Resume an existing sync-connected workspace only after the user chooses to resume it.
- If files already exist, inspect and continue from the first incomplete phase rather than creating
  duplicate components.
- On `ExportKeyAttributeInvalidPrefix`, correct new component paths to start with the valid
  publisher customization prefix before retrying.
- On `StringLengthTooLong` for `botcomponent.schemaname`, shorten component filename slugs until the
  conservative derived-name calculation is at most 100 characters.
- On push conflicts, use the Manage agent's pull-and-resolve workflow.
- If a connector connection is unavailable, do not invent it. Report the gap and either omit that
  capability or use a clearly disclosed best-effort knowledge fallback when appropriate.
- If VS Code reports incomplete `.mcs\conn.json` settings and `AgentManagementEndpoint` is null,
  direct the user to **Copilot Studio: Reattach Agent** or the extension's Clone Agent workflow.
  Never hand-edit `.mcs\conn.json`.
