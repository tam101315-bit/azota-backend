import { Injectable, BadRequestException, InternalServerErrorException } from "@nestjs/common";
import * as mammoth from "mammoth";
import * as cheerio from "cheerio";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { AiExamParseService } from "./aiExamParse.service";

const execAsync = promisify(exec);

// ── Kiểu dữ liệu nội bộ ──────────────────────────────────────────────────

type PartRoman = "I" | "II" | "III";
const PART_NUMBER: Record<PartRoman, number> = { I: 1, II: 2, III: 3 };

interface RawQuestionBlock {
  part: PartRoman;
  questionNumber: number;
  /** Các đoạn HTML (đã có placeholder ảnh __IMG_N__) thuộc câu hỏi này, theo đúng thứ tự */
  htmlChunks: string[];
}

interface AnswerKeyPartI {
  [questionNumber: number]: "A" | "B" | "C" | "D";
}
interface AnswerKeyPartII {
  [questionNumber: number]: { a?: boolean; b?: boolean; c?: boolean; d?: boolean };
}

interface BuiltQuestionMC {
  type: "MC";
  content: string;
  options: { A: string; B: string; C: string; D: string };
  correct: "A" | "B" | "C" | "D";
}
interface BuiltQuestionTF {
  type: "TF";
  content: string;
  statements: { label: "a" | "b" | "c" | "d"; text: string; isTrue: boolean }[];
}
interface BuiltQuestionSA {
  type: "SA";
  content: string;
  answer: string;
}
type BuiltQuestion = BuiltQuestionMC | BuiltQuestionTF | BuiltQuestionSA;

// Khớp CHÍNH XÁC với interface ParsedQuestion (MC/TF/SA) trong uploadExam.tsx (frontend)
// để trang review "Tạo đề từ tệp PDF/Word" dùng thẳng, không cần chuyển đổi gì thêm.
export interface ParsedQuestionOutput {
  id: string;
  type: "MC" | "TF" | "SA";
  partTitle: string;
  content: string;
  answers?: { A: string; B: string; C: string; D: string };
  correct?: "A" | "B" | "C" | "D" | null;
  statements?: { label: "a" | "b" | "c" | "d"; text: string; isTrue: boolean | null }[];
  answer?: string;
  include: boolean;
}

// ── Service ───────────────────────────────────────────────────────────────

@Injectable()
export class DocumentParseService {
  constructor(private readonly aiExamParseService: AiExamParseService) {}

  async parseDocx(fileBuffer: Buffer): Promise<{ questions: ParsedQuestionOutput[]; warnings: string[] }> {
    const warnings: string[] = [];

    // 1. Document Parser: docx -> HTML (giữ nguyên vị trí ảnh dạng placeholder __IMG_N__)
    const { html, images } = await this.extractHtmlWithImagePlaceholders(fileBuffer);

    // 2. Convert toàn bộ ảnh WMF nhúng -> PNG base64 (ảnh thường như png/jpg thì giữ nguyên)
    const pngByPlaceholder = await this.convertAllImagesToPng(images, warnings);

    const $ = cheerio.load(html);

    // 3. Rule Parser: tách thành từng câu hỏi theo Phần/Câu
    const blocks = this.groupIntoQuestionBlocks($);

    // 4. Đọc bảng ĐÁP ÁN PHẦN I / PHẦN II (rule-based, không cần AI)
    const { answerKeyI, answerKeyII } = this.extractAnswerKeyTables($);

    // 5. Thu thập TOÀN BỘ placeholder ảnh công thức cần OCR (Phần I + Phần II),
    //    gửi 1 lần duy nhất cho AI để tiết kiệm chi phí & thời gian
    const formulaPlaceholders = this.collectFormulaPlaceholders(blocks, /* excludePart */ "III");
    // 5+7. 2 việc này ĐỘC LẬP nhau (OCR công thức Phần I/II, và giải Phần III) -> chạy song song
    // thay vì tuần tự, giảm đáng kể tổng thời gian chờ AI.
    const [formulaTextByPlaceholder, questionsIII] = await Promise.all([
      this.recognizeFormulasBatch(formulaPlaceholders, pngByPlaceholder, warnings),
      this.buildPartIIIQuestions(blocks, pngByPlaceholder, warnings),
    ]);

    // 6. Dựng câu hỏi Phần I (MC) và Phần II (TF) — rule-based + thay placeholder ảnh bằng text AI đã đọc
    const questionsI = this.buildPartIQuestions(blocks, answerKeyI, pngByPlaceholder, formulaTextByPlaceholder, warnings);
    const questionsII = this.buildPartIIQuestions(blocks, answerKeyII, pngByPlaceholder, formulaTextByPlaceholder, warnings);

    // 8. Validator
    this.validateQuestions(questionsI, questionsII, questionsIII, warnings);

    // 9. Chuyển sang đúng cấu trúc ParsedQuestion[] mà trang "Tạo đề từ tệp PDF/Word" (uploadExam.tsx) đang dùng
    const questions = this.buildParsedQuestionsOutput(questionsI, questionsII, questionsIII);

    return { questions, warnings };
  }

