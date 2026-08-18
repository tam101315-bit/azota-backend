import { Controller, Get, Query, ForbiddenException } from "@nestjs/common";
import { SeederService } from "./seeder.service";
import { Public } from "src/common/decorators/public.decorator";

// Temporary admin-only endpoint to trigger the database seed remotely,
// for hosts like Render's free tier that don't provide shell/SSH access
// to run `npm run seed:prod` directly. Protected by a secret query param
// (SEED_SECRET env var) so random visitors can't trigger it. Safe to
// remove this file (and its registration in seeder.module.ts) once
// seeding is done, if you'd rather not leave it deployed long-term.
@Controller("admin-seed")
export class SeederController {
  constructor(private readonly seederService: SeederService) {}

  @Public()
  @Get()
  async run(@Query("key") key: string) {
    const expected = process.env.SEED_SECRET;
    if (!expected || key !== expected) {
      throw new ForbiddenException("Invalid or missing key");
    }
    await this.seederService.seed();
    return { message: "Seed completed successfully" };
  }
}
