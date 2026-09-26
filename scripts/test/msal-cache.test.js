const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  agentCacheAccountName,
  pickAccount,
  cacheHasAccount,
  createCachePlugin,
  createCachePluginWithFallback,
  seedFromLegacyCache,
  tenantCacheAccountName,
  withLockFile,
} = require("../src/msal-cache");
const { createSecureCachePlugin } = require("../src/secure-msal-cache");

const SIGNED_IN = JSON.stringify({
  Account: {
    "uid.utid-login.microsoftonline.com-tenant-1": {
      username: "user@contoso.com",
      realm: "tenant-1",
    },
  },
  RefreshToken: { rt: { secret: "legacy-refresh-token" } },
});
const OTHER_SIGNED_IN = JSON.stringify({
  Account: { "other-login.microsoftonline.com-utid": { username: "other@contoso.com" } },
});
const EMPTY_MSAL_CACHE = JSON.stringify({
  Account: {},
  IdToken: {},
  AccessToken: {},
  RefreshToken: {},
  AppMetadata: {},
});

function persistenceError(errorCode, message) {
  return Object.assign(new Error(`${errorCode}: ${message}`), { errorCode });
}

function memoryStore(initial = null) {
  const store = {
    value: initial,
    saves: 0,
    load: async () => store.value,
    save: async (contents) => {
      store.saves += 1;
      store.value = contents;
    },
  };
  return store;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msal-cache-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Stand-in for @azure/msal-node-extensions: one in-memory persistence per account name.
function fakeExtensions(slots = {}) {
  const created = [];
  class FakePersistenceCachePlugin {
    constructor(persistence) {
      this.persistence = persistence;
    }
  }
  return {
    created,
    slots,
    PersistenceCreator: {
      createPersistence: async (options) => {
        created.push(options);
        fs.mkdirSync(path.dirname(options.cachePath), { recursive: true });
        if (!fs.existsSync(options.cachePath)) fs.writeFileSync(options.cachePath, "{}");
        return {
          options,
          getFilePath: () => options.cachePath,
          load: async () => slots[options.accountName] ?? null,
          save: async (contents) => {
            slots[options.accountName] = contents;
          },
        };
      },
    },
    PersistenceCachePlugin: FakePersistenceCachePlugin,
    DataProtectionScope: { CurrentUser: "current-user" },
  };
}

test("names one cache slot per tenant and keeps the old per-agent slot name", () => {
  assert.equal(
    tenantCacheAccountName("8da7352d-9308-4b9f-80af-119d78f5a973"),
    "chat-tenant-8da7352d-9308-4b9f-80af-119d78f5a973"
  );
  assert.equal(
    agentCacheAccountName("618793c0-a3ad-4525-9a60-d6594c1b4433"),
    "chat-618793c0-a3ad-4525-9a60-d6594c1b4433"
  );
  assert.equal(agentCacheAccountName(undefined), "chat-default");
  assert.equal(tenantCacheAccountName("../x y"), "chat-tenant-.._x_y");
});

test("detects whether a serialized MSAL cache has a signed-in account", () => {
  assert.equal(cacheHasAccount(null), false);
  assert.equal(cacheHasAccount(""), false);
  assert.equal(cacheHasAccount("{}"), false);
  assert.equal(cacheHasAccount("not json"), false);
  assert.equal(cacheHasAccount(EMPTY_MSAL_CACHE), false);
  assert.equal(cacheHasAccount(SIGNED_IN), true);
});

test("with a tenant id, only counts accounts of that tenant", () => {
  assert.equal(cacheHasAccount(SIGNED_IN, "tenant-1"), true);
  assert.equal(cacheHasAccount(SIGNED_IN, "TENANT-1"), true);
  assert.equal(cacheHasAccount(SIGNED_IN, "tenant-2"), false);
  assert.equal(cacheHasAccount(OTHER_SIGNED_IN, "tenant-1"), false);
});

test("counts a guest account through its tenant profiles", () => {
  const guest = JSON.stringify({
    Account: {
      "uid.home-tenant-login.microsoftonline.com-home-tenant": {
        realm: "home-tenant",
        tenantProfiles: [
          '{"tenantId":"home-tenant","isHomeTenant":true}',
          '{"tenantId":"Tenant-1","isHomeTenant":false}',
        ],
      },
    },
  });
  assert.equal(cacheHasAccount(guest, "tenant-1"), true);
  assert.equal(cacheHasAccount(guest, "home-tenant"), true);
  assert.equal(cacheHasAccount(guest, "tenant-2"), false);
  const broken = JSON.stringify({ Account: { a: { realm: "x", tenantProfiles: ["{not json"] } } });
  assert.equal(cacheHasAccount(broken, "tenant-1"), false);
});

test("does not copy a legacy cache that belongs to another tenant", async () => {
  const target = memoryStore(null);

  const copied = await seedFromLegacyCache({
    target,
    legacy: memoryStore(SIGNED_IN),
    tenantId: "tenant-2",
  });

  assert.equal(copied, false);
  assert.equal(target.saves, 0);
});

test("copies the legacy cache into an empty tenant cache", async () => {
  const target = memoryStore(EMPTY_MSAL_CACHE);
  const legacy = memoryStore(SIGNED_IN);

  assert.equal(await seedFromLegacyCache({ target, legacy }), true);
  assert.equal(target.value, SIGNED_IN);
  assert.equal(legacy.value, SIGNED_IN);
});

test("never overwrites a tenant cache that already has an account", async () => {
  const target = memoryStore(OTHER_SIGNED_IN);
  const legacy = memoryStore(SIGNED_IN);

  assert.equal(await seedFromLegacyCache({ target, legacy }), false);
  assert.equal(target.value, OTHER_SIGNED_IN);
  assert.equal(target.saves, 0);
});

test("does nothing when the legacy cache has no account", async () => {
  for (const legacyValue of [null, "{}", EMPTY_MSAL_CACHE, "garbage"]) {
    const target = memoryStore(null);
    assert.equal(await seedFromLegacyCache({ target, legacy: memoryStore(legacyValue) }), false);
    assert.equal(target.saves, 0);
  }
});

test("reports a failed copy as a warning instead of throwing", async () => {
  const warnings = [];
  const legacy = {
    load: async () => {
      throw new Error("keychain locked");
    },
  };

  const copied = await seedFromLegacyCache({
    target: memoryStore(null),
    legacy,
    warn: (message) => warnings.push(message),
  });

  assert.equal(copied, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /keychain locked/);
});

test("holds the cache lockfile during the copy and removes it afterwards", async (t) => {
  const lockPath = path.join(tempDir(t), "chat-tenant-x.cache.json.lockfile");
  let lockSeenDuringCopy = false;
  const target = memoryStore(null);
  const legacy = {
    load: async () => {
      lockSeenDuringCopy = fs.existsSync(lockPath);
      return SIGNED_IN;
    },
  };

  assert.equal(await seedFromLegacyCache({ target, legacy, lockPath }), true);
  assert.equal(lockSeenDuringCopy, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test("waits for another process to release the lockfile", async (t) => {
  const lockPath = path.join(tempDir(t), "cache.lockfile");
  fs.writeFileSync(lockPath, "12345");
  setTimeout(() => fs.unlinkSync(lockPath), 150);

  const result = await withLockFile(lockPath, async () => "ran", { retries: 20, delayMs: 25 });

  assert.equal(result, "ran");
  assert.equal(fs.existsSync(lockPath), false);
});

test("skips the copy when the lockfile stays held, and leaves that lock alone", async (t) => {
  const lockPath = path.join(tempDir(t), "cache.lockfile");
  fs.writeFileSync(lockPath, "12345");
  const target = memoryStore(null);
  const warnings = [];

  const copied = await seedFromLegacyCache({
    target,
    legacy: memoryStore(SIGNED_IN),
    lockPath,
    lockOptions: { retries: 3, delayMs: 5 },
    warn: (message) => warnings.push(message),
  });

  assert.equal(copied, false);
  assert.equal(target.saves, 0);
  assert.equal(warnings.length, 1);
  assert.equal(fs.readFileSync(lockPath, "utf-8"), "12345");
});

test("encrypted cache: seeds the tenant slot from the agent's old slot", async (t) => {
  const cacheDir = tempDir(t);
  const legacyName = agentCacheAccountName("agent-1");
  const tenantName = tenantCacheAccountName("tenant-1");
  fs.writeFileSync(path.join(cacheDir, `${legacyName}.cache.json`), "{}");
  const extensions = fakeExtensions({ [legacyName]: SIGNED_IN });

  const plugin = await createCachePlugin(tenantName, {
    legacyAccountName: legacyName,
    tenantId: "tenant-1",
    loadDependencies: () => extensions,
    cacheDir,
  });

  assert.equal(plugin.persistence.options.accountName, tenantName);
  assert.equal(extensions.slots[tenantName], SIGNED_IN);
  assert.equal(extensions.slots[legacyName], SIGNED_IN);
  assert.equal(fs.existsSync(path.join(cacheDir, `${tenantName}.cache.json.lockfile`)), false);
});

test("encrypted cache: does not create a slot for an agent that never signed in", async (t) => {
  const cacheDir = tempDir(t);
  const extensions = fakeExtensions();

  await createCachePlugin(tenantCacheAccountName("tenant-1"), {
    legacyAccountName: agentCacheAccountName("new-agent"),
    loadDependencies: () => extensions,
    cacheDir,
  });

  assert.deepEqual(
    extensions.created.map((options) => options.accountName),
    [tenantCacheAccountName("tenant-1")]
  );
  assert.equal(fs.existsSync(path.join(cacheDir, "chat-new-agent.cache.json")), false);
});

test("encrypted cache: leaves the old slot closed once the tenant slot has an account", async (t) => {
  const cacheDir = tempDir(t);
  const legacyName = agentCacheAccountName("agent-1");
  const tenantName = tenantCacheAccountName("tenant-1");
  fs.writeFileSync(path.join(cacheDir, `${legacyName}.cache.json`), "{}");
  const extensions = fakeExtensions({ [tenantName]: OTHER_SIGNED_IN, [legacyName]: SIGNED_IN });

  await createCachePlugin(tenantName, {
    legacyAccountName: legacyName,
    loadDependencies: () => extensions,
    cacheDir,
  });

  assert.deepEqual(
    extensions.created.map((options) => options.accountName),
    [tenantName]
  );
  assert.equal(extensions.slots[tenantName], OTHER_SIGNED_IN);
});

test("encrypted cache: retries a storage check that fails while another run holds it", async (t) => {
  const cacheDir = tempDir(t);
  const extensions = fakeExtensions();
  const createPersistence = extensions.PersistenceCreator.createPersistence;
  let calls = 0;
  extensions.PersistenceCreator.createPersistence = async (options) => {
    calls += 1;
    if (calls <= 2) throw persistenceError("CachePersistenceError", "An unknown error occurred.");
    return createPersistence(options);
  };

  const plugin = await createCachePlugin(tenantCacheAccountName("tenant-1"), {
    loadDependencies: () => extensions,
    cacheDir,
    retry: { attempts: 4, delayMs: 1 },
  });

  assert.equal(calls, 3);
  assert.equal(plugin.persistence.options.accountName, tenantCacheAccountName("tenant-1"));
});

test("encrypted cache: gives up after the last retry so the caller can fall back", async (t) => {
  const cacheDir = tempDir(t);
  const extensions = fakeExtensions();
  let calls = 0;
  extensions.PersistenceCreator.createPersistence = async () => {
    calls += 1;
    throw persistenceError("CachePersistenceError", "keychain unavailable");
  };

  await assert.rejects(
    createCachePlugin(tenantCacheAccountName("tenant-1"), {
      loadDependencies: () => extensions,
      cacheDir,
      retry: { attempts: 3, delayMs: 1 },
    }),
    /keychain unavailable/
  );
  assert.equal(calls, 3);
});

test("encrypted cache: does not retry errors other than the storage check", async (t) => {
  const cacheDir = tempDir(t);
  const extensions = fakeExtensions();
  let calls = 0;
  extensions.PersistenceCreator.createPersistence = async () => {
    calls += 1;
    throw persistenceError("EACCES", "permission denied");
  };

  await assert.rejects(
    createCachePlugin(tenantCacheAccountName("tenant-1"), {
      loadDependencies: () => extensions,
      cacheDir,
      retry: { attempts: 3, delayMs: 1 },
    }),
    /permission denied/
  );
  assert.equal(calls, 1);
});

test("encrypted cache: seeds even when the first read of the tenant slot fails", async (t) => {
  const cacheDir = tempDir(t);
  const legacyName = agentCacheAccountName("agent-1");
  const tenantName = tenantCacheAccountName("tenant-1");
  fs.writeFileSync(path.join(cacheDir, `${legacyName}.cache.json`), "{}");
  const extensions = fakeExtensions({ [legacyName]: SIGNED_IN });
  const createPersistence = extensions.PersistenceCreator.createPersistence;
  let tenantReads = 0;
  extensions.PersistenceCreator.createPersistence = async (options) => {
    const persistence = await createPersistence(options);
    if (options.accountName !== tenantName) return persistence;
    const load = persistence.load;
    persistence.load = async () => {
      tenantReads += 1;
      if (tenantReads === 1) throw new Error("partial read");
      return load();
    };
    return persistence;
  };
  const warnings = [];

  await createCachePlugin(tenantName, {
    legacyAccountName: legacyName,
    loadDependencies: () => extensions,
    cacheDir,
    warn: (message) => warnings.push(message),
  });

  assert.equal(extensions.slots[tenantName], SIGNED_IN);
  assert.deepEqual(warnings, []);
});

function failingCheckExtensions() {
  const extensions = fakeExtensions();
  const createPersistence = extensions.PersistenceCreator.createPersistence;
  const calls = [];
  extensions.PersistenceCreator.createPersistence = async (options) => {
    calls.push(options.usePlaintextFileOnLinux);
    if (!options.usePlaintextFileOnLinux) {
      throw persistenceError("CachePersistenceError", "An unknown error occurred.");
    }
    return createPersistence(options);
  };
  return { extensions, calls };
}

test("encrypted cache on Linux: allows the plaintext file only after the last retry", async (t) => {
  const { extensions, calls } = failingCheckExtensions();

  const plugin = await createCachePlugin(tenantCacheAccountName("tenant-1"), {
    loadDependencies: () => extensions,
    cacheDir: tempDir(t),
    retry: { attempts: 3, delayMs: 1, platform: "linux" },
  });

  assert.deepEqual(calls, [false, false, false, true]);
  assert.equal(plugin.persistence.options.usePlaintextFileOnLinux, true);
});

test("encrypted cache: never allows the plaintext file off Linux or for the secure cache", async (t) => {
  for (const [platform, usePlaintextFileOnLinux] of [
    ["darwin", true],
    ["win32", true],
    ["linux", false],
  ]) {
    const { extensions, calls } = failingCheckExtensions();
    await assert.rejects(
      createCachePlugin(tenantCacheAccountName("tenant-1"), {
        usePlaintextFileOnLinux,
        loadDependencies: () => extensions,
        cacheDir: tempDir(t),
        retry: { attempts: 2, delayMs: 1, platform },
      }),
      /CachePersistenceError/
    );
    assert.deepEqual(calls, [false, false], platform);
  }
});

test("secure cache: seeds from the old slot and keeps Linux plaintext disabled", async (t) => {
  const cacheDir = tempDir(t);
  const legacyName = agentCacheAccountName("agent-1");
  const tenantName = tenantCacheAccountName("tenant-1");
  fs.writeFileSync(path.join(cacheDir, `${legacyName}.cache.json`), "{}");
  const extensions = fakeExtensions({ [legacyName]: SIGNED_IN });

  const plugin = await createSecureCachePlugin(tenantName, () => extensions, {
    legacyAccountName: legacyName,
    tenantId: "tenant-1",
    cacheDir,
  });

  assert.equal(plugin.persistence.options.usePlaintextFileOnLinux, false);
  assert.equal(extensions.slots[tenantName], SIGNED_IN);
});

test("plaintext fallback: seeds the tenant file from the agent's old file", async (t) => {
  const dir = tempDir(t);
  const tenantFile = path.join(dir, "tenant-tenant-1.json");
  const legacyFile = path.join(dir, "agent-1.json");
  fs.writeFileSync(legacyFile, SIGNED_IN);
  const warnings = [];

  const plugin = await createCachePluginWithFallback(
    tenantCacheAccountName("tenant-1"),
    tenantFile,
    (message) => warnings.push(message),
    {
      accountName: agentCacheAccountName("agent-1"),
      fallbackPath: legacyFile,
      tenantId: "tenant-1",
    },
    () => {
      throw new Error("Cannot find module '@azure/msal-node-extensions'");
    }
  );

  assert.equal(typeof plugin.beforeCacheAccess, "function");
  assert.equal(fs.readFileSync(tenantFile, "utf-8"), SIGNED_IN);
  assert.equal(fs.readFileSync(legacyFile, "utf-8"), SIGNED_IN);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /plaintext/i);
});

test("plaintext fallback: keeps an existing tenant file", async (t) => {
  const dir = tempDir(t);
  const tenantFile = path.join(dir, "tenant-tenant-1.json");
  const legacyFile = path.join(dir, "agent-1.json");
  fs.writeFileSync(tenantFile, OTHER_SIGNED_IN);
  fs.writeFileSync(legacyFile, SIGNED_IN);

  await createCachePluginWithFallback(
    tenantCacheAccountName("tenant-1"),
    tenantFile,
    () => {},
    { accountName: agentCacheAccountName("agent-1"), fallbackPath: legacyFile },
    () => {
      throw new Error("no native module");
    }
  );

  assert.equal(fs.readFileSync(tenantFile, "utf-8"), OTHER_SIGNED_IN);
});

test("plaintext fallback: does not copy an old file from another tenant", async (t) => {
  const dir = tempDir(t);
  const tenantFile = path.join(dir, "tenant-tenant-2.json");
  const legacyFile = path.join(dir, "agent-1.json");
  fs.writeFileSync(legacyFile, SIGNED_IN);

  await createCachePluginWithFallback(
    tenantCacheAccountName("tenant-2"),
    tenantFile,
    () => {},
    {
      accountName: agentCacheAccountName("agent-1"),
      fallbackPath: legacyFile,
      tenantId: "tenant-2",
    },
    () => {
      throw new Error("no native module");
    }
  );

  assert.equal(fs.existsSync(tenantFile), false);
});

test("picks the cached account signed in to this tenant", () => {
  const home = { username: "user@contoso.com", tenantId: "home-tenant" };
  const guest = { username: "user@contoso.com", tenantId: "Tenant-1" };
  assert.equal(pickAccount([home, guest], "tenant-1"), guest);
  assert.equal(pickAccount([home], "tenant-1"), home);
  assert.equal(pickAccount([], "tenant-1"), null);
  assert.equal(pickAccount(undefined, "tenant-1"), null);
});

test("opens the old slot with a single storage check", async (t) => {
  const cacheDir = tempDir(t);
  const legacyName = agentCacheAccountName("agent-1");
  const tenantName = tenantCacheAccountName("tenant-1");
  fs.writeFileSync(path.join(cacheDir, `${legacyName}.cache.json`), "{}");
  const extensions = fakeExtensions();
  const createPersistence = extensions.PersistenceCreator.createPersistence;
  const calls = [];
  extensions.PersistenceCreator.createPersistence = async (options) => {
    calls.push(options.accountName);
    if (options.accountName === legacyName) {
      throw persistenceError("CachePersistenceError", "An unknown error occurred.");
    }
    return createPersistence(options);
  };

  await createCachePlugin(tenantName, {
    legacyAccountName: legacyName,
    loadDependencies: () => extensions,
    cacheDir,
    warn: () => {},
    retry: { attempts: 4, delayMs: 1 },
  });

  assert.deepEqual(calls, [tenantName, legacyName]);
});

test("names a failed storage check, not a missing module, when falling back", async (t) => {
  const warnings = [];
  const dir = tempDir(t);

  await createCachePluginWithFallback(
    tenantCacheAccountName("tenant-1"),
    path.join(dir, "tenant.json"),
    (message) => warnings.push(message),
    {},
    () => ({
      ...fakeExtensions(),
      PersistenceCreator: {
        createPersistence: async () => {
          throw persistenceError("CachePersistenceError", "keychain locked");
        },
      },
    })
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failed its check/);
  assert.doesNotMatch(warnings[0], /could not be loaded/);
});