  private buildParsedQuestionsOutput(
    questionsI: BuiltQuestionMC[],
    questionsII: BuiltQuestionTF[],
    questionsIII: BuiltQuestionSA[]
  ): ParsedQuestionOutput[] {
    const output: ParsedQuestionOutput[] = [];

    questionsI.forEach((q, idx) => {
      output.push({
        id: `docx_I_${idx + 1}_${Date.now()}`,
        type: "MC",
        partTitle: "Phần 1. Trắc nghiệm",
        content: q.content,
        answers: q.options,
        correct: q.correct,
        include: true,
      });
    });

    questionsII.forEach((q, idx) => {
      output.push({
        id: `docx_II_${idx + 1}_${Date.now()}`,
        type: "TF",
        partTitle: "Phần 2. Đúng/Sai",
        content: q.content,
        statements: q.statements,
        include: true,
      });
    });

    questionsIII.forEach((q, idx) => {
      output.push({
        id: `docx_III_${idx + 1}_${Date.now()}`,
        type: "SA",
        partTitle: "Phần 3. Trả lời ngắn",
        content: q.content,
        answer: q.answer,
        include: true,
      });
    });

    return output;
  }

  // ── Bước 1: Document Parser ──────────────────────────────────────────────

  private async extractHtmlWithImagePlaceholders(
    fileBuffer: Buffer
  ): Promise<{ html: string; images: Map<string, { buffer: Buffer; contentType: string }> }> {
    let counter = 0;
    const images = new Map<string, { buffer: Buffer; contentType: string }>();

    const options = {
      convertImage: mammoth.images.imgElement(async (image: any) => {
        counter++;
        const placeholder = `__IMG_${counter}__`;
        const buffer: Buffer = await image.read();
        images.set(placeholder, { buffer, contentType: image.contentType });
        return { src: placeholder };
      }),
    };

    let result;
    try {
      result = await mammoth.convertToHtml({ buffer: fileBuffer }, options as any);
    } catch (err) {
      throw new BadRequestException("Không đọc được file .docx. File có thể bị hỏng hoặc không đúng định dạng.");
    }

    return { html: result.value, images };
  }

