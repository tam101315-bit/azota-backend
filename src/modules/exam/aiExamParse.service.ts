import { Injectable, BadRequestException, InternalServerErrorException } from "@nestjs/common";

export interface AiParsedStatement {
  label: "a" | "b" | "c" | "d";
  text: string;
  isTrue: boolean;
}

export interface AiParsedQuestion {
  type: "MC" | "TF" | "SA";
  content: string;
  answers?: { A: string; B: string; C: string; D: string };
  correct?: "A" | "B" | "C" | "D";
  statements?: AiParsedStatement[];
  answer?: string;
}

const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "google/gemma-4-31b-it:free";
const OPENROUTER_FALLBACK_MODELS = ["google/gemma-4-26b-a4b-it:free", "nvidia/nemotron-3-ultra-550b-a55b:free"];

const PROMPT = `Bạn đang xem các trang của một đề thi tiếng Việt (dạng ảnh chụp từng trang, theo đúng thứ tự trang).

Hãy đọc và tách TOÀN BỘ câu hỏi trong các trang này thành một mảng JSON duy nhất, theo đúng schema sau. CHỈ trả về JSON hợp lệ, không có chữ giải thích nào khác, không có markdown code fence (không bọc trong \`\`\`):

{
  "questions": [
    {
      "type": "MC",
      "content": "nội dung câu hỏi",
      "answers": { "A": "...", "B": "...", "C": "...", "D": "..." },
      "correct": "A"
    },
    {
      "type": "TF",
      "content": "nội dung câu hỏi chính",
      "statements": [
        { "label": "a", "text": "...", "isTrue": true },
        { "label": "b", "text": "...", "isTrue": false },
        { "label": "c", "text": "...", "isTrue": true },
        { "label": "d", "text": "...", "isTrue": false }
      ]
    },
    {
      "type": "SA",
      "content": "nội dung câu hỏi",
      "answer": "đáp án đúng dạng text có ghi số, nếu không có thì để chuỗi rỗng \\"\\""
    }
  ]
}

Lưu ý quan trọng:
Quy tắc phân loại lo\u1ea1i câu hỏi (RẤT QUAN TRỌNG — đọc kỹ trước khi quyết định type):
- "MC" (Trắc nghiệm): CHỈ dùng khi câu hỏi có liệt kê rõ các phương án trả lời (ví dụ A/B/C/D hoặc 1/2/3/4).
- "TF" (Đúng/Sai): CHỈ dùng khi câu hỏi có đúng 4 mệnh đề để nhìn dạng a) b) c) d) mà người thi phải chọn đúng/sai từng ý.
- "SA" (Trả lời ngắn): dùng cho MỌI câu hỏi KHÔNG có phương án trả lời nào được liệt kê nào để lựa chọn, mà người thi phải tính toán, điền số, điền tự, viết công thức. Đây là trường hợp RẤT PHỔ BIẾN, đừng nhầm sang "MC". Tuyệt đối không tự bịa ra 4 phương án A/B/C/D nếu đề gốc không hề có, để tất cả từ chuyển sang "TF".
- Gi\u1eef đúng thứ tự câu hỏi xuất hiện trong tài liệu, gộp chung tất cả các trang thành 1 mảng "questions" duy nhất.
- Với câu Trắc nghiệm: đáp án đúng thường được đánh dấu bằng cách in đậm, hoặc in đỏ so với các đáp án còn lại – hãy nhìn kỹ và suy luận đáp án đúng dựa vào dấu hiệu này. Nếu không có dấu hiệu rõ ràng, để "correct": "A" làm mặc định.
- Với câu Đúng/Sai: nếu tài liệu không cho biết ý nào đúng/sai, để tất cả "isTrue": false — người dùng sẽ tự chỉnh lại.
- Bỏ qua watermark, logo, số trang, tên đơn vị phát hành tài liệu — chỉ lấy nội dung đề thi thật.`;

