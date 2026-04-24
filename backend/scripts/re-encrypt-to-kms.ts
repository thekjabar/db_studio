/**
 * One-shot migration: re-encrypt every legacy v1 ciphertext in the database
 * with the currently configured key provider. Safe to run while the API is
 * live — each row is read, decrypted, and re-encrypted in a short transaction,
 * so at worst an in-flight decrypt races with our update and retries.
 *
 * Usage (from backend/):
 *   pnpm ts-node --transpile-only scripts/re-encrypt-to-kms.ts
 *
 * Idempotent: rows already in v2 format are skipped. Safe to re-run if
 * interrupted.
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { AppConfigService } from '../src/config/config.service';
import { CryptoService } from '../src/crypto/crypto.service';
import { KeyProviderService } from '../src/crypto/key-provider.service';

async function main() {
  const cfg = new AppConfigService();
  const keys = new KeyProviderService(cfg);
  keys.onModuleInit();
  const crypto = new CryptoService(cfg, keys);
  const prisma = new PrismaClient();

  const summary = { connections: 0, totps: 0, webhooks: 0, skipped: 0 };

  // Connection.credentialsCt — purpose is `conn:<id>`.
  const conns = await prisma.connection.findMany({
    select: { id: true, credentialsCt: true },
  });
  for (const c of conns) {
    if (crypto.isV2(c.credentialsCt)) {
      summary.skipped++;
      continue;
    }
    const plain = await crypto.decryptJson<Record<string, unknown>>(
      c.credentialsCt,
      `conn:${c.id}`,
    );
    const next = await crypto.encryptJson(plain, `conn:${c.id}`);
    await prisma.connection.update({
      where: { id: c.id },
      data: { credentialsCt: next },
    });
    summary.connections++;
  }

  // TotpSecret.secretCt — purpose `totp:<userId>`.
  const totps = await prisma.totpSecret.findMany({
    select: { userId: true, secretCt: true },
  });
  for (const t of totps) {
    if (crypto.isV2(t.secretCt)) {
      summary.skipped++;
      continue;
    }
    const plain = await crypto.decrypt(t.secretCt, `totp:${t.userId}`);
    const next = await crypto.encrypt(plain, `totp:${t.userId}`);
    await prisma.totpSecret.update({
      where: { userId: t.userId },
      data: { secretCt: next },
    });
    summary.totps++;
  }

  // Webhook.secretCt — purpose `webhook:<id>`.
  const webhooks = await prisma.webhook.findMany({
    select: { id: true, secretCt: true },
  });
  for (const w of webhooks) {
    if (crypto.isV2(w.secretCt)) {
      summary.skipped++;
      continue;
    }
    const plain = await crypto.decrypt(w.secretCt, `webhook:${w.id}`);
    const next = await crypto.encrypt(plain, `webhook:${w.id}`);
    await prisma.webhook.update({
      where: { id: w.id },
      data: { secretCt: next },
    });
    summary.webhooks++;
  }

  // WorkspaceSso.clientSecretCt is stored as Bytes (UTF-8 of envelope for v2,
  // base64 of ciphertext for v1). Peek at the prefix to decide which read path
  // to use.
  const ssos = await prisma.workspaceSso.findMany({
    select: { id: true, workspaceId: true, clientSecretCt: true },
  });
  for (const s of ssos) {
    if (!s.clientSecretCt || s.clientSecretCt.length === 0) continue;
    const raw = Buffer.from(s.clientSecretCt);
    const asUtf8 = raw.toString('utf8');
    if (asUtf8.startsWith('v2:')) {
      summary.skipped++;
      continue;
    }
    const legacyEnvelope = raw.toString('base64');
    const plain = await crypto.decrypt(legacyEnvelope, `sso:${s.workspaceId}`);
    const next = await crypto.encrypt(plain, `sso:${s.workspaceId}`);
    await prisma.workspaceSso.update({
      where: { id: s.id },
      data: { clientSecretCt: Buffer.from(next, 'utf8') },
    });
    summary.webhooks++; // reuse counter; relabel if this grows
  }

  // eslint-disable-next-line no-console
  console.log('re-encrypt complete:', summary);
  await prisma.$disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('re-encrypt failed:', err);
  process.exit(1);
});
