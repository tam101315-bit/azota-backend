import { Injectable } from "@nestjs/common";
import { ExamResult } from "./examResult.entity";
import { Exam } from "../exam/exam.entity";
import { ExamResultAnswerDto } from "./dtos/examResultAnswer.dto";
import { QuestionType } from "src/shared/constant";

// Standard partial-credit scale used in the 2025 THPT "Đúng/Sai" format:
// getting 1 out of 4 statements right earns 10% of the question's score,
// 2/4 earns 25%, 3/4 earns 50%, and all 4/4 earns the full score.
const TRUE_FALSE_PARTIAL_CREDIT: Record<number, number> = {
  0: 0,
  1: 0.1,
  2: 0.25,
  3: 0.5,
  4: 1,
};

function normalizeShortAnswer(value: string): string {
  return (value ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFC")
    .replace(/\s+/g, " ");
}

@Injectable()
export class ExamResultUtilService {
  constructor() {}

  calculateScore(examResult: ExamResult, exam: Exam) {
    const answerExamResult = JSON.parse(examResult.answer);

    const questions = exam.questionParts.reduce((acc, questionPart) => {
      questionPart.questions.forEach((question) => {
        const correctOptionIds = question.options.filter((option) => option.isCorrect).map((option) => option.id);

        acc[question.id] = {
          ...question,
          correctOptionIds,
        };
      });
      return acc;
    }, {});

    let score = 0;
    const questionTotal = Object.keys(questions).length;
    const correctQuestionIds = [];

    Object.values(answerExamResult).forEach((answer: ExamResultAnswerDto) => {
      const { Answered, QuestionId, AnswerContent } = answer;

      if (!Answered) return;

      const question = questions[QuestionId];
      if (!question) return;

      const { scorePerQuestion, type, options, correctOptionIds } = question;

      if (type === QuestionType.TRUE_FALSE) {
        // Every option is one true/false statement (a, b, c, d). The student
        // must judge each one independently; AnswerContent holds their
        // Đúng/Sai pick per option (Index = option id, Content = "Đúng" | "Sai").
        let correctCount = 0;
        options.forEach((option) => {
          const studentPick = AnswerContent.find((a) => a.Index === option.id);
          const studentSaysTrue = studentPick?.Content === "Đúng";
          if (studentSaysTrue === option.isCorrect) {
            correctCount += 1;
          }
        });

        const ratio = TRUE_FALSE_PARTIAL_CREDIT[correctCount] ?? 0;
        score += scorePerQuestion * ratio;

        if (correctCount === options.length) {
          correctQuestionIds.push(QuestionId);
        }
      } else if (type === QuestionType.SHORT_ANSWER) {
        // A single option row holds the accepted correct answer text.
        const correctOption = options.find((option) => option.isCorrect);
        const studentAnswer = AnswerContent[0]?.Content ?? "";

        const isCorrect =
          !!correctOption && normalizeShortAnswer(studentAnswer) === normalizeShortAnswer(correctOption.content);

        if (isCorrect) {
          score += scorePerQuestion;
          correctQuestionIds.push(QuestionId);
        }
      } else {
        // MULTIQUE_CHOICE (default) — unchanged from before.
        const isCorrect = AnswerContent.every((answerContent) => correctOptionIds?.includes(answerContent.Index));

        if (isCorrect) {
          score += scorePerQuestion;
          correctQuestionIds.push(QuestionId);
        }
      }
    });

    return { score, correctQuestionIds, questionTotal };
  }
}
