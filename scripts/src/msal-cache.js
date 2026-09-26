/**
 * msal-cache.js — MSAL token-cache plugin backed by OS-native secure storage.
 *
 * Uses @azure/msal-node-extensions to persist MSAL's token cache via the
 * platform credential manager (Keychain on macOS, DPAPI on Windows, libsecret
 * on Linux). The on-disk cache file (~/.copilot-studio-cli/<account>.cache.json)
 * holds no readable token on macOS and Windows: an empty marker next to the
 * keychain entry, or a DPAPI-encrypted blob. On Linux without a working
 * libsecret, msal-node-extensions stores the cache in that file as plaintext.
 *
 * @azure/msal-node-extensions and keytar are native modules that cannot be
 * bundled by esbuild; they are installed into the plugin data dir at SessionStart
 * (see hooks/set-env-vars.js + scripts/native-deps.json) and resolved at runtime
 * via the NODE_PATH banner injected by the build. When they cannot be loaded
 * (e.g. running the bundle standalone before the deps are provisioned, or a
 * machine where keytar failed to build), we fall back to a plaintext file cache
 * so the flow keeps working, with a clear warning on stderr.
 *
 * One cache slot per tenant (chat-tenant-<TenantId>) is shared by every agent in that tenant, so
 * a single device-code sign-in covers all of them. Older versions kept one slot per agent
 * (chat-<AgentId>); when the tenant slot is still empty, the agent's old slot is copied into it
 * once, so upgrading does not force a new sign-in.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const CACHE_DIR = path.join(os.homedir(), ".copilot-studio-cli");
const SERVICE_NAME = "copilot-studio-cli";

function slotPart(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9._-]/g, "_");
}

// Shared slot for every agent in a tenant.
function tenantCacheAccountName(tenantId) {
  return `chat-tenant-${slotPart(tenantId)}`;
}

// Per-agent slot used before the cache became per-tenant. Only read, to seed the tenant slot.
function agentCacheAccountName(agentId) {
  return `chat-${slotPart(agentId)}`;
}

function cacheFilePath(accountName, cacheDir = CACHE_DIR) {
  return path.join(cacheDir, `${accountName}.cache.json`);
}

// Tenants an MSAL account entity belongs to: its home tenant (`realm`) and every tenant it has a
// profile in (`tenantProfiles`, serialized as JSON strings), so guest users count too.
function accountTenants(account) {
  const profiles = Array.isArray(account.tenantProfiles) ? account.tenantProfiles : [];
  const tenants = profiles.map((profile) => {
    try {
      return (typeof profile === "string" ? JSON.parse(profile) : profile).tenantId;
    } catch {
      return undefined;
    }
  });
  return [account.realm, ...tenants].map((t) => String(t || "").toLowerCase()).filter(Boolean);
}

// True when a serialized MSAL cache holds at least one signed-in account; with `tenantId`, at least
// one account that belongs to that tenant.
function cacheHasAccount(serialized, tenantId) {
  if (!serialized) return false;
  try {
    const account = JSON.parse(serialized).Account;
    if (!account || typeof account !== "object") return false;
    const accounts = Object.values(account);
    if (!tenantId) return accounts.length > 0;
    const tenant = String(tenantId).toLowerCase();
    return accounts.some((a) => a && accountTenants(a).includes(tenant));
  } catch {
    return false;
  }
}

// The cache is shared by every agent in a tenant and may hold more than one account; prefer one
// signed in to this tenant. MSAL lists a guest account once per tenant profile, with its tenantId.
function pickAccount(accounts, tenantId) {
  if (!accounts || accounts.length === 0) return null;
  const tenant = String(tenantId || "").toLowerCase();
  return (
    accounts.find((a) => a && String(a.tenantId || "").toLowerCase() === tenant) || accounts[0]
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Same lockfile protocol as msal-node-extensions' CrossPlatformLock (exclusive create of
// `<cache file>.lockfile`, removed on release), so a concurrent chat run's PersistenceCachePlugin
// waits for us and we wait for it.
async function withLockFile(lockPath, fn, { retries = 50, delayMs = 100 } = {}) {
  let handle;
  for (let attempt = 0; ; attempt++) {
    try {
      handle = await fs.promises.open(lockPath, "wx+");
      break;
    } catch (e) {
      if ((e.code !== "EEXIST" && e.code !== "EPERM") || attempt >= retries) throw e;
      await sleep(delayMs);
    }
  }
  try {
    await handle.write(String(process.pid));
    return await fn();
  } finally {
    await handle.close();
    await fs.promises.unlink(lockPath).catch(() => {});
  }
}

/**
 * Copy the legacy per-agent cache into the tenant cache when the tenant cache has no account yet.
 * `target` and `legacy` only need load()/save(). With `tenantId`, the legacy cache is copied only if
 * it holds an account of that tenant. Never throws: if the copy fails the caller just falls back to
 * a device-code sign-in, as it would without a legacy cache.
 *
 * @param {object} args
 * @param {{ load: () => Promise<string|null>, save: (s: string) => Promise<void> }} args.target
 * @param {{ load: () => Promise<string|null> }} args.legacy
 * @param {string} [args.tenantId] Only copy a legacy cache with an account of this tenant.
 * @param {string} [args.lockPath] Lockfile to hold during the copy (the target's `.lockfile`).
 * @param {(msg: string) => void} [args.warn]
 * @param {{ retries?: number, delayMs?: number }} [args.lockOptions] For tests.
 * @returns {Promise<boolean>} true when the legacy cache was copied.
 */