  private async convertAllImagesToPng(
    images: Map<string, { buffer: Buffer; contentType: string }>,
    warnings: string[]
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const entries = Array.from(images.entries());

    // Convert song song theo từng lô (CONCURRENCY ảnh cùng lúc) thay vì tuần tự từng ảnh một —
    // với đề thi có hàng trăm công thức WMF, xử lý tuần tự dễ vượt quá timeout của server.
    const CONCURRENCY = 20;
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const batch = entries.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async ([placeholder, { buffer, contentType }]) => {
          try {
            const png = await this.convertOneImageToPngBase64(buffer, contentType);
            result.set(placeholder, png);
          } catch (err) {
            warnings.push(`Không convert được ảnh ${placeholder} (${contentType}): ${err}`);
          }
        })
      );
    }

    return result;
  }

  private async convertOneImageToPngBase64(buffer: Buffer, contentType: string): Promise<string> {
    const isWmf = contentType.includes("wmf") || contentType.includes("x-wmf") || contentType.includes("emf");

    if (!isWmf) {
      // Đã là ảnh raster bình thường (png/jpg) -> chỉ cần base64 hoá
      return buffer.toString("base64");
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wmf-conv-"));
    try {
      const inputPath = path.join(tmpDir, "input.wmf");
      const pngPath = path.join(tmpDir, "out.png");

      await fs.writeFile(inputPath, buffer);

      // Dùng wmf2gd (render thẳng ra PNG, bỏ qua bước SVG/XML trung gian) thay vì wmf2svg + rsvg-convert.
      // Cách cũ (wmf2svg -> SVG -> rsvg-convert) hay lỗi vì một số font/ký tự đặc biệt trong công thức
      // khiến wmf2svg sinh ra SVG chứa byte không hợp lệ UTF-8, làm rsvg-convert đọc XML thất bại.
      // wmf2gd tránh hoàn toàn vấn đề này vì không đi qua định dạng text/XML nào cả.
      await execAsync(`wmf2gd -o "${pngPath}" -t png --maxwidth=500 --maxpect "${inputPath}"`);

      const pngBuffer = await fs.readFile(pngPath);
      return pngBuffer.toString("base64");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ── Bước 3: Rule Parser — gom nhóm theo Phần / Câu ─────────────────────────

  private groupIntoQuestionBlocks($: cheerio.CheerioAPI): RawQuestionBlock[] {
    const blocks: RawQuestionBlock[] = [];
    let currentPart: PartRoman | null = null;
    let current: RawQuestionBlock | null = null;

    const partHeaderRegex = /^PHẦN\s+(I{1,3})\s*[:.]/i;
    const questionStartRegex = /^Câu\s+(\d+)\s*[:.]/i;
    const stopRegex = /^(ĐÁP ÁN|LỜI GIẢI)/i;

    const elements = $("body").children().toArray();

    for (const el of elements) {
      const tag = (el as any).tagName;
      const plainText = $(el).text().trim();

      // Dừng thu thập khi chạm phần đáp án / lời giải chi tiết ở cuối file
      if (stopRegex.test(plainText)) {
        break;
      }

      const partMatch = plainText.match(partHeaderRegex);
      if (partMatch) {
        currentPart = partMatch[1].toUpperCase() as PartRoman;
        current = null;
        continue;
      }

      if (!currentPart) continue; // bỏ qua phần đầu đề (tiêu đề, họ tên, số báo danh...)

      const html = $.html(el);

      const questionMatch = plainText.match(questionStartRegex);
      if (questionMatch && tag === "p") {
        current = {
          part: currentPart,
          questionNumber: parseInt(questionMatch[1], 10),
          htmlChunks: [html],
        };
        blocks.push(current);
        continue;
      }

      if (current) {
        current.htmlChunks.push(html);
      }
    }

    return blocks;
  }

  // ── Bước 4: Đọc bảng ĐÁP ÁN (rule-based, đáng tin cậy nhất) ────────────────

  private extractAnswerKeyTables($: cheerio.CheerioAPI): {
    answerKeyI: AnswerKeyPartI;
    answerKeyII: AnswerKeyPartII;
  } {
    const answerKeyI: AnswerKeyPartI = {};
    const answerKeyII: AnswerKeyPartII = {};

    // Tìm đoạn text "ĐÁP ÁN PHẦN I" / "ĐÁP ÁN PHẦN II" rồi lấy <table> ngay sau đó
    const elements = $("body").children().toArray();

    for (let i = 0; i < elements.length; i++) {
      const text = $(elements[i]).text().trim();

      if (/ĐÁP ÁN PHẦN I\b/i.test(text) && !/PHẦN II|PHẦN III/i.test(text)) {
        const table = this.findNextTable($, elements, i);
        if (table) this.parseAnswerKeyITable($, table, answerKeyI);
      }

      if (/ĐÁP ÁN PHẦN II\b/i.test(text)) {
        const table = this.findNextTable($, elements, i);
        if (table) this.parseAnswerKeyIITable($, table, answerKeyII);
      }
    }

    return { answerKeyI, answerKeyII };
  }

  private findNextTable($: cheerio.CheerioAPI, elements: any[], fromIndex: number): any | null {
    for (let j = fromIndex; j < Math.min(fromIndex + 5, elements.length); j++) {
      if ((elements[j] as any).tagName === "table") return elements[j];
    }
    return null;
  }

  /**
   * Bảng ĐÁP ÁN PHẦN I có dạng nhiều khối "Câu | 1 2 3 ... 9 | Đáp án | B A B ... B" lặp lại.
   * Duyệt toàn bộ ô theo hàng, mỗi khi gặp hàng số câu rồi tới hàng "Đáp án" thì map theo vị trí cột.
   */
  private parseAnswerKeyITable($: cheerio.CheerioAPI, table: any, out: AnswerKeyPartI) {
    const rows = $(table).find("tr").toArray();
    let pendingNumbers: number[] = [];

    for (const row of rows) {
      const cells = $(row)
        .find("td, th")
        .toArray()
        .map((c) => $(c).text().trim());

      if (cells.length === 0) continue;

      const isNumberRow = cells.every((c) => c === "" || /^\d+$/.test(c) || /^câu$/i.test(c));
      const isAnswerRow = cells.some((c) => /^[A-D]$/.test(c));

      if (isNumberRow && cells.some((c) => /^\d+$/.test(c))) {
        pendingNumbers = cells.filter((c) => /^\d+$/.test(c)).map((c) => parseInt(c, 10));
        continue;
      }

      if (isAnswerRow) {
        const answers = cells.filter((c) => /^[A-D]$/.test(c));
        answers.forEach((ans, idx) => {
          const qNum = pendingNumbers[idx];
          if (qNum) out[qNum] = ans as "A" | "B" | "C" | "D";
        });
      }
    }
  }

  /**
   * Bảng ĐÁP ÁN PHẦN II dạng "Câu | a | b | c | d" rồi các hàng "1 | Đ | S | S | S", "2 | S | Đ | Đ | Đ"...
   */
  private parseAnswerKeyIITable($: cheerio.CheerioAPI, table: any, out: AnswerKeyPartII) {
    const rows = $(table).find("tr").toArray();

    for (const row of rows) {
      const cells = $(row)
        .find("td, th")
        .toArray()
        .map((c) => $(c).text().trim());

      if (cells.length < 5) continue;
      if (!/^\d+$/.test(cells[0])) continue; // bỏ qua hàng tiêu đề "Câu a b c d"

      const qNum = parseInt(cells[0], 10);
      out[qNum] = {
        a: cells[1] === "Đ",
        b: cells[2] === "Đ",
        c: cells[3] === "Đ",
        d: cells[4] === "Đ",
      };
    }
  }

  // ── Bước 5: Thu thập & OCR hàng loạt công thức (Phần I + II) ──────────────

  private collectFormulaPlaceholders(blocks: RawQuestionBlock[], excludePart: PartRoman): string[] {
    const placeholders: string[] = [];
    const regex = /__IMG_\d+__/g;

    for (const block of blocks) {
      if (block.part === excludePart) continue;
      for (const chunk of block.htmlChunks) {
        const matches = chunk.match(regex);
        if (matches) placeholders.push(...matches);
      }
    }
    return placeholders;
  }

  private async recognizeFormulasBatch(
    placeholders: string[],
    pngByPlaceholder: Map<string, string>,
    warnings: string[]
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (placeholders.length === 0) return result;

    const validPlaceholders = placeholders.filter((p) => pngByPlaceholder.has(p));

    // QUAN TRỌNG: nhiều câu/đáp án dùng chung 1 công thức GIỐNG HỆT NHAU (vd: H2O, CO2, các ion quen
    // thuộc lặp lại nhiều lần trong đề) -> nếu OCR riêng từng vị trí sẽ gửi trùng lặp rất nhiều ảnh
    // giống nhau cho AI, lãng phí thời gian. Gom theo nội dung ảnh (base64) giống hệt nhau, chỉ OCR
    // MỖI ẢNH KHÁC NHAU 1 LẦN DUY NHẤT, rồi áp kết quả cho toàn bộ vị trí dùng chung ảnh đó.
    const placeholdersByImage = new Map<string, string[]>(); // base64 ảnh -> danh sách placeholder dùng ảnh này
    for (const p of validPlaceholders) {
      const img = pngByPlaceholder.get(p)!;
      if (!placeholdersByImage.has(img)) placeholdersByImage.set(img, []);
      placeholdersByImage.get(img)!.push(p);
    }
    const uniqueImages = Array.from(placeholdersByImage.keys());

    if (uniqueImages.length < validPlaceholders.length) {
      warnings.push(
        `Tối ưu: ${validPlaceholders.length} vị trí công thức nhưng chỉ có ${uniqueImages.length} ảnh khác nhau (đã loại trùng trước khi gửi AI).`
      );
    }

    // Batch nhỏ hơn (15 ảnh/lô) để mỗi lần gọi AI phản hồi nhanh hơn, bù lại bằng chạy nhiều lô song song hơn
    const BATCH_SIZE = 15;
    const batches: string[][] = [];
    for (let i = 0; i < uniqueImages.length; i += BATCH_SIZE) {
      batches.push(uniqueImages.slice(i, i + BATCH_SIZE));
    }

    // Gọi các lô SONG SONG (network-bound, không tốn CPU server -> tăng concurrency khá an toàn)
    const BATCH_CONCURRENCY = 6;
    for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) {
      const group = batches.slice(i, i + BATCH_CONCURRENCY);
      await Promise.all(
        group.map(async (batchImages, idxInGroup) => {
          const batchIndex = i + idxInGroup;
          try {
            const texts = await this.aiExamParseService.recognizeFormulas(batchImages);
            batchImages.forEach((img, idx) => {
              const text = texts[idx] || "";
              // Áp kết quả cho MỌI placeholder dùng chung ảnh này
              placeholdersByImage.get(img)!.forEach((placeholder) => result.set(placeholder, text));
            });
          } catch (err) {
            warnings.push(`Lỗi khi AI đọc công thức (lô ${batchIndex + 1}/${batches.length}): ${err}`);
            batchImages.forEach((img) => {
              placeholdersByImage.get(img)!.forEach((placeholder) => result.set(placeholder, ""));
            });
          }
        })
      );
    }

    return result;
  }

  // ── HTML fragment -> text thuần (giữ placeholder ảnh) ──────────────────────

  private htmlToPlainTextWithPlaceholders(html: string): string {
    // QUAN TRỌNG: cheerio's $.text() bỏ qua hẳn thẻ <img> (không có text content).
    // Phải thay <img src="__IMG_N__"> thành chính text "__IMG_N__" TRƯỚC khi gọi .text(),
    // nếu không toàn bộ placeholder ảnh công thức sẽ biến mất khỏi text.
    const htmlWithImgAsText = html.replace(/<img[^>]*src="(__IMG_\d+__)"[^>]*>/g, "$1");

    const $ = cheerio.load(htmlWithImgAsText, null, false);

    $("sup").each((_, el) => {
      const $el = $(el);
      $el.replaceWith(this.toSuperscript($el.text()));
    });
    $("sub").each((_, el) => {
      const $el = $(el);
      $el.replaceWith(this.toSubscript($el.text()));
    });

    let text = $.text();
    text = text.replace(/\s+/g, " ").trim();
    return text;
  }

  private toSuperscript(s: string): string {
    const map: Record<string, string> = {
      "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
      "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
      "+": "⁺", "-": "⁻",
    };
    return s.replace(/./g, (c) => map[c] ?? c);
  }

  private toSubscript(s: string): string {
    const map: Record<string, string> = {
      "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
      "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
    };
    return s.replace(/./g, (c) => map[c] ?? c);
  }

  private substitutePlaceholders(text: string, formulaTextByPlaceholder: Map<string, string>): string {
    return text.replace(/__IMG_(\d+)__/g, (match) => {
      const value = formulaTextByPlaceholder.get(match);
      return value && value.trim() ? value.trim() : "";
    });
  }

  /** Loại bỏ dấu chấm bên trong nội dung (giữ lại 1 dấu chấm cuối) — cú pháp DSL cắt option tại dấu "." đầu tiên */
  private sanitizeForSingleLine(text: string): string {
    let cleaned = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    return cleaned;
  }

  private sanitizeOptionContent(text: string): string {
    let cleaned = this.sanitizeForSingleLine(text);
    // Xoá dấu chấm ở giữa (giữ nguyên nếu là dấu chấm cuối câu) để không bị cắt nhầm khi editor parse lại
    const endsWithDot = cleaned.endsWith(".");
    cleaned = cleaned.replace(/\./g, "");
    return cleaned + (endsWithDot ? "." : ".");
  }

  // ── Bước 6: Dựng câu hỏi Phần I (MC) ───────────────────────────────────────

  private buildPartIQuestions(
    blocks: RawQuestionBlock[],
    answerKey: AnswerKeyPartI,
    pngByPlaceholder: Map<string, string>,
    formulaTextByPlaceholder: Map<string, string>,
    warnings: string[]
  ): BuiltQuestionMC[] {
    const questions: BuiltQuestionMC[] = [];

    const partIBlocks = blocks.filter((b) => b.part === "I").sort((a, b) => a.questionNumber - b.questionNumber);

    for (const block of partIBlocks) {
      const fullHtml = block.htmlChunks.join(" ");

      // Tách nội dung câu hỏi (trước label A.) và phần đáp án (từ label A. trở đi)
      const stemHtmlMatch = fullHtml.split(/<strong>\s*A\.\s*<\/strong>/);
      if (stemHtmlMatch.length < 2) {
        warnings.push(`Câu ${block.questionNumber} (Phần I): không tìm thấy đáp án A, bỏ qua câu này.`);
        continue;
      }

      const stemHtml = stemHtmlMatch[0].replace(/<strong>\s*Câu\s+\d+\s*[:.]\s*<\/strong>/i, "");
      const restHtml = "A. " + stemHtmlMatch.slice(1).join("<strong>A. </strong>");

      // Tách 4 đáp án A/B/C/D dựa theo <strong>X. </strong>
      // Lưu ý: String.split với regex có capturing group luôn trả phần tử đầu tiên (index 0)
      // là đoạn TRƯỚC match đầu tiên -> chính là "A. <nội dung A>" (vì ta đã tự thêm tiền tố "A. " ở trên)
      const optionParts = restHtml.split(/<strong>\s*([A-D])\.\s*<\/strong>/);
      const optionsMap: Record<string, string> = {
        A: optionParts[0].replace(/^A\.\s*/, ""),
      };
      for (let i = 1; i < optionParts.length; i += 2) {
        const label = optionParts[i];
        const content = optionParts[i + 1] ?? "";
        if (["B", "C", "D"].includes(label)) {
          optionsMap[label] = content;
        }
      }

      if (!optionsMap.A || !optionsMap.B || !optionsMap.C || !optionsMap.D) {
        warnings.push(`Câu ${block.questionNumber} (Phần I): thiếu 1 trong 4 đáp án A/B/C/D, cần kiểm tra lại thủ công.`);
      }

      const content = this.sanitizeForSingleLine(
        this.substitutePlaceholders(this.htmlToPlainTextWithPlaceholders(stemHtml), formulaTextByPlaceholder)
      );

      const options = {
        A: this.sanitizeOptionContent(
          this.substitutePlaceholders(this.htmlToPlainTextWithPlaceholders(optionsMap.A || ""), formulaTextByPlaceholder)
        ),
        B: this.sanitizeOptionContent(
          this.substitutePlaceholders(this.htmlToPlainTextWithPlaceholders(optionsMap.B || ""), formulaTextByPlaceholder)
        ),
        C: this.sanitizeOptionContent(
          this.substitutePlaceholders(this.htmlToPlainTextWithPlaceholders(optionsMap.C || ""), formulaTextByPlaceholder)
        ),
        D: this.sanitizeOptionContent(
          this.substitutePlaceholders(this.htmlToPlainTextWithPlaceholders(optionsMap.D || ""), formulaTextByPlaceholder)
        ),
      };

      const correct = answerKey[block.questionNumber];
      if (!correct) {
        warnings.push(`Câu ${block.questionNumber} (Phần I): không tìm thấy đáp án đúng trong bảng ĐÁP ÁN, mặc định để A — cần kiểm tra lại.`);
      }

      questions.push({
        type: "MC",
        content: content || `(Câu ${block.questionNumber} — không đọc được nội dung, cần điền tay)`,
        options,
        correct: correct || "A",
      });
    }

    return questions;
  }

  // ── Bước 6b: Dựng câu hỏi Phần II (TF) ──────────────────────────────────────

  private buildPartIIQuestions(
    blocks: RawQuestionBlock[],
    answerKey: AnswerKeyPartII,
    pngByPlaceholder: Map<string, string>,
    formulaTextByPlaceholder: Map<string, string>,
    warnings: string[]
  ): BuiltQuestionTF[] {
    const questions: BuiltQuestionTF[] = [];

    const partIIBlocks = blocks.filter((b) => b.part === "II").sort((a, b) => a.questionNumber - b.questionNumber);

    for (const block of partIIBlocks) {
      const fullHtml = block.htmlChunks.join(" ");

      const labelRegex = /<strong>\s*([a-d])\)\s*<\/strong>/g;
      const matches = [...fullHtml.matchAll(labelRegex)];

      if (matches.length < 4) {
        warnings.push(`Câu ${block.questionNumber} (Phần II): không tìm đủ 4 ý a/b/c/d, cần kiểm tra lại thủ công.`);
        continue;
      }

      // Nội dung câu hỏi chính = phần trước ý "a)" đầu tiên, bỏ nhãn "Câu N:"
      const firstLabelIndex = matches[0].index ?? 0;
      const stemHtml = fullHtml.slice(0, firstLabelIndex).replace(/<strong>\s*Câu\s+\d+\s*[:.]\s*<\/strong>/i, "");

      const content = this.sanitizeForSingleLine(
        this.substitutePlaceholders(this.htmlToPlainTextWithPlaceholders(stemHtml), formulaTextByPlaceholder)
      );

      const labels: ("a" | "b" | "c" | "d")[] = ["a", "b", "c", "d"];
      const statements: BuiltQuestionTF["statements"] = [];

      for (let i = 0; i < 4; i++) {
        const label = labels[i];
        const startIdx = (matches[i].index ?? 0) + matches[i][0].length;
        const endIdx = i + 1 < matches.length ? matches[i + 1].index : fullHtml.length;
        const segmentHtml = fullHtml.slice(startIdx, endIdx);

        const text = this.sanitizeForSingleLine(
          this.substitutePlaceholders(this.htmlToPlainTextWithPlaceholders(segmentHtml), formulaTextByPlaceholder)
        ).replace(/\.$/, "");

        const isTrue = answerKey[block.questionNumber]?.[label] ?? false;

        statements.push({ label, text, isTrue });
      }

      if (!answerKey[block.questionNumber]) {
        warnings.push(`Câu ${block.questionNumber} (Phần II): không tìm thấy đáp án Đ/S trong bảng ĐÁP ÁN, mặc định tất cả là Sai — cần kiểm tra lại.`);
      }

      questions.push({
        type: "TF",
        content: content || `(Câu ${block.questionNumber} — không đọc được nội dung, cần điền tay)`,
        statements,
      });
    }

    return questions;
  }

  // ── Bước 7: Dựng câu hỏi Phần III (SA) — luôn qua AI (Hướng A) ─────────────

  private async buildPartIIIQuestions(
    blocks: RawQuestionBlock[],
    pngByPlaceholder: Map<string, string>,
    warnings: string[]
  ): Promise<BuiltQuestionSA[]> {
    const partIIIBlocks = blocks.filter((b) => b.part === "III").sort((a, b) => a.questionNumber - b.questionNumber);

    // Mỗi câu Phần III độc lập với nhau -> gọi AI song song thay vì tuần tự, giảm đáng kể thời gian chờ
    const results = await Promise.all(
      partIIIBlocks.map(async (block) => {
        const fullHtml = block.htmlChunks.join(" ").replace(/<strong>\s*Câu\s+\d+\s*[:.]\s*<\/strong>/i, "");

        const plainWithGaps = this.htmlToPlainTextWithPlaceholders(fullHtml).replace(/__IMG_\d+__/g, "[CT]");

        const placeholderRegex = /__IMG_(\d+)__/g;
        const placeholders = [...fullHtml.matchAll(placeholderRegex)].map((m) => m[0]);
        const images = placeholders.map((p) => pngByPlaceholder.get(p)).filter((v): v is string => !!v);

        try {
          const solved = await this.aiExamParseService.solveShortAnswerQuestion(
            block.questionNumber,
            plainWithGaps,
            images
          );

          if (!solved.answer) {
            warnings.push(`Câu ${block.questionNumber} (Phần III): AI không tự giải được, cần bạn tự điền đáp án.`);
          }

          const question: BuiltQuestionSA = {
            type: "SA",
            content: this.sanitizeForSingleLine(solved.content) || `(Câu ${block.questionNumber} — cần điền tay)`,
            answer: solved.answer || "",
          };
          return question;
        } catch (err) {
          warnings.push(`Câu ${block.questionNumber} (Phần III): lỗi khi gọi AI giải bài — ${err}. Cần điền tay.`);
          const question: BuiltQuestionSA = {
            type: "SA",
            content: this.sanitizeForSingleLine(plainWithGaps.replace(/\[CT\]/g, "(công thức)")),
            answer: "",
          };
          return question;
        }
      })
    );

    return results;
  }

  // ── Bước 8: Validator ───────────────────────────────────────────────────

  private validateQuestions(
    questionsI: BuiltQuestionMC[],
    questionsII: BuiltQuestionTF[],
    questionsIII: BuiltQuestionSA[],
    warnings: string[]
  ) {
    questionsI.forEach((q, idx) => {
      if (!q.options.A || !q.options.B || !q.options.C || !q.options.D) {
        warnings.push(`[Validator] Phần I - Câu ${idx + 1}: thiếu đáp án, cần kiểm tra lại trong editor.`);
      }
    });

    questionsII.forEach((q, idx) => {
      if (q.statements.length !== 4) {
        warnings.push(`[Validator] Phần II - Câu ${idx + 1}: không đủ 4 ý a/b/c/d.`);
      }
    });

    questionsIII.forEach((q, idx) => {
      if (!q.answer) {
        warnings.push(`[Validator] Phần III - Câu ${idx + 1}: chưa có đáp án, cần điền tay.`);
      }
    });
  }

}
