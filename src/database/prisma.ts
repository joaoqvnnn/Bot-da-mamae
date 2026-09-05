// src/database/prisma.ts
import { PrismaClient } from '@prisma/client';

// Instância única do Prisma Client para toda a aplicação
export const prisma = new PrismaClient();