async function seedFromLegacyCache({ target, legacy, tenantId, lockPath, warn, lockOptions }) {
  const copy = async () => {
    if (cacheHasAccount(await target.load())) return false;
    const data = await legacy.load();
    if (!cacheHasAccount(data, tenantId)) return false;
    await target.save(data);
    return true;
  };
  try {
    return lockPath ? await withLockFile(lockPath, copy, lockOptions) : await copy();
  } catch (e) {
    if (typeof warn === "function") {
      warn(`Could not reuse the previous per-agent sign-in (${e && e.message ? e.message : e}).`);
    }
    return false;
  }
}

// createPersistence() checks the store by writing, reading and deleting one fixed validation entry
// that every process shares, so two chat runs starting together can fail that check even though
// the store works. Retry a failed check (CachePersistenceError) a few times with jitter before
// treating encrypted storage as unavailable. That error covers every failed check, so a store that
// really is broken also waits up to about a second before the fallback. Other errors are not
// retried.
//
// On Linux, createPersistence() itself swallows a failed check and switches to a plaintext file
// when usePlaintextFileOnLinux is set, so the retries run with it off and the plaintext file is
// allowed only after the last attempt.
async function createEncryptedPersistence(
  extensions,
  accountName,
  usePlaintextFileOnLinux,
  cacheDir,
  { attempts = 4, delayMs = 100, platform = process.platform } = {}
) {
  const { PersistenceCreator, DataProtectionScope } = extensions;
  const create = (plaintextOnLinux) =>
    PersistenceCreator.createPersistence({
      cachePath: cacheFilePath(accountName, cacheDir),
      dataProtectionScope: DataProtectionScope.CurrentUser,
      serviceName: SERVICE_NAME,
      accountName,
      usePlaintextFileOnLinux: plaintextOnLinux,
    });
  for (let attempt = 1; ; attempt++) {
    try {
      return await create(false);
    } catch (e) {
      if (!e || e.errorCode !== "CachePersistenceError") throw e;
      if (attempt >= attempts) {
        if (platform === "linux" && usePlaintextFileOnLinux) return create(true);
        throw e;
      }
      await sleep(delayMs * attempt + Math.random() * delayMs);
    }
  }
}

/**
 * Encrypted cache plugin via @azure/msal-node-extensions.
 * Throws if the native extension cannot be required.
 *
 * @param {string} accountName  Cache slot (e.g. tenantCacheAccountName(tenantId)).
 * @param {object} [options]
 * @param {string} [options.legacyAccountName] Old slot to seed an empty `accountName` slot from.
 * @param {string} [options.tenantId] Only seed from a legacy slot with an account of this tenant.
 * @param {boolean} [options.usePlaintextFileOnLinux=true] Passed to msal-node-extensions.
 * @param {(msg: string) => void} [options.warn]
 * @param {() => object} [options.loadDependencies] For tests.
 * @param {string} [options.cacheDir] For tests.
 * @param {{ attempts?: number, delayMs?: number, platform?: string }} [options.retry] For tests.
 */
