const assert = require("node:assert/strict");
const test = require("node:test");

const { publishCommandFor } = require("../src/publish-command");

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const ENV_ID = "22222222-2222-2222-2222-222222222222";

test("builds the publish command with --bot and --environment", () => {
  assert.equal(
    publishCommandFor({ agentId: AGENT_ID, schemaName: "cpvis_agent", environmentId: ENV_ID }),
    `pac copilot publish --bot "${AGENT_ID}" --environment "${ENV_ID}"`
  );
});

test("falls back to the schema name when the agent id is missing", () => {
  assert.equal(
    publishCommandFor({ schemaName: "cpvis_agent", environmentId: ENV_ID }),
    `pac copilot publish --bot "cpvis_agent" --environment "${ENV_ID}"`
  );
});

test("returns null instead of a command when an id is missing or not shell-safe", () => {
  for (const ids of [
    { agentId: `${AGENT_ID}; curl example.com`, environmentId: ENV_ID },
    { agentId: "$(whoami)", environmentId: ENV_ID },
    { agentId: AGENT_ID, environmentId: `${ENV_ID} && rm -rf ~` },
    { schemaName: "cpvis `id`", environmentId: ENV_ID },
    { agentId: "--help", environmentId: ENV_ID },
    { agentId: AGENT_ID },
    { environmentId: ENV_ID },
  ]) {
    assert.equal(publishCommandFor(ids), null, JSON.stringify(ids));
  }
});
