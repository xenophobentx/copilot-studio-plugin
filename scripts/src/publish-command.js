/**
 * publish-command.js — the `pac copilot publish` command /chat suggests when an agent is not
 * published.
 *
 * The ids come from the workspace's .mcs/conn.json and settings.mcs.yml, and the /chat instructions
 * tell the coding agent to run the command as given. A cloned workspace is not necessarily trusted,
 * so the command is only built from values that cannot change its meaning in a shell.
 */

// Agent ids and environment ids are GUIDs, and schema names use letters, digits, underscores and
// dots. A leading "-" would read as an option.
const SHELL_SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * The schema name is used only when the agent id is missing. An agent id that is present but not
 * shell-safe returns null, because the workspace files may have been altered.
 *
 * @returns {string|null} The command, or null when an id is missing or not shell-safe.
 */
function publishCommandFor({ agentId, schemaName, environmentId }) {
  // `pac copilot publish` takes --bot (agent id or schema name); it rejects --bot-id.
  const bot = agentId || schemaName;
  if (!SHELL_SAFE.test(bot || "") || !SHELL_SAFE.test(environmentId || "")) return null;
  return `pac copilot publish --bot "${bot}" --environment "${environmentId}"`;
}

module.exports = { publishCommandFor };
