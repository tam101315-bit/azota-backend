import { IsArray, IsNotEmpty, IsString } from "class-validator";

export class AiParseDto {
  @IsArray()
  @IsNotEmpty()
  @IsString({ each: true })
  images: string[];
}
