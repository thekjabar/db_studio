import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// Roles (OWNER / EDITOR / VIEWER) are per-Connection, not per-User —
// they live on ConnectionMember. These seed users are intended to be
// assigned those roles on connections created at runtime.
const USERS = [
  { email: 'owner@dbdash.local',   password: 'Owner!2345',  displayName: 'Owner Example' },
  { email: 'editor@dbdash.local',  password: 'Editor!2345', displayName: 'Editor Example' },
  { email: 'viewer@dbdash.local',  password: 'Viewer!2345', displayName: 'Viewer Example' },
  { email: 'demo@dbdash.local',    password: 'Demo!23456',  displayName: 'Demo User' },
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