async function createCachePlugin(accountName, options = {}) {
  const {
    legacyAccountName,
    tenantId,
    usePlaintextFileOnLinux = true,
    warn,
    loadDependencies = () => require("@azure/msal-node-extensions"),
    cacheDir = CACHE_DIR,
    retry,
  } = options;
  const extensions = loadDependencies();
  const persistence = await createEncryptedPersistence(
    extensions,
    accountName,
    usePlaintextFileOnLinux,
    cacheDir,
    retry
  );

  // Open the legacy slot only while the tenant slot has no account and only if the legacy slot was
  // ever written: creating a persistence creates its file and runs a storage check.
  if (
    legacyAccountName &&
    legacyAccountName !== accountName &&
    fs.existsSync(cacheFilePath(legacyAccountName, cacheDir))
  ) {
    let signedIn = false;
    try {
      signedIn = cacheHasAccount(await persistence.load());
    } catch {
      // Checked again under the lock while seeding.
    }
    try {
      if (!signedIn) {
        // One attempt only: if the old slot can't be opened, the user just signs in again.
        const legacy = await createEncryptedPersistence(
          extensions,
          legacyAccountName,
          usePlaintextFileOnLinux,
          cacheDir,
          { ...retry, attempts: 1 }
        );
        await seedFromLegacyCache({
          target: persistence,
          legacy,
          tenantId,
          lockPath: `${persistence.getFilePath()}.lockfile`,
          warn,
        });
      }
    } catch (e) {
      if (typeof warn === "function") {
        warn(`Could not reuse the previous per-agent sign-in (${e && e.message ? e.message : e}).`);
      }
    }
  }
  return new extensions.PersistenceCachePlugin(persistence);
}

/**
 * Plaintext file-cache plugin (the pre-encryption behavior). Used only as a
 * fallback when the native extension is unavailable.
 */
function createPlaintextCachePlugin(cachePath) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  } catch {
    // best effort
  }
  return {
    beforeCacheAccess: async (context) => {
      if (fs.existsSync(cachePath)) {
        context.tokenCache.deserialize(fs.readFileSync(cachePath, "utf-8"));
      }
    },
    afterCacheAccess: async (context) => {
      if (context.cacheHasChanged) {
        fs.writeFileSync(cachePath, context.tokenCache.serialize());
      }
    },
  };
}

function plaintextFileStore(filePath) {
  return {
    load: async () => (fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null),
    save: async (contents) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents);
    },
  };
}

/**
 * Preferred entry point: try OS-native encrypted storage, and if the native
 * module can't be loaded, transparently fall back to a plaintext file cache.
 *
 * @param {string} accountName  Cache slot (e.g. tenantCacheAccountName(tenantId)).
 * @param {string} fallbackPath Plaintext cache path used only on fallback.
 * @param {(msg: string) => void} [warn] Optional stderr logger.
 * @param {object} [legacy] Old per-agent cache to seed an empty slot from.
 * @param {string} [legacy.accountName] Old encrypted slot.
 * @param {string} [legacy.fallbackPath] Old plaintext cache path.
 * @param {string} [legacy.tenantId] Only seed from an old cache with an account of this tenant.
 * @param {() => object} [loadDependencies] For tests.
 */
async function createCachePluginWithFallback(
  accountName,
  fallbackPath,
  warn,
  legacy = {},
  loadDependencies
) {
  try {
    return await createCachePlugin(accountName, {
      legacyAccountName: legacy.accountName,
      tenantId: legacy.tenantId,
      warn,
      loadDependencies,
    });
  } catch (e) {
    if (typeof warn === "function") {
      const detail = e && e.message ? e.message : e;
      warn(
        e && e.errorCode === "CachePersistenceError"
          ? `Encrypted token storage failed its check after several attempts (${detail}). ` +
              "Falling back to a plaintext token cache."
          : "Encrypted token storage unavailable (@azure/msal-node-extensions could not be " +
              `loaded: ${detail}). Falling back to a plaintext token cache. Run a fresh ` +
              "session so the plugin can install its native dependencies, or reinstall the " +
              "plugin, to enable OS-keychain encryption."
      );
    }
    if (legacy.fallbackPath && legacy.fallbackPath !== fallbackPath) {
      await seedFromLegacyCache({
        target: plaintextFileStore(fallbackPath),
        legacy: plaintextFileStore(legacy.fallbackPath),
        tenantId: legacy.tenantId,
        warn,
      });
    }
    return createPlaintextCachePlugin(fallbackPath);
  }
}

module.exports = {
  agentCacheAccountName,
  cacheHasAccount,
  createCachePlugin,
  createPlaintextCachePlugin,
  createCachePluginWithFallback,
  pickAccount,
  seedFromLegacyCache,
  tenantCacheAccountName,
  withLockFile,
  CACHE_DIR,
  SERVICE_NAME,
};
