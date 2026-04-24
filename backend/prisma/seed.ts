import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// Seed passwords MUST come from env in any real deploy. If the env vars
// aren't set we generate a random password per-user and print it once —
// never commit defaults. Ship the .env.example with the expected names.
function passwordFor(role: string, fallbackEnv: string): string {
  const fromEnv = process.env[fallbackEnv];
  if (fromEnv && fromEnv.length >= 8) return fromEnv;
  const generated = randomBytes(12).toString('base64url');
  console.warn(
    `  !! ${fallbackEnv} not set — generated a random ${role} password (save this, it won't be shown again).`,
  );
  return generated;
}

const USERS = [
  {
    email: 'owner@dbdash.local',
    password: passwordFor('owner', 'SEED_OWNER_PASSWORD'),
    displayName: 'Owner Example',
  },
  {
    email: 'editor@dbdash.local',
    password: passwordFor('editor', 'SEED_EDITOR_PASSWORD'),
    displayName: 'Editor Example',
  },
  {
    email: 'viewer@dbdash.local',
    password: passwordFor('viewer', 'SEED_VIEWER_PASSWORD'),
    displayName: 'Viewer Example',
  },
  {
    email: 'demo@dbdash.local',
    password: passwordFor('demo', 'SEED_DEMO_PASSWORD'),
    displayName: 'Demo User',
  },
];

async function main() {
  console.log('Seeding users...');
  for (const u of USERS) {
    const passwordHash = await argon2.hash(u.password, { type: argon2.argon2id });
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: { displayName: u.displayName },
      create: {
        email: u.email,
        passwordHash,
        displayName: u.displayName,
      },
    });
    console.log(`  ${user.email.padEnd(28)} password: ${u.password}`);
  }
  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
