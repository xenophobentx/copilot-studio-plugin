const assert = require("node:assert/strict");
const test = require("node:test");

const {
  authorityHostForCloud,
  buildMsalConfig,
  classifyUrl,
  defaultGraphScopes,
  inferCloudFromUrl,
  normalizeCloud,
  resolveSecureCachePlugin,
} = require("../src/verify-knowledge-access");
const { createSecureCachePlugin } = require("../src/secure-msal-cache");

test("maps sovereign clouds to their Microsoft Entra authority hosts", () => {
  assert.equal(authorityHostForCloud("Prod"), "login.microsoftonline.com");
  assert.equal(authorityHostForCloud("High"), "login.microsoftonline.us");
  assert.equal(authorityHostForCloud("DoD"), "login.microsoftonline.us");
  assert.equal(authorityHostForCloud("Mooncake"), "login.partner.microsoftonline.cn");
});

test("infers sovereign clouds from SharePoint hosts", () => {
  assert.equal(
    inferCloudFromUrl("https://contoso.sharepoint.us/sites/Operations"),
    "High"
  );
  assert.equal(
    inferCloudFromUrl("https://contoso.sharepoint-mil.us/sites/Operations"),
    "DoD"
  );
  assert.equal(
    inferCloudFromUrl("https://contoso.sharepoint.cn/sites/Operations"),
    "Mooncake"
  );
  assert.equal(inferCloudFromUrl("https://contoso.sharepoint.com/sites/Operations"), null);
});

test("does not silently map an unknown cloud to the global cloud", () => {
  assert.equal(normalizeCloud("not-a-cloud"), null);
});

test("uses the documented least-privileged delegated scope for Graph shares", () => {
  assert.deepEqual(defaultGraphScopes("graph.microsoft.com"), [
    "https://graph.microsoft.com/Files.ReadWrite",
  ]);
  assert.deepEqual(defaultGraphScopes("graph.microsoft.us"), [
    "https://graph.microsoft.us/Files.ReadWrite",
  ]);
});

test("rejects non-HTTPS SharePoint URLs", () => {
  assert.deepEqual(classifyUrl("http://contoso.sharepoint.com/sites/Operations"), {
    kind: "invalid",
    reason: "SharePoint and OneDrive URLs must use HTTPS.",
  });
});

test("rejects SharePoint URLs containing embedded credentials", () => {
  assert.deepEqual(
    classifyUrl("https://user:password@contoso.sharepoint.com/sites/Operations"),
    {
      kind: "invalid",
      reason: "SharePoint and OneDrive URLs must not contain embedded credentials.",
    }
  );
});

test("falls back to an in-memory cache when secure persistence is unavailable", async () => {
  const warnings = [];
  const cachePlugin = await resolveSecureCachePlugin(
    "chat-agent",
    (message) => warnings.push(message),
    async () => {
      throw new Error("secure storage unavailable");
    }
  );

  assert.equal(cachePlugin, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /in-memory token cache/i);
});

test("passes the old slot and tenant to the secure cache factory", async () => {
  const calls = [];
  const warn = () => {};
  const plugin = await resolveSecureCachePlugin(
    "chat-tenant-tenant-1",
    warn,
    async (...args) => {
      calls.push(args);
      return "plugin";
    },
    { legacyAccountName: "chat-agent-1", tenantId: "tenant-1" }
  );

  assert.equal(plugin, "plugin");
  assert.deepEqual(calls, [
    [
      "chat-tenant-tenant-1",
      undefined,
      { legacyAccountName: "chat-agent-1", tenantId: "tenant-1", warn },
    ],
  ]);
});

test("omits MSAL persistence when secure storage is unavailable", () => {
  assert.deepEqual(
    buildMsalConfig({
      clientId: "client-id",
      authority: "https://login.microsoftonline.us/tenant-id",
      cachePlugin: null,
    }),
    {
      auth: {
        clientId: "client-id",
        authority: "https://login.microsoftonline.us/tenant-id",
      },
    }
  );
});

test("disables plaintext Linux persistence in the secure cache", async () => {
  let persistenceOptions;
  class FakePersistenceCachePlugin {
    constructor(persistence) {
      this.persistence = persistence;
    }
  }

  const cachePlugin = await createSecureCachePlugin("chat-agent", () => ({
    PersistenceCreator: {
      createPersistence: async (options) => {
        persistenceOptions = options;
        return "encrypted-persistence";
      },
    },
    PersistenceCachePlugin: FakePersistenceCachePlugin,
    DataProtectionScope: { CurrentUser: "current-user" },
  }));

  assert.equal(persistenceOptions.usePlaintextFileOnLinux, false);
  assert.equal(cachePlugin.persistence, "encrypted-persistence");
});
