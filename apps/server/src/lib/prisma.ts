import { PrismaClient } from '@prisma/client';
import { nullParityExtension } from './nullParity.js';

// Prisma talks to MongoDB here (see prisma/schema.prisma). Prisma requires the MongoDB
// deployment to be a replica set because it wraps nested writes in transactions; a
// single-node replica set is enough for development (see `npm run db:setup`).
function createClient() {
  return new PrismaClient().$extends(nullParityExtension);
}

export type AppPrismaClient = ReturnType<typeof createClient>;

// Single shared Prisma instance across the process. In dev with hot reload we stash it
// on globalThis to avoid opening a new connection pool on every reload.
const globalForPrisma = globalThis as unknown as { prisma?: AppPrismaClient };

export const prisma: AppPrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
