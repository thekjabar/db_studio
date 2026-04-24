/**
 * CLI: pnpm operator:create <email> <password> [--super] [--name="Display Name"]
 *
 * Bootstraps an operator account so a fresh install has someone who can
 * log into admin.yourservice.com. Idempotent by email — running twice with
 * the same email just rotates the password.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';

function parseArgs() {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.error('Usage: pnpm operator:create <email> <password> [--super] [--name="Display Name"]');
    process.exit(1);
  }
  const [email, password, ...rest] = argv;
  const isSuper = rest.includes('--super');
  const nameArg = rest.find((a) => a.startsWith('--name='));
  const displayName = nameArg ? nameArg.slice('--name='.length).replace(/^["']|["']$/g, '') : undefined;
  return { email, password, isSuper, displayName };
}

async function main() {
  const { email, password, isSuper, displayName } = parseArgs();
  if (password.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const existing = await prisma.operator.findUnique({ where: { email } });
    if (existing) {
      await prisma.operator.update({
        where: { email },
        data: { passwordHash, displayName: displayName ?? existing.displayName, isSuper: isSuper || existing.isSuper, disabledAt: null },
      });
      console.log(`Updated operator ${email} (isSuper=${isSuper || existing.isSuper})`);
    } else {
      await prisma.operator.create({
        data: { email, passwordHash, displayName, isSuper },
      });
      console.log(`Created operator ${email} (isSuper=${isSuper})`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
