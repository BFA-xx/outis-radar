import { Global, Module } from '@nestjs/common';
import { type PrismaClient, getPrisma } from '@outis/db';

export const PRISMA = Symbol('PRISMA');

@Global()
@Module({
  providers: [{ provide: PRISMA, useFactory: (): PrismaClient => getPrisma() }],
  exports: [PRISMA],
})
export class PrismaModule {}
