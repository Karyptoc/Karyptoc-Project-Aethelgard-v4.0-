/**
 * AETHELGARD - Credential Encryption
 * backend/src/services/crypto.js
 *
 * Encrypts/decrypts sensitive strings (MT5 passwords) at rest using
 * AES-256-GCM. This does NOT make credentials invisible to your backend
 * process — anything server-side that needs to log into MT5 must still
 * decrypt to plaintext to do so, same as any password manager. What this
 * DOES fix: plaintext passwords sitting in your Supabase database and in
 * plain-text API responses to anything that isn't the bridge itself.
 *
 * REQUIRED ENV VAR: CREDENTIAL_ENCRYPTION_KEY
 *   Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *   Store it in Render/Railway env vars — NOT in git, NOT in .env committed
 *   to any repo. If this key is ever lost, every encrypted credential
 *   becomes permanently unrecoverable — back it up somewhere safe (a
 *   password manager, not a text file in the repo).
 *
 * If you rotate this key, every existing encrypted value must be
 * decrypted with the OLD key and re-encrypted with the NEW one first —
 * see migrate_encrypt_passwords.js for the one-time migration this
 * package includes.
 */

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommended for GCM

function getKey() {
  const keyB64 = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!keyB64) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with: " +
      "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\" " +
      "and add it to your environment variables."
    );
  }
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) {
    throw new Error(`CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes, got ${key.length}.`);
  }
  return key;
}

/**
 * Encrypts a plaintext string. Returns a single string safe to store in
 * a text column: "iv:authTag:ciphertext", each part base64-encoded.
 */
function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === "") return plaintext;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypts a string produced by encryptSecret(). If the input doesn't
 * look like our encrypted format (e.g. it's an old plaintext password
 * from before this migration), returns it unchanged — this lets the
 * system keep working during the transition period covered by
 * migrate_encrypt_passwords.js, rather than crashing on old rows.
 */
function decryptSecret(stored) {
  if (stored === null || stored === undefined || stored === "") return stored;
  const parts = String(stored).split(":");
  if (parts.length !== 3) {
    // Doesn't match our format — assume it's a pre-migration plaintext
    // value. Log so you can track down any rows still needing migration.
    return stored;
  }
  try {
    const key = getKey();
    const [ivB64, authTagB64, cipherB64] = parts;
    const iv = Buffer.from(ivB64, "base64");
    const authTag = Buffer.from(authTagB64, "base64");
    const ciphertext = Buffer.from(cipherB64, "base64");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (e) {
    // Decryption failure — could be wrong key, corrupted data, or a
    // plaintext value that happened to contain two colons. Fail loudly
    // rather than silently returning garbage that gets sent to MT5 login.
    throw new Error(`Failed to decrypt credential: ${e.message}`);
  }
}

/** True if a string is already in our encrypted format (used to avoid double-encrypting). */
function isEncrypted(value) {
  if (!value) return false;
  const parts = String(value).split(":");
  return parts.length === 3 && parts.every(p => /^[A-Za-z0-9+/=]+$/.test(p));
}

module.exports = { encryptSecret, decryptSecret, isEncrypted };
