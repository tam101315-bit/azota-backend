import { Controller, Post, UploadedFile, UseInterceptors, BadRequestException } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Roles } from "src/common/decorators/roles.decorator";
import { UserRole } from "src/shared/constant";
import { DocumentParseService } from "./documentParse.service";

@ApiTags("Document Parse")
@Controller("exams")
export class DocumentParseController {
  constructor(private readonly documentParseService: DocumentParseService) {}

  @ApiOperation({
    summary: "Đọc file .docx đề thi, tự động tách câu hỏi/đáp án bằng Rule Parser + AI Parser, trả về text đúng cú pháp editor",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBearerAuth()
  @Roles([UserRole.TEACHER])
  @Post("/parse-document")
  @UseInterceptors(FileInterceptor("file"))
  async parseDocument(@UploadedFile() file: Express.Multer.File): Promise<{ text: string; warnings: string[] }> {
    if (!file) {
      throw new BadRequestException("Không có file nào được gửi lên.");
    }

    const isDocx =
      file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      file.originalname.toLowerCase().endsWith(".docx");

    if (!isDocx) {
      throw new BadRequestException("Chỉ hỗ trợ file .docx.");
    }

    return this.documentParseService.parseDocx(file.buffer);
  }
}
