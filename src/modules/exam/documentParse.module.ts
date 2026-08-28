import { Module } from "@nestjs/common";
import { MulterModule } from "@nestjs/platform-express";
import { DocumentParseController } from "./documentParse.controller";
import { DocumentParseService } from "./documentParse.service";
import { AiExamParseService } from "./aiExamParse.service";

@Module({
  imports: [
    MulterModule.register({
      limits: { fileSize: 20 * 1024 * 1024 }, // 20MB — đề thi kèm nhiều ảnh WMF có thể khá nặng
    }),
  ],
  controllers: [DocumentParseController],
  providers: [DocumentParseService, AiExamParseService],
  exports: [DocumentParseService],
})
export class DocumentParseModule {}
