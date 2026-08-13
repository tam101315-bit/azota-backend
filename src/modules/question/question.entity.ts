import { Column, Entity, ManyToOne, OneToMany } from "typeorm";
import { BaseEntity } from "src/common/mysql/base.entity";
import { QuestionPart } from "../questionPart/questionPart.entity";
import { Option } from "../option/option.entity";
import { IsNotEmpty } from "class-validator";
import { QuestionType } from "src/shared/constant";

@Entity()
export class Question extends BaseEntity {
  @Column({ type: "text" })
  @IsNotEmpty()
  topic: string;

  @Column({ type: "enum", enum: QuestionType, default: QuestionType.ESSAY })
  type: QuestionType;

  @Column({ type: "float", default: 0 })
  scorePerQuestion: number;

  @Column()
  rawIndex: number;

  // Optional illustration image (Firebase Storage download URL). Nullable
  // so existing questions created before this feature keep working.
  @Column({ type: "text", nullable: true })
  image: string;

  // Optional code snippet (e.g. for Tin học questions), rendered in a
  // monospace block on the student-facing exam page.
  @Column({ type: "text", nullable: true })
  codeBlock: string;

  @ManyToOne(() => QuestionPart, (questionPart) => questionPart.questions)
  questionPart: QuestionPart;

  @OneToMany(() => Option, (option) => option.question)
  options: Option[];
}
