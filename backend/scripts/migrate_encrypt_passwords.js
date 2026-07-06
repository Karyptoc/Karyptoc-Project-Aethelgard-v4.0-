/**
 * AETHELGARD - One-Time Password Encryption Migration
 * backend/scripts/migrate_encrypt_passwords.js
 *
 * Run this ONCE after deploying the crypto.js changes, to encrypt any
 * mt5_password values already sitting in plaintext in client_accounts.
 * New rows created after deployment are already encrypted automatically
 * by copyTrading.js — this script only needs to touch existing rows.
 *
 * Safe to run multiple times — it skips any row whose password is
 * already in the encrypted format (via isEncrypted()).
 *
 * USAGE:
 *   cd backend
 *   node scripts/migrate_encrypt_passwords.js
 *
 * REQUIRES: CREDENTIAL_ENCRYPTION_KEY must already be set in your
 * environment (same key the running backend uses).
 *
 * This script connects directly to Supabase using the service key from
 * your environment — run it from your own machine or a one-off job, not
 * as part of the regular deploy/boot sequence.
 */

// FIX: dotenv.config() with no path loads .env from the current working
// directory - if you run this from the repo root instead of from inside
// backend/, it silently finds nothing and SUPABASE_URL ends up undefined.
// Pointing explicitly at backend/.env (one level up from this script's
// own location) makes this work no matter which folder you run it from.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { supabaseAdmin } = require("../src/services/supabase");
const { encryptSecret, isEncrypted } = require("../src/services/crypto");

async function migrate() {
  console.log("Fetching client_accounts rows with a non-null mt5_password...");

  const { data: rows, error } = await supabaseAdmin
    .from("client_accounts")
    .select("id, name, mt5_password")
    .not("mt5_password", "is", null);

  if (error) {
    console.error("Failed to fetch rows:", error.message);
    process.exit(1);
  }

  if (!rows || rows.length === 0) {
    console.log("No rows with a password found. Nothing to do.");
    return;
  }

  console.log(`Found ${rows.length} rows to check.`);

  let migrated = 0;
  let alreadyEncrypted = 0;
  let failed = 0;

  for (const row of rows) {
    if (isEncrypted(row.mt5_password)) {
      alreadyEncrypted++;
      continue;
    }

    try {
      const encrypted = encryptSecret(row.mt5_password);
      const { error: updateError } = await supabaseAdmin
        .from("client_accounts")
        .update({ mt5_password: encrypted })
        .eq("id", row.id);

      if (updateError) {
        console.error(`  FAILED to update ${row.name} (${row.id}): ${updateError.message}`);
        failed++;
      } else {
        console.log(`  Encrypted password for ${row.name} (${row.id})`);
        migrated++;
      }
    } catch (e) {
      console.error(`  FAILED to encrypt for ${row.name} (${row.id}): ${e.message}`);
      failed++;
    }
  }

  console.log("\n── Migration complete ──");
  console.log(`  Migrated:          ${migrated}`);
  console.log(`  Already encrypted: ${alreadyEncrypted}`);
  console.log(`  Failed:            ${failed}`);

  if (failed > 0) {
    console.log("\nSome rows failed — check the errors above before considering this done.");
    process.exit(1);
  }
}

migrate().then(() => process.exit(0)).catch(e => {
  console.error("Migration script crashed:", e);
  process.exit(1);
});