function stripJsonFence(text: string): string {
  return text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

async function callOpenRouter(content: any[]): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new InternalServerErrorException("OPENROUTER_API_KEY chưa được cấu hình trên server.");
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      models: [OPENROUTER_MODEL, ...OPENROUTER_FALLBACK_MODELS],
      messages: [{ role: "user", content }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new InternalServerErrorException(`OpenRouter API lỗi (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const rawText: string | undefined = data?.choices?.[0]?.message?.content;

  if (!rawText) {
    throw new InternalServerErrorException("OpenRouter không trả về nội dung hợp lệ.");
  }

  return rawText;
}

function toImageContentBlocks(images: string[]): any[] {
  return images.map((base64) => {
    const dataUrl = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
    return { type: "image_url", image_url: { url: dataUrl } };
  });
}

@Injectable()
export class AiExamParseService {
  async parseFromImages(images: string[]): Promise<{ questions: AiParsedQuestion[] }> {
    if (!images || images.length === 0) {
      throw new BadRequestException("Không có ảnh nào được gửi lên.");
    }

    const content: any[] = [{ type: "text", text: PROMPT }, ...toImageContentBlocks(images)];
    const rawText = await callOpenRouter(content);

    try {
      const parsed = JSON.parse(stripJsonFence(rawText));
      if (!Array.isArray(parsed?.questions)) {
        throw new Error("missing questions array");
      }
      return parsed;
    } catch (err) {
      throw new InternalServerErrorException(
        "Không đọc được JSON từ phản hồi của OpenRouter: " + rawText.slice(0, 300)
      );
    }
  }

  /**
   * Nhận một mảng ảnh nhỏ (mỗi ảnh là 1 công thức hoá học/toán được cắt ra từ ảnh WMF nhúng trong docx),
   * trả về mảng string tương ứng theo ĐÚNG THỨ TỰ đầu vào — mỗi string là công thức đọc được dưới dạng
   * text thường (có thể dùng ký hiệu unicode subscript/superscript nếu phù hợp, ví dụ "CuSO4", "H2SO4").
   * Dùng để OCR hàng loạt (1 lần gọi API duy nhất) thay vì gọi lẻ từng ảnh — tiết kiệm chi phí & nhanh hơn.
   */
  async recognizeFormulas(images: string[]): Promise<string[]> {
    if (!images || images.length === 0) return [];

    const prompt = `Dưới đây là ${images.length} ảnh nhỏ, mỗi ảnh chứa MỘT công thức hoá học hoặc ký hiệu toán học/khoa học ngắn (được cắt ra từ 1 bài thi Hoá/Lý/Toán tiếng Việt).

Hãy đọc CHÍNH XÁC từng ảnh theo đúng thứ tự (ảnh 1, ảnh 2, ...) và trả về DUY NHẤT một JSON object theo schema sau, không kèm giải thích, không markdown code fence:

{ "results": ["công thức ảnh 1 dạng text thường", "công thức ảnh 2 dạng text thường", ...] }

Yêu cầu bắt buộc:
- Mảng "results" PHẢI có đúng ${images.length} phần tử, đúng thứ tự với ${images.length} ảnh đã gửi.
- Viết công thức dạng text thường, gõ được bằng bàn phím thông thường (ví dụ: "CuSO4", "H2SO4", "Fe2+/Fe", "25oC", "10^-3"). Chỉ số dưới/trên viết liền theo sau, không dùng dấu ^ hay _ trừ khi thật cần thiết để tránh nhầm lẫn.
- Nếu ảnh là 1 số/kết quả tính toán đơn giản, chỉ cần ghi lại đúng số đó.
- Nếu không đọc được ảnh nào, ghi "" (chuỗi rỗng) cho phần tử đó, không được bỏ qua vị trí.`;

    const content: any[] = [{ type: "text", text: prompt }, ...toImageContentBlocks(images)];
    const rawText = await callOpenRouter(content);

    try {
      const parsed = JSON.parse(stripJsonFence(rawText));
      if (!Array.isArray(parsed?.results)) {
        throw new Error("missing results array");
      }
      // Đảm bảo đúng số lượng, tránh lệch vị trí nếu AI trả thiếu/thừa
      const results: string[] = [];
      for (let i = 0; i < images.length; i++) {
        results.push(typeof parsed.results[i] === "string" ? parsed.results[i] : "");
      }
      return results;
    } catch (err) {
      console.log("recognizeFormulas: không parse được JSON, trả về mảng rỗng:", rawText.slice(0, 300));
      return images.map(() => "");
    }
  }

  /**
   * Giải 1 câu "Trả lời ngắn" (Phần III) dựa trên nội dung text đã trích (có chỗ trống do công thức bị mất)
   * kèm TOÀN BỘ ảnh công thức/phép tính thuộc câu đó (theo đúng thứ tự xuất hiện).
   * AI cần đọc các ảnh để lấp đầy chỗ trống, suy luận và đưa ra đáp án cuối cùng.
   */
  async solveShortAnswerQuestion(
    questionNumber: number,
    textWithGaps: string,
    images: string[]
  ): Promise<{ content: string; answer: string }> {
    const prompt = `Đây là Câu ${questionNumber} thuộc phần "Trả lời ngắn" của một đề thi Hoá/Lý/Toán tiếng Việt.

Nội dung câu hỏi (dạng text, một số công thức/số liệu bị mất khi trích xuất, được đánh dấu bằng "[CT]"):
"""
${textWithGaps}
"""

Kèm theo là ${images.length} ảnh, theo đúng thứ tự xuất hiện trong đề, tương ứng với các vị trí "[CT]" ở trên (ảnh 1 ứng với "[CT]" đầu tiên, ảnh 2 ứng với "[CT]" thứ hai, v.v — nếu số ảnh nhiều/ít hơn số "[CT]" thì tự căn chỉnh hợp lý).

Hãy:
1. Đọc các ảnh để hiểu đầy đủ nội dung câu hỏi và cách giải.
2. Viết lại nội dung câu hỏi đầy đủ, dễ đọc, đã thay các công thức vào đúng chỗ (không cần giữ "[CT]").
3. Tự giải và đưa ra đáp án số cuối cùng.

Trả về DUY NHẤT JSON, không giải thích thêm, không markdown code fence:
{ "content": "nội dung câu hỏi đầy đủ đã điền công thức", "answer": "đáp án số cuối cùng, chỉ ghi giá trị, ví dụ: 12.5" }`;

    const content: any[] = [{ type: "text", text: prompt }, ...toImageContentBlocks(images)];

    try {
      const rawText = await callOpenRouter(content);
      const parsed = JSON.parse(stripJsonFence(rawText));
      return {
        content: typeof parsed?.content === "string" ? parsed.content : textWithGaps,
        answer: typeof parsed?.answer === "string" ? parsed.answer : "",
      };
    } catch (err) {
      console.log(`solveShortAnswerQuestion: lỗi ở câu ${questionNumber}:`, err);
      // Không throw — để pipeline vẫn tiếp tục xử lý các câu khác, chỉ để trống đáp án câu này
      return { content: textWithGaps.replace(/\[CT\]/g, "(công thức)"), answer: "" };
    }
  }
}
