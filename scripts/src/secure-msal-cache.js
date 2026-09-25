/**
 * MSAL persistence that never permits a plaintext fallback.
 */

const { createCachePlugin } = require("./msal-cache");

/**
 * @param {string} accountName Cache slot (e.g. tenantCacheAccountName(tenantId)).
 * @param {() => object} [loadDependencies] For tests.
 * @param {object} [options]
 * @param {string} [options.legacyAccountName] Old per-agent slot to seed an empty slot from.
 * @param {string} [options.tenantId] Only seed from a legacy slot with an account of this tenant.
 * @param {(msg: string) => void} [options.warn]
 * @param {string} [options.cacheDir] For tests.
 */
async function createSecureCachePlugin(
  accountName,
  loadDependencies = () => require("@azure/msal-node-extensions"),
  options = {}
) {
  return createCachePlugin(accountName, {
    legacyAccountName: options.legacyAccountName,
    tenantId: options.tenantId,
    warn: options.warn,
    usePlaintextFileOnLinux: false,
    loadDependencies,
    cacheDir: options.cacheDir,
  });
}

module.exports = { createSecureCachePlugin };
