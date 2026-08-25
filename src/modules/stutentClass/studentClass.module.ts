import { Global, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { JwtModule } from "@nestjs/jwt";
import { StudentClass } from "./studentClass.entity";
import { StudentClassController } from "./studentClass.controller";
import { StudentClassService } from "./studentClass.service";
import { ClassroomModule } from "../classroom/classroom.module";
import { StudentService } from "../student/student.service";
import { HomeworkModule } from "../homework/homework.module";

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([StudentClass]),
    ClassroomModule,
    HomeworkModule,
    JwtModule.register({}),
  ],
  controllers: [StudentClassController],
  providers: [StudentClassService],
  exports: [StudentClassService],
})
export class StudentClassModule {}
